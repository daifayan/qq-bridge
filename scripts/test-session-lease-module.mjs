// src/session-lease.js 的离线回归：不读真实 config、不连 DSH、不发消息。
// 盯四件事：注入缺项、共享容器语义（本模块的 Map 就是 bridge 那个）、
// 租约的挂/摘/清理，以及上下文压缩的每一道门控。
import { createSessionLease } from '../src/session-lease.js';

let failed = 0;
const must = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
};

const fired = { wake: [], promptQueue: [], retired: [], saved: 0, activity: [] };
const logs = [];

function makeCtx(over = {}) {
  return {
    cfg: { socialV2: { wake: {}, context: {} } },
    log: (...a) => logs.push(a.join(' ')),
    state: { sessions: {} },
    appendActivity: (t) => fired.activity.push(t),
    reverse: new Map(),
    promptQueues: new Map(),
    collectors: new Map(),
    v2TurnStartAt: new Map(),
    sendToolSucceededSessions: new Set(),
    pendingSendToolCalls: new Map(),
    pendingWakeKeys: new Set(),
    pendingWakeLeaseTimers: new Map(),
    pendingWakeArmedAt: new Map(),
    getSocialV2State: () => ({}),
    saveSocialV2State: () => { fired.saved += 1; },
    scheduleWakeV2: (k, r) => fired.wake.push([k, r]),
    processPromptQueue: async (k) => fired.promptQueue.push(k),
    buildRecapV2: () => '前情提要：他在测桥接。',
    retireSession: (k) => fired.retired.push(k),
    isSessionAllowedInCurrentMode: () => true,
    isConversationBusyV2: () => false,
    getCurrentMode: () => 'reserved2',
    getSocialV2: () => ({ paused: false }),
    ...over,
  };
}

console.log('\n[1] 依赖注入缺项 → 立刻抛（fail-closed）');
for (const k of ['cfg', 'log', 'state', 'appendActivity', 'reverse', 'promptQueues', 'collectors',
  'v2TurnStartAt', 'sendToolSucceededSessions', 'pendingSendToolCalls', 'pendingWakeKeys',
  'pendingWakeLeaseTimers', 'pendingWakeArmedAt', 'getSocialV2State', 'saveSocialV2State',
  'scheduleWakeV2', 'processPromptQueue', 'buildRecapV2', 'retireSession',
  'isSessionAllowedInCurrentMode', 'isConversationBusyV2', 'getCurrentMode', 'getSocialV2']) {
  let threw = '';
  try { createSessionLease({ ...makeCtx(), [k]: undefined }); } catch (e) { threw = e.message; }
  must(`缺 ${k} 时抛错`, /ctx 缺少/.test(threw), threw);
}

console.log('\n[2] 暴露面');
const s0 = createSessionLease(makeCtx());
for (const k of ['armPendingWakeLease', 'disarmPendingWakeLease', 'clearAllPendingWakeLeases',
  'armTurnLease', 'disarmTurnLease', 'releaseConversationBusy',
  'maybeScheduleCompactV2', 'compactContextV2', 'getTurnLeaseDeadline', 'stop']) {
  must(`${k} 已导出`, typeof s0[k] === 'function');
}
must('turnLeaseDeadline 不对外裸露（getter 返回 Map）', s0.getTurnLeaseDeadline() instanceof Map);
s0.stop();

console.log('\n[3] 共享容器语义：模块操作的必须就是 bridge 那个实例');
{
  const ctx = makeCtx();
  const s = createSessionLease(ctx);
  s.armTurnLease('private:1');
  must('armTurnLease 写进模块自持的死线表', s.getTurnLeaseDeadline().has('private:1'));
  must('租约死线在未来', s.getTurnLeaseDeadline().get('private:1') > Date.now());

  s.armPendingWakeLease('private:1');
  // 关键：写进去的必须是**外部传进来的那张表**，不是模块自己 new 的
  must('定时器落在外部的 pendingWakeLeaseTimers 里', ctx.pendingWakeLeaseTimers.has('private:1'));
  must('pendingWakeArmedAt 记了时间', typeof ctx.pendingWakeArmedAt.get('private:1') === 'number');

  s.disarmPendingWakeLease('private:1');
  must('disarm 后定时器与时间戳都清掉',
    !ctx.pendingWakeLeaseTimers.has('private:1') && !ctx.pendingWakeArmedAt.has('private:1'));

  s.disarmTurnLease('private:1');
  must('disarmTurnLease 删掉死线', !s.getTurnLeaseDeadline().has('private:1'));

  // 切角色时 clearRoleTimers 会调这个，必须清干净外部那张表
  s.armPendingWakeLease('a');
  s.armPendingWakeLease('b');
  s.clearAllPendingWakeLeases();
  must('clearAllPendingWakeLeases 清空外部定时器表', ctx.pendingWakeLeaseTimers.size === 0,
    String(ctx.pendingWakeLeaseTimers.size));
  s.stop();
}

