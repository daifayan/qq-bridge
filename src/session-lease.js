// 会话生命周期自愈：忙锁租约 + 上下文压缩交接。
// 2026-11-01 从 bridge.js 的 main 里搬出来（约 215 行）。
//
// 两件事放一个文件，是因为它们共用同一套「会话忙/租约」状态机：
//   1. 租约 —— 防止某一轮 DSH turn 在 turn/end 之前消失，导致会话"永久变聋"；
//   2. 压缩 —— 上下文超阈值时把会话交接掉（写记忆 → 压缩 → 退役旧会话）。
// 两者判断"忙不忙"用的是同一组标记，拆开只会让这套状态机分散在两个文件里。
//
// ⚠️ 这里的 Map/Set 全部是**外部传进来的实例**，不是本模块私有的：
// pendingWakeKeys / promptQueues / collectors / v2TurnStartAt 等在 bridge 别处
// 被大量读写（合计上百处）。它们从不整体重新赋值，所以共享实例是安全的 ——
// 千万别在这个模块里写 `pendingWakeKeys = new Set()`，那会让 bridge 那边看到旧对象。
// 本模块自己持有的只有 turnLeaseDeadline。
import { pruneLoopState } from './loop-guard.js';

const CTX_KEYS = [
  'cfg', 'log', 'state', 'appendActivity',
  // 与 bridge 共享的可变容器（实例传入，见文件头说明）
  'reverse', 'promptQueues', 'collectors', 'v2TurnStartAt',
  'sendToolSucceededSessions', 'pendingSendToolCalls',
  'pendingWakeKeys', 'pendingWakeLeaseTimers', 'pendingWakeArmedAt',
  // 函数声明在 main 里会提升，可以直接传值
  'getSocialV2State', 'saveSocialV2State', 'scheduleWakeV2', 'processPromptQueue',
  'buildRecapV2', 'retireSession', 'isSessionAllowedInCurrentMode', 'isConversationBusyV2',
  // 这两个定义晚于本模块初始化（TDZ），必须惰性取
  'getCurrentMode', 'getSocialV2',
];