console.log('\n[4] releaseConversationBusy：清干净并补投唤醒');
{
  const ctx = makeCtx();
  ctx.state.sessions['private:1'] = 'sid-1';
  ctx.pendingWakeKeys.add('private:1');
  ctx.pendingWakeArmedAt.set('private:1', Date.now());
  ctx.promptQueues.set('private:1', { running: true, queue: [] });
  ctx.v2TurnStartAt.set('sid-1', Date.now());
  ctx.collectors.set('sid-1', () => {});
  ctx.sendToolSucceededSessions.add('sid-1');
  ctx.pendingSendToolCalls.set('sid-1', []);
  const st = { pendingWakeReasons: [{ reason: 'private', seq: 7 }] };
  ctx.getSocialV2State = () => st;
  const s = createSessionLease(ctx);
  s.armTurnLease('private:1');
  s.armPendingWakeLease('private:1');

  fired.wake = [];
  const cleared = s.releaseConversationBusy('private:1', '单测');
  must('返回了被清理项', Array.isArray(cleared) && cleared.length >= 5, cleared.join('、'));
  must('pendingWakeKeys 已清', !ctx.pendingWakeKeys.has('private:1'));
  must('回合标记与收集器已清',
    !ctx.v2TurnStartAt.has('sid-1') && !ctx.collectors.has('sid-1'));
  must('投递队列 running 已复位', ctx.promptQueues.get('private:1').running === false);
  must('租约死线已清', !s.getTurnLeaseDeadline().has('private:1'));
  must('日志里说明了原因', logs.some((l) => l.includes('单测')), logs.at(-1)?.slice(0, 50));
  must('暂存唤醒被取走一条', st.pendingWakeReasons.length === 0);
  // 补投走 setTimeout(0)，等一拍
  await new Promise((r) => setTimeout(r, 20));
  must('补投了唤醒', fired.wake.length === 1 && fired.wake[0][1] === 'private', JSON.stringify(fired.wake));
  s.stop();
}
{
  // 队列里还有排队 prompt：解除后要接着投，别让它们一起饿死
  const ctx = makeCtx();
  ctx.promptQueues.set('group:9', { running: true, queue: [{ promptText: 'a' }] });
  const s = createSessionLease(ctx);
  fired.promptQueue = [];
  s.releaseConversationBusy('group:9', '单测');
  await new Promise((r) => setTimeout(r, 20));
  must('有排队 prompt 时继续投递', fired.promptQueue.includes('group:9'), JSON.stringify(fired.promptQueue));
  s.stop();
}

console.log('\n[5] maybeScheduleCompactV2：九道门控');
function compactCtx(stOver = {}, cfgOver = {}, ctxOver = {}) {
  const st = {
    contextChars: 100000, contextMsgCount: 30, compactTimes: [],
    compactPendingAt: 0, compactLastAt: 0, ...stOver,
  };
  return makeCtx({
    cfg: { socialV2: { wake: {}, context: cfgOver } },
    getSocialV2State: () => st,
    ...ctxOver,
  });
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({}, { compactEnabled: false }));
  s.maybeScheduleCompactV2('private:1');
  must('compactEnabled=false 时不安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({}, {}, { getCurrentMode: () => 'chat' }));
  s.maybeScheduleCompactV2('private:1');
  must('非 reserved2 模式不安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({}, {}, { getSocialV2: () => ({ paused: true }) }));
  s.maybeScheduleCompactV2('private:1');
  must('暂停时不安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({}, {}, { isSessionAllowedInCurrentMode: () => false }));
  s.maybeScheduleCompactV2('private:1');
  must('会话不在当前模式允许范围时不安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({ compactPendingAt: 123 }));
  s.maybeScheduleCompactV2('private:1');
  must('已在交接流程中不重复安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({ contextChars: 100 }));
  s.maybeScheduleCompactV2('private:1');
  must('字数没到阈值不安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({ contextMsgCount: 1 }));
  s.maybeScheduleCompactV2('private:1');
  must('条数没到下限不安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({ compactLastAt: Date.now() - 1000 }, { compactCooldownMs: 600000 }));
  s.maybeScheduleCompactV2('private:1');
  must('冷却期内不安排', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  const now = Date.now();
  const s = createSessionLease(compactCtx({ compactTimes: [now, now, now] }, { compactMaxPerDay: 3 }));
  s.maybeScheduleCompactV2('private:1');
  must('日配额用尽不安排', fired.wake.length === 0);
  must('超配额有日志', logs.some((l) => l.includes('今日已压缩')), logs.at(-1)?.slice(0, 40));
  s.stop();
}
{
  fired.wake = [];
  const s = createSessionLease(compactCtx({}, {}, { isConversationBusyV2: () => true }));
  s.maybeScheduleCompactV2('private:1');
  must('忙的时候不插队', fired.wake.length === 0);
  s.stop();
}
{
  fired.wake = [];
  fired.saved = 0;
  const st = { contextChars: 100000, contextMsgCount: 30, compactTimes: [], compactPendingAt: 0, compactLastAt: 0 };
  const s = createSessionLease(makeCtx({
    cfg: { socialV2: { wake: {}, context: {} } },
    getSocialV2State: () => st,
  }));
  s.maybeScheduleCompactV2('private:1');
  must('全部满足时安排交接', fired.wake.length === 1 && fired.wake[0][1] === 'compactHandoff', JSON.stringify(fired.wake));
  must('写下 compactPendingAt', st.compactPendingAt > 0);
  must('落盘一次', fired.saved === 1);
  s.stop();
}

console.log('\n[6] compactContextV2：保险丝与正常压缩');
{
  const s = createSessionLease(compactCtx({ compactPendingAt: 0 }));
  fired.retired = [];
  s.compactContextV2('private:1');
  must('没有待压缩标记时直接返回', fired.retired.length === 0);
  s.stop();
}
{
  // 交接回合里 AI 一条记忆都没写 → 必须取消，别白丢上下文
  const st = { compactPendingAt: 1000, memoryWriteAt: 500, contextChars: 90000 };
  fired.saved = 0;
  const s = createSessionLease(makeCtx({ getSocialV2State: () => st }));
  s.compactContextV2('private:1');
  must('没写记忆时取消压缩', st.compactPendingAt === 0);
  must('取消时也落盘', fired.saved === 1);
  must('没有退役会话', fired.retired.length === 0);
  must('日志说明了原因', logs.some((l) => l.includes('没有写入任何记忆')), logs.at(-1)?.slice(0, 45));
  s.stop();
}
{
  const st = {
    compactPendingAt: 1000, memoryWriteAt: 2000, contextChars: 90000, contextMsgCount: 40,
    compactCount: 2, compactTimes: [],
  };
  fired.retired = []; fired.activity = []; fired.saved = 0;
  const s = createSessionLease(makeCtx({ getSocialV2State: () => st }));
  s.compactContextV2('private:1');
  must('写入前情提要', st.contextRecap === '前情提要：他在测桥接。');
  must('字数与条数归零', st.contextChars === 0 && st.contextMsgCount === 0);
  must('pending 清空、计数+1', st.compactPendingAt === 0 && st.compactCount === 3);
  must('压过的时间戳追加进 compactTimes', st.compactTimes.length === 1);
  must('退役了旧会话', fired.retired.includes('private:1'), JSON.stringify(fired.retired));
  must('写了活动记录', fired.activity.length === 1, fired.activity[0]);
  must('落盘一次', fired.saved === 1);
  s.stop();
}
{
  // 24 小时前的压缩记录要被剔掉（否则日配额永远用不完）
  const st = {
    compactPendingAt: 1000, memoryWriteAt: 2000, contextChars: 5000, contextMsgCount: 5,
    compactCount: 0, compactTimes: [Date.now() - 25 * 3600 * 1000],
  };
  const s = createSessionLease(makeCtx({ getSocialV2State: () => st }));
  s.compactContextV2('private:1');
  must('只保留 24 小时内的记录', st.compactTimes.length === 1 && st.compactTimes[0] > Date.now() - 60000);
  s.stop();
}

console.log('\n[7] turnLeaseMs 可配');
{
  const s1 = createSessionLease(makeCtx({ cfg: { socialV2: { wake: { turnLeaseMs: 60000 }, context: {} } } }));
  s1.armTurnLease('k');
  const d1 = s1.getTurnLeaseDeadline().get('k') - Date.now();
  must('自定义租约生效（约 60s）', d1 > 50000 && d1 <= 60000, String(d1));
  s1.stop();
  const s2 = createSessionLease(makeCtx());
  s2.armTurnLease('k');
  const d2 = s2.getTurnLeaseDeadline().get('k') - Date.now();
  must('默认租约 12 分钟', d2 > 11 * 60000 && d2 <= 12 * 60000, String(d2));
  s2.stop();
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