export function createSessionLease(ctx) {
  for (const k of CTX_KEYS) {
    if (ctx?.[k] === undefined) throw new Error(`createSessionLease: ctx 缺少 ${k}`);
  }
  const {
    cfg, log, state, appendActivity,
    reverse, promptQueues, collectors, v2TurnStartAt,
    sendToolSucceededSessions, pendingSendToolCalls,
    pendingWakeKeys, pendingWakeLeaseTimers, pendingWakeArmedAt,
    getSocialV2State, saveSocialV2State, scheduleWakeV2, processPromptQueue,
    buildRecapV2, retireSession, isSessionAllowedInCurrentMode, isConversationBusyV2,
    getCurrentMode, getSocialV2,
  } = ctx;

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 强制解除 busy 标记，避免该会话永久无法被唤醒。
  // 从 30 分钟收紧到 6 分钟：正常的长回合由"投递队列 running"与"回合标记"继续兜着，
  // 所以这里到期只解除"待收尾唤醒"这一个理由，不会造成并发投递；但能让故障恢复快得多。
  const PENDING_WAKE_LEASE_MS = 6 * 60_000;
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
      pendingWakeArmedAt.delete(key);
    }, PENDING_WAKE_LEASE_MS);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
    pendingWakeArmedAt.set(key, Date.now());
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
    pendingWakeArmedAt.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // ── 回合租约：防"永久变聋"（2026-09-26 17:0x 真实事故）──────────────────────
  // 只要有一轮 DSH turn 在 turn/end 之前消失（429 余额不足、网络抖动、DSH 重启、
  // deliverPromptNow 永不 settle），`v2TurnStartAt` / `collectors` / `promptQueues.running`
  // 里就会永远挂着标记 → isConversationBusyV2 永远为真 → 该会话此后**每条新消息
  // 都只入库、不唤醒**，表现就是机器人彻底不回话。
  // 这里给每个 key 记一条"最晚必须收尾"的死线，超时即判定为幽灵状态并就地清理。
  // 死线取 12 分钟：正常回合最长是 qq_wait_for_messages 的 10 分钟（wait.maxMs=600000）
  // 加上 quiet 窗口与收尾，12 分钟足够宽裕，不会误杀正常的长轮询。
  const turnLeaseDeadline = new Map(); // key -> 最晚必须收尾的时间戳
  const turnLeaseMs = () => {
    const n = Number(cfg.socialV2?.wake?.turnLeaseMs);
    return Number.isFinite(n) && n > 0 ? n : 12 * 60_000;
  };
  function armTurnLease(key) {
    if (key) turnLeaseDeadline.set(key, Date.now() + turnLeaseMs());
  }
  function disarmTurnLease(key) {
    if (key) turnLeaseDeadline.delete(key);
  }

  /**
   * 就地解除某个 key 的全部忙标记；返回被清理项的名称列表。
   * 只动"忙"相关的内存态，不碰会话映射、不碰聊天记录，因此可安全自愈。
   */
  function releaseConversationBusy(key, why) {
    const cleared = [];
    let st = null;
    try { st = getSocialV2State(key); } catch { st = null; }
    if (st?.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
      cleared.push('待发唤醒定时器');
    }
    if (pendingWakeKeys.has(key)) { pendingWakeKeys.delete(key); cleared.push('待收尾唤醒'); }
    if (pendingWakeArmedAt.has(key)) pendingWakeArmedAt.delete(key);
    if (pendingWakeLeaseTimers.has(key)) {
      const t = pendingWakeLeaseTimers.get(key);
      if (t) clearTimeout(t);
      pendingWakeLeaseTimers.delete(key);
      cleared.push('唤醒租约');
    }
    const q = promptQueues.get(key);
    if (q?.running) { q.running = false; cleared.push('投递队列 running'); }
    const sid = state.sessions[key];
    if (sid) {
      if (v2TurnStartAt.has(sid)) { v2TurnStartAt.delete(sid); cleared.push('回合开始标记'); }
      if (collectors.has(sid)) { collectors.delete(sid); cleared.push('回合收集器'); }
      sendToolSucceededSessions.delete(sid);
      pendingSendToolCalls.delete(sid);
    }
    turnLeaseDeadline.delete(key);
    if (cleared.length) {
      log(`[reserved2] ⚠️ 检测到卡死的回合状态，已就地解除 ${key}（${why}）：${cleared.join('、')}`);
    }
    // 队列里还有排队的 prompt：解除后立刻继续投递，别让它们跟着一起饿死。
    if (q && q.queue.length && !q.running) {
      setTimeout(() => { void processPromptQueue(key).catch(() => {}); }, 0);
    }
    // 2026-09-30 修复：解除忙状态**不等于**会补唤醒。
    // 旧写法只重投 promptQueues，完全不管 pendingWakeReasons，于是会出现
    // “不忙、也没待唤醒”的干等状态：消息都躺在 unread 里，却没有任何东西去叫醒它
    // （2026-09-30 21:22 实测：unstick 解除了忙状态，但那两条暂存唤醒没人消费，机器人继续沉默）。
    // 这里把暂存的唤醒原因取一条出来补一次计划唤醒；剩下的会在后续回合结束时继续消费。
    if (st && Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length) {
      const item = st.pendingWakeReasons.shift();
      log(`[reserved2] 忙状态已解除，补投暂存的唤醒 ${key}（${item?.reason ?? 'private'}@seq${item?.seq ?? '?'}）`);
      setTimeout(() => {
        try {
          scheduleWakeV2(key, item?.reason ?? 'private');
        } catch (error) {
          log(`[reserved2] 补投唤醒失败 ${key}:`, error?.message ?? error);
        }
      }, 0);
    }
    return cleared;
  }

  // 兜底巡检：即使没人再发新消息，也要把幽灵状态清掉，否则会话会一直"聋"下去。
  const turnLeaseSweeper = setInterval(() => {
    const now = Date.now();
    try { pruneLoopState(); } catch { /* 刷屏窗口清理失败不影响主巡检 */ }
    for (const [key, deadline] of [...turnLeaseDeadline]) {
      if (now > deadline) releaseConversationBusy(key, `回合超过租约 ${Math.round(turnLeaseMs() / 60000)} 分钟未收尾`);
    }
    // 孤儿唤醒标记：pendingWakeKeys 还挂着，但它对应的回合与投递队列都已不存在。
    // 实测成因：唤醒投递的同一瞬间事件流重连，turn/end 事件丢失（2026-09-26 17:17 复现）。
    // 这种状态会让该会话此后"只入库、不唤醒"，所以一旦确认孤儿就立刻解除。
    // 60 秒宽限：arm 之后到 turn/start 之间本来就有极短的窗口，别误杀。
    for (const key of [...pendingWakeKeys]) {
      const armedAt = pendingWakeArmedAt.get(key) ?? 0;
      if (!armedAt || now - armedAt < 60_000) continue;
      const q = promptQueues.get(key);
      const sid = state.sessions[key];
      const turnAlive = (q && (q.running || q.queue.length > 0)) || (sid && (v2TurnStartAt.has(sid) || collectors.has(sid)));
      if (!turnAlive) releaseConversationBusy(key, '唤醒标记还在、回合已消失（turn/end 丢失）');
    }
    // 2026-09-30 新增：僵尸收集器。
    // 正常回合在 turn/start 时会**同时**写入 v2TurnStartAt 和租约，所以
    // “有收集器、却既没有回合开始标记、也没有租约”只可能是残留（暂停/DSH 重启打断的回合）。
    // ⚠️ 上面的孤儿检测抓不到它：那里把 `collectors.has(sid)` 当成“回合还活着”的证据，
    //    僵尸收集器正好能自我证明，于是永远不自愈（2026-09-30 21:18 实测踩到）。
    for (const [sid] of [...collectors]) {
      if (v2TurnStartAt.has(sid)) continue;
      const key = reverse.get(sid);
      // ⚠️⚠️ 非 QQ 会话（PC 指令的干活会话 / 黑话学习 / 空间评论）**不在 reverse 里**，
      // 也**永远不会有** v2TurnStartAt 或回合租约 —— 它们靠各自的 turn 收集器收尾。
      // 以前这里对这类会话无条件 `collectors.delete(sid)`：于是任何比下一次巡检（最长 60 秒）
      // 跑得久的任务都会被删掉收集器 → 随后的 turn/end 落在空收集器上 → **活干完了、报告永远不回**。
      // 2026-10-01 实测两次踩到（14:47 的智谱指令 103 秒、15:21 的查 bug 指令 16 秒都丢了报告）。
      // 所以这里必须先按"是不是 QQ 会话"分流，非 QQ 会话直接跳过。
      if (!key) continue;
      if (turnLeaseDeadline.has(key)) continue;
      releaseConversationBusy(key, '回合收集器没有回合开始标记、也没有租约（回合作废）');
    }
  }, 60_000);
  turnLeaseSweeper.unref?.();

  // ── 上下文压缩交接 ────────────────────────────────────────────────────
  // 触发：累计字数 + 条数过阈值，且冷却/日配额允许，且会话当前不忙。
  function maybeScheduleCompactV2(key) {
    const cc = cfg.socialV2?.context ?? {};
    if (cc.compactEnabled === false) return;
    if (getCurrentMode() !== 'reserved2' || getSocialV2().paused) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.compactPendingAt) return; // 已经在交接流程里
    const threshold = Math.max(5000, Number(cc.compactThresholdChars) || 80000);
    if ((Number(st.contextChars) || 0) < threshold) return;
    const minTurns = Math.max(0, Number(cc.compactMinTurns) || 20);
    if ((Number(st.contextMsgCount) || 0) < minTurns) return;
    const cooldown = Math.max(0, Number(cc.compactCooldownMs) || 1800000);
    if (st.compactLastAt && Date.now() - Number(st.compactLastAt) < cooldown) return;
    const maxPerDay = Math.max(1, Number(cc.compactMaxPerDay) || 8);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    st.compactTimes = (Array.isArray(st.compactTimes) ? st.compactTimes : []).filter((t) => Number(t) > dayAgo);
    if (st.compactTimes.length >= maxPerDay) {
      log(`[reserved2] ${key} 今日已压缩 ${st.compactTimes.length} 次（上限 ${maxPerDay}），跳过`);
      return;
    }
    if (isConversationBusyV2(key, st)) return; // 忙的时候别插队，下个回合再说
    st.compactPendingAt = Date.now();
    saveSocialV2State();
    log(`[reserved2] ${key} 上下文累计约 ${st.contextChars} 字（${st.contextMsgCount} 条），安排交接`);
    scheduleWakeV2(key, 'compactHandoff');
  }

  function compactContextV2(key) {
    const st = getSocialV2State(key);
    if (!st || !st.compactPendingAt) return;
    // 保险丝：交接回合里 AI 一条记忆都没写，说明交接失败（它可能直接跳过了），
    // 那就取消这次压缩 —— 否则会白白丢掉上下文，前情提要还只剩几句垃圾原话。
    const pendingAt = Number(st.compactPendingAt) || 0;
    if ((Number(st.memoryWriteAt) || 0) <= pendingAt) {
      st.compactPendingAt = 0;
      saveSocialV2State();
      log(`[reserved2] ${key} 交接回合没有写入任何记忆，取消本次上下文压缩（下个周期再试）`);
      return;
    }
    const recap = buildRecapV2(st);
    const before = Number(st.contextChars) || 0;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    st.contextRecap = recap;
    st.contextChars = 0;
    st.contextMsgCount = 0;
    st.compactPendingAt = 0;
    st.compactLastAt = Date.now();
    st.compactCount = (Number(st.compactCount) || 0) + 1;
    st.compactTimes = [...(Array.isArray(st.compactTimes) ? st.compactTimes : []).filter((t) => Number(t) > dayAgo), Date.now()];
    saveSocialV2State();
    retireSession(key);
    try { appendActivity(`${key} [reserved2] 上下文已压缩：第 ${st.compactCount} 次（原约 ${before} 字）`); } catch {}
    log(`[reserved2] ${key} 上下文已压缩：第 ${st.compactCount} 次，原约 ${before} 字，前情提要 ${recap.length} 字；旧 DSH 会话已归档`);
  }

  return {
    armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases,
    armTurnLease, disarmTurnLease, releaseConversationBusy,
    maybeScheduleCompactV2, compactContextV2,
    // 外部要读租约死线（诊断/忙状态判断居多），给 getter 而不是裸露内部 Map
    getTurnLeaseDeadline: () => turnLeaseDeadline,
    // 测试/重启用：停掉巡检定时器
    stop: () => clearInterval(turnLeaseSweeper),
  };
}
