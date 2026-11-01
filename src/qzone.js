// QQ 空间（说说 / 好友动态 / 评论 / 自动化）—— 2026-11-01 从 bridge.js 抽出。
//
// 对外只暴露一小组符号：控制台路由、handleIncoming、以及事件流的一帧处理。
// 桥接通过依赖注入把 cfg / log / api / 发送通道等传进来（见下面 ctx 断言），
// 会话/等待者/收集器这些内部状态不外泄，这样模块自己能被单独驱动和测试。
import fs from 'node:fs';
import { createTurnCollector } from './dsh-client.js';
import path from 'node:path';

const CTX_KEYS = [
  'cfg', 'log', 'api', 'STATE_DIR', 'ROOT',
  'currentRoleHint', 'ensureChatModel', 'sendToQQ', 'sleep',
  'readJsonSafe', 'atomicWriteJson', 'recordRecentAction', 'recentActions',
  'getStickerEntries', 'callSnowLuma',
];

/** ctx 里少一样就立刻炸掉，不要等到运行时报 undefined（fail-closed）。 */
export function createQzone(ctx) {
  for (const k of CTX_KEYS) {
    if (ctx?.[k] === undefined) throw new Error(`createQzone: ctx 缺少 ${k}`);
  }
  const {
    cfg, log, api, STATE_DIR, ROOT,
    currentRoleHint, ensureChatModel, sendToQQ, sleep,
    readJsonSafe, atomicWriteJson, recordRecentAction, recentActions,
    getStickerEntries, callSnowLuma,
  } = ctx;

  // ── QQ 空间：走 SnowLuma 内置的 QzoneApi（OneBot action）────────────────────
  // 和 PC 指令同一条通道：只认 owner + 只认私聊 + 只认「指令 空间 …」前缀。
  // v1 只做「读自己的说说 / 读好友动态 / 发自己的说说 / 删自己的说说」。
  // 故意不做自动点赞、自动评论别人的动态：那是对别人可见的写操作，风控后果
  // 该由人决定，不该由脚本决定（要开也得单独明确开一句）。
  const QZONE_LOG = path.join(STATE_DIR, 'qzone.jsonl');
  const qzoneState = { lastFeedsAt: 0, lastFeeds: null, lastMsgList: null, pendingComment: null };

  function auditQzone(entry) {
    try { fs.appendFileSync(QZONE_LOG, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'); }
    catch (error) { log('写空间审计失败: ' + (error?.message ?? error)); }
    // 顺手记进"我最近自己做过的事"（聊天大脑据此知道自己动过空间）
    const who = String(entry?.from ?? entry?.targetUin ?? '');
    if (entry?.kind === 'publish') recordRecentAction('qzone', `在空间发了一条说说：「${String(entry.content ?? '').slice(0, 30)}」`);
    else if (entry?.kind === 'like') recordRecentAction('qzone', `给 ${who || '某人'} 的空间动态点了赞`);
    else if (entry?.kind === 'unlike') recordRecentAction('qzone', `取消了对 ${who || '某人'} 的空间点赞`);
    else if (entry?.kind === 'comment') recordRecentAction('qzone', `评论了 ${who || '某人'} 的空间动态：「${String(entry.content ?? '').slice(0, 40)}」`);
    else if (entry?.kind === 'delete') recordRecentAction('qzone', `删掉了自己空间的一条说说`);
  }

  function fmtQzoneTime(sec) {
    const ms = Number(sec) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return '时间未知';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function stripHtmlTags(html) {
    return String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 机器人自己的 QQ（好友动态里会混着自己发的动态，2026-11-01 实测 7 条里 4 条是自己）。
  // 惰性获取并缓存；拿不到就返回 ''，调用方按"不是自己"降级，不阻断主流程。
  let qzoneSelfUin = '';
  async function getQzoneSelfUin() {
    if (qzoneSelfUin) return qzoneSelfUin;
    try {
      const info = await callSnowLuma('get_login_info');
      const uin = String(info?.user_id ?? '');
      if (uin) qzoneSelfUin = uin;
    } catch (error) {
      log('空间：获取自身 QQ 失败（按非自己处理）' + (error?.message ?? error));
    }
    return qzoneSelfUin;
  }

  // 长说说的 f-info 只放摘要 + 「展开下文」链接，全文要另一条详情 CGI（SnowLuma 未暴露）。
  // 至少在正文末尾明确标注"没读完"，让模型只针对看到的部分评论，不编造后续。
  const QZONE_FOLD_MARK = '……（后半段被 QQ 折叠了，我没读到）';
  function qzoneFeedText(item) {
    const cands = [item?.content, item?.rt_con?.content, item?.summary, item?.title, item?.desc];
    for (const c of cands) {
      const s = typeof c === 'string' ? c.replace(/\s+/g, ' ').trim() : '';
      if (s) return s;
    }
    // 实测（2026-09-30）：动态条目的 html 里，正文在
    // <div class="f-info"> 正文 </div>；直接整体剥标签会把"浏览N次/点赞名单"一起带出来。
    const html = String(item?.html ?? '');
    const m = /<div[^>]*class="[^"]*\bf-info\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
    if (m) {
      const raw = stripHtmlTags(m[1]);
      // 折叠按钮文字在摘要末尾（"展开/全文"出现在末尾 12 字内才按折叠处理，避免误伤正文）
      if (/展开|全文/.test(raw.slice(-12))) {
        const cleaned = raw.replace(/\s*(展开下文|展开全文|查看全文|展开|全文)[\s…·.]*$/, '').trim();
        return cleaned + QZONE_FOLD_MARK;
      }
      return raw;
    }
    return stripHtmlTags(html);
  }

  /** 把若干短行折成不超过 max 字的消息块（避免把一条动态劈成两条）。 */
  function packTextBlocks(header, items, max = 380) {
    const blocks = [];
    let cur = String(header ?? '');
    for (const it of items) {
      const line = String(it ?? '');
      if (cur && cur.length + 1 + line.length > max) { blocks.push(cur); cur = line; }
      else cur = cur ? `${cur}\n${line}` : line;
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  function splitTextForQQ(text, max = 450) {
    const raw = String(text ?? '');
    const out = [];
    for (let i = 0; i < raw.length && out.length < 10; i += max) out.push(raw.slice(i, i + max));
    return out.length ? out : [''];
  }

  /**
   * 从最近的「动态 / 说说」缓存里找出这条 tid 属于谁、什么时候发的。
   * 点赞要带 abstime 才稳（见 SnowLuma setQzoneLike 的注释：0 只是兜底）。
   * 找不到就返回 null —— 宁可不做，也不猜一个 target_uin 出去。
   */
  async function resolveQzoneTarget(tid, explicitUin) {
    const want = String(tid ?? '').trim();
    const selfUin = await getQzoneSelfUin();
    const feeds = Array.isArray(qzoneState.lastFeeds?.feeds) ? qzoneState.lastFeeds.feeds : [];
    const hit = feeds.find((f) => String(f?.key ?? '') === want || String(f?.tid ?? '') === want);
    if (hit) {
      // 实测（2026-09-30）：好友动态里会夹广告，uin=0、tid=advertisement_outlink_0。
      // 这种没有可靠的作者 QQ，宁可不做也不拿 0 去点赞。
      const owner = Number(hit.uin ?? 0);
      if (!owner) return { error: '这条是广告 / 非好友动态（没有可靠的作者 QQ），我不碰它。' };
      const self = Boolean(selfUin) && String(owner) === selfUin;
      return { uin: String(owner), abstime: Number(hit.time ?? 0), from: self ? '鲸鲸自己（我发的动态）' : `${String(hit.nickname ?? owner)}（${owner}）`, self };
    }
    const mine = (qzoneState.lastMsgList ?? []).find((m) => String(m?.tid ?? '') === want);
    if (mine) return { uin: '', abstime: Number(mine.time ?? 0), from: '鲸鲸自己空间', self: true };
    if (explicitUin) return { uin: String(explicitUin), abstime: 0, from: `指定的 ${explicitUin}` };
    return null;
  }

  /** 「<tid> [对方QQ] [其余…]」——QQ 号是可选的第二段，其余都是内容。 */
  function splitTidAndUin(rest) {
    const parts = String(rest ?? '').trim().split(/[\s\u3000]+/).filter(Boolean);
    const tid = parts.shift() ?? '';
    let uin = '';
    if (parts.length && /^\d{5,11}$/.test(parts[0])) uin = parts.shift() ?? '';
    return { tid, uin, rest: parts.join(' ') };
  }

  // ── 空间评论：让模型自己想一句（默认先给 owner 看草稿，点头才发）────────────
  // 用 qq-chat-v2 单独开一个会话：它本来就"没有人设以外的本机工具"（与群聊会话同款 preset），
  // 角色卡由桥接按 currentRoleHint() 注入 —— 和群里是同一份，评论文风才一致。
  const QZONE_COMMENT_FILE = path.join(STATE_DIR, 'qzone-comment.json');
  const QZONE_COMMENT_PRESET = 'qq-chat-v2';
  const QZONE_COMMENT_DIR = path.join(ROOT, '..', 'jobs');
  const QZONE_COMMENT_TIMEOUT_MS = 120000;
  const qzoneComment = { sessionId: '' };
  const qzoneCommentSessionIds = new Set();
  const qzoneCommentWaiters = new Map();     // sessionId -> [{ resolve, reject, timer }]
  const qzoneCommentCollectors = new Map();  // sessionId -> turn 收集器

  /**
   * DSH 事件流里属于"空间评论会话"的那一帧：收集完一轮就唤醒等待中的草稿请求。
   * 三个内部状态（ids / collectors / waiters）不对外暴露——桥接只拿到"这帧归不归我"。
   * 挂在桥接的"未知会话"分支里（和 PC 指令同款），挂错分支就永远执行不到。
   */
  function handleCommentFrame(frame) {
    if (!qzoneCommentSessionIds.has(frame?.sessionId)) return false;
    const qzCollector = qzoneCommentCollectors.get(frame.sessionId) ?? createTurnCollector();
    qzoneCommentCollectors.set(frame.sessionId, qzCollector);
    const qzEnded = qzCollector.push(frame.event);
    if (qzEnded) {
      qzoneCommentCollectors.delete(frame.sessionId);
      const waiters = qzoneCommentWaiters.get(frame.sessionId) ?? [];
      const waiter = waiters.shift();
      if (waiters.length === 0) qzoneCommentWaiters.delete(frame.sessionId);
      if (waiter) {
        clearTimeout(waiter.timer);
        if (qzEnded.reason?.kind === 'completed' && String(qzEnded.text ?? '').trim()) waiter.resolve(qzEnded.text);
        else {
          // 把真正的失败原因带出来：以前只写 kind（如 "error"），
          // 上游 402 额度不足 / 鉴权失败时日志里看不出到底怎么了。
          const detail = qzEnded.reason?.error?.message || qzEnded.reason?.failure?.message || '';
          waiter.reject(new Error(`评论会话这一轮没正常完成：${qzEnded.reason?.kind ?? 'unknown'}${detail ? `（${detail}）` : ''}`));
        }
      }
    }
    return true;
  }
  {
    const saved = readJsonSafe(QZONE_COMMENT_FILE, null);
    if (saved && typeof saved === 'object' && typeof saved.sessionId === 'string' && saved.sessionId) {
      qzoneComment.sessionId = saved.sessionId;
      qzoneCommentSessionIds.add(saved.sessionId);
      try { api.events.follow(saved.sessionId); } catch {}
    }
  }

  function addQzoneWaiter(sessionId, waiter) {
    const list = qzoneCommentWaiters.get(sessionId) ?? [];
    list.push(waiter);
    qzoneCommentWaiters.set(sessionId, list);
  }
  function dropQzoneWaiter(sessionId, waiter) {
    const list = qzoneCommentWaiters.get(sessionId) ?? [];
    const idx = list.indexOf(waiter);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) qzoneCommentWaiters.delete(sessionId);
    if (waiter?.timer) clearTimeout(waiter.timer);
  }

  async function ensureQzoneCommentSession() {
    if (qzoneComment.sessionId && qzoneCommentSessionIds.has(qzoneComment.sessionId)) return qzoneComment.sessionId;
    fs.mkdirSync(QZONE_COMMENT_DIR, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: QZONE_COMMENT_DIR }), 'workspace.create');
    if (wsValue.created) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: 'QQ 空间评论（自动出草稿）' }); } catch {}
    }
    const value = unwrap(await api.sessions.create({ workspaceId: wsValue.workspace.workspaceId, agentPreset: QZONE_COMMENT_PRESET }), 'session.create');
    qzoneComment.sessionId = value.sessionId;
    qzoneCommentSessionIds.add(value.sessionId);
    try { api.events.follow(value.sessionId); } catch {}
    try { await ensureChatModel(value.sessionId); } catch (error) { log('空间评论：设置会话模型失败: ' + (error?.message ?? error)); }
    try { atomicWriteJson(QZONE_COMMENT_FILE, { sessionId: qzoneComment.sessionId }); } catch {}
    log(`空间评论：已创建评论会话 ${value.sessionId}（preset ${QZONE_COMMENT_PRESET}）`);
    return qzoneComment.sessionId;
  }

  /** 提示词前缀（角色卡 + 要求）必须稳定，帖子正文放最后 —— 这样第二轮起能吃到缓存。 */
  function buildQzoneCommentPrompt(post, from, isSelf = false) {
    const role = currentRoleHint().slice(0, 2000);
    // 自己的动态要用"作者本人补一句"的视角，否则模型会拿评论别人的口吻评论自己（2026-11-01 反馈）
    const scene = isSelf
      ? '【场景】下面这条是你自己（鲸鲸）之前发的 QQ 空间动态。你要在自己这条动态下面补一条评论——像作者本人补充一句、接自己的话、或者自嘲一下；不要用旁观者的口吻评价"这个人"，别搞得像在评论别人。'
      : '【场景】有人发了条 QQ 空间动态，你要以你自己的身份在下面留一条评论。';
    return `${scene}

【你的人格设定】
${role || '（没有角色卡：用一个话不多、真诚、偶尔损人但不刻薄的普通网友语气。）'}

【这条动态是谁发的】${from}
【动态正文】
${post}

【硬要求】
1. 只输出评论正文本身：不要解释、不要引号、不要 markdown、不要前缀。
2. 一条，**不超过 40 个字**，越短越像真人。
3. 可以顺着内容聊、可以开个小玩笑、可以说句真心话；**不要**空洞的夸（"写得好""太棒了"这种别发）。
4. 这条动态不适合评论（广告、看不懂、涉及隐私）时，只输出：[[SKIP]]
5. 不要 @ 人、不要放链接、不要提 AI / 模型 / DeepSeek。
6. 如果正文末尾标注了"被 QQ 折叠、没读到"，只针对看到的部分评论，不要编造后面的内容。`;
  }

  function cleanQzoneDraft(text) {
    const first = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
    const out = first.replace(/^[「『"'“”]+/, '').replace(/[」』"'“”]+$/, '').trim();
    return out.length > 60 ? out.slice(0, 60) : out;
  }

  async function promptQzoneComment(sessionId, promptText) {
    let waiter = null;
    const wait = new Promise((resolve, reject) => {
      waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        dropQzoneWaiter(sessionId, waiter);
        reject(new Error('生成超时（模型 2 分钟没回话）'));
      }, QZONE_COMMENT_TIMEOUT_MS);
      addQzoneWaiter(sessionId, waiter);
    });
    let accepted = null;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    } catch (error) {
      dropQzoneWaiter(sessionId, waiter);
      throw error;
    }
    if (!accepted?.result?.ok) {
      dropQzoneWaiter(sessionId, waiter);
      const err = accepted?.result?.error ? `${accepted.result.error.code}: ${accepted.result.error.message}` : '未知错误';
      throw new Error(err);
    }
    return wait;
  }

  /** 通用：往空间评论会话里投一条 prompt 并等模型回话（会话失效/轮次出错自动重建重试一次）。 */
  async function askQzoneSession(promptText) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = await ensureQzoneCommentSession();
      try {
        const raw = await promptQzoneComment(sessionId, promptText);
        return { raw: String(raw ?? '').trim(), sessionId };
      } catch (error) {
        const msg = String(error?.message ?? error);
        // not-found = 会话没了；「没正常完成：error」多为旧会话在 DSH 重启后状态坏了——都值得重建一次再试。
        if (attempt === 0 && (/not-found|not found|不存在/i.test(msg) || /没正常完成/.test(msg))) {
          qzoneCommentSessionIds.delete(sessionId);
          qzoneComment.sessionId = '';
          try { atomicWriteJson(QZONE_COMMENT_FILE, { sessionId: '' }); } catch {}
          log('空间评论：会话已失效/轮次出错，重建后重试');
          continue;
        }
        throw error;
      }
    }
    throw new Error('评论会话不可用');
  }

  async function askQzoneComment(post, from, isSelf = false) {
    const promptText = buildQzoneCommentPrompt(post, from, isSelf);
    return askQzoneSession(promptText);
  }

  /** 从最近的动态/说说缓存里取这条帖子的正文（生成评论要用）。 */
  const QZONE_MODE_FILE = path.join(STATE_DIR, 'qzone-comment-mode.json');
  // 默认 review：评论是唯一会出现在**别人动态下面**的动作，默认多一次确认。
  // 每次现读文件（几百字节），所以桌面那个切换 bat 一写就立刻生效，不需要重启桥接。
  function qzoneCommentMode() {
    try {
      const j = readJsonSafe(QZONE_MODE_FILE, null);
      return j?.mode === 'direct' ? 'direct' : 'review';
    } catch { return 'review'; }
  }

  function qzonePostText(tid) {
    const want = String(tid ?? '');
    const feeds = Array.isArray(qzoneState.lastFeeds?.feeds) ? qzoneState.lastFeeds.feeds : [];
    const hit = feeds.find((f) => String(f?.key ?? '') === want || String(f?.tid ?? '') === want);
    if (hit) return qzoneFeedText(hit);
    const mine = (qzoneState.lastMsgList ?? []).find((m) => String(m?.tid ?? '') === want);
    if (mine) return String(mine.content ?? '').replace(/\s+/g, ' ').trim();
    return '';
  }

  /** 生成草稿（「评」预览、「评发」直发、空间自动化三处共用）。
   *  postTextOverride 是给自动化用的——它自己已经拿到动态正文，不必再查缓存。 */
  async function makeQzoneDraft(tid, target, postTextOverride) {
    const post = String(postTextOverride ?? '').trim() || qzonePostText(tid);
    if (!post) return { ok: false, why: '我没存到这条的正文（动态列表可能过期了）。先发一次「指令 空间 动态 3」再重试。' };
    const { raw, sessionId } = await askQzoneComment(post, target.from, Boolean(target.self));
    if (/\[\[SKIP\]\]/i.test(raw)) return { ok: false, why: `这条我觉得不适合评论（广告 / 看不懂 / 太私人），就没写。想发你自己给内容：指令 空间 评 ${tid} <内容>` };
    const draft = cleanQzoneDraft(raw);
    if (!draft) return { ok: false, why: `模型没给出可用的评论（原文：${raw.slice(0, 60) || '空'}）。` };
    log(`空间评论：草稿「${draft}」（会话 ${sessionId}）`);
    return { ok: true, draft };
  }

  // ── 空间自动化：它自己去看、自己决定（默认关；档位可一键切换）──────────────
  // 和手动指令共用同一套 SnowLuma 接口、同一个角色卡会话、同一个审计文件；
  // 区别只是"谁决定碰哪一条"。
  //
  // 档位（state/qzone-auto.json 的 mode）：
  //   off      关闭（默认）
  //   like     只自动点赞好友新动态
  //   comment  like + 自动评论（模型自己判断，觉得没话说就跳过）
  //   active   comment + 更宽的频率上限
  //
  // ⚠️ 硬事实：点赞能程序化取消（unlike_qzone），**评论发出去不能程序化撤回**——
  // 所以每轮动作都会给 owner 发一条简报，看到不合适的只能手动在手机上删。
  const QZONE_AUTO_FILE = path.join(STATE_DIR, 'qzone-auto.json');
  const QZONE_SEEN_FILE = path.join(STATE_DIR, 'qzone-seen.json');
  const QZONE_AUTO_MODES = ['off', 'like', 'comment', 'active'];
  const QZONE_AUTO_LIMITS = {
    off: { intervalMin: 0, maxLikesPerRound: 0, maxCommentsPerRound: 0, maxCommentsPerDay: 0, postMaxAgeHours: 0 },
    like: { intervalMin: 30, maxLikesPerRound: 5, maxCommentsPerRound: 0, maxCommentsPerDay: 0, postMaxAgeHours: 24 },
    comment: { intervalMin: 60, maxLikesPerRound: 5, maxCommentsPerRound: 1, maxCommentsPerDay: 5, postMaxAgeHours: 24 },
    active: { intervalMin: 30, maxLikesPerRound: 8, maxCommentsPerRound: 2, maxCommentsPerDay: 8, postMaxAgeHours: 12 },
  };
  const qzoneAuto = {
    lastRunAt: Date.now(),
    running: false,
    cooldownUntil: 0,
    lastError: '',
    lastSummary: '',
    todayKey: '',
    todayComments: 0,
    todayLikes: 0,
  };
  const qzoneSeen = new Map(); // tid -> { at, act, who }
  // 官方号 / 活动号不是"朋友"，别去人家动态下面留言（20050606 = 官方Qzone，实测会出现在好友动态里）
  const QZONE_SKIP_UINS = new Set(['20050606', '10000', '10001']);
  const QZONE_SKIP_NICK = /官方|腾讯|QQ空间|客服|助手|活动|广告|测试|小助手/i;

  function qzoneAutoMode() {
    try {
      const j = readJsonSafe(QZONE_AUTO_FILE, null);
      const m = String(j?.mode ?? 'off');
      return QZONE_AUTO_MODES.includes(m) ? m : 'off';
    } catch { return 'off'; }
  }
  function qzoneAutoLimits(mode) {
    const m = mode ?? qzoneAutoMode();
    return QZONE_AUTO_LIMITS[m] ?? QZONE_AUTO_LIMITS.off;
  }
  function qzoneAutoRollDay() {
    const key = new Date().toISOString().slice(0, 10);
    if (qzoneAuto.todayKey !== key) {
      qzoneAuto.todayKey = key;
      qzoneAuto.todayComments = 0;
      qzoneAuto.todayLikes = 0;
    }
  }
  function loadQzoneSeen() {
    try {
      const j = readJsonSafe(QZONE_SEEN_FILE, null);
      for (const [k, v] of Object.entries(j?.tids ?? {})) qzoneSeen.set(k, v);
    } catch { /* 没有就不管 */ }
  }
  function saveQzoneSeen() {
    try {
      const kept = [...qzoneSeen.entries()].sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 500);
      qzoneSeen.clear();
      for (const [k, v] of kept) qzoneSeen.set(k, v);
      atomicWriteJson(QZONE_SEEN_FILE, { tids: Object.fromEntries(kept) });
    } catch (error) { log('空间自动化：保存去重表失败 ' + (error?.message ?? error)); }
  }
  loadQzoneSeen();

  /**
   * 跑一轮。dryRun=true：只读动态 + 最多让模型出 1 条草稿，不做任何写操作、不发 QQ。
   * 返回 { mode, lines } —— lines 既是控制台自检结果，也是给 owner 的简报素材。
   */
  async function qzoneAutoRound(dryRun = false) {
    const mode = qzoneAutoMode();
    const lim = qzoneAutoLimits(mode);
    if (mode === 'off') return { mode, lines: ['自动化是关的（双击桌面「空间自动化」可以开）。'] };
    qzoneAutoRollDay();
    if (!dryRun && Date.now() < qzoneAuto.cooldownUntil) {
      return { mode, lines: [`限流冷却中，约 ${Math.ceil((qzoneAuto.cooldownUntil - Date.now()) / 60000)} 分钟后重试。`] };
    }
    let data;
    try {
      data = await callSnowLuma('get_qzone_feeds', { page_num: 1, count: 10 });
    } catch (error) {
      const msg = String(error?.message ?? error);
      if (/network busy|-10001/i.test(msg)) {
        // 腾讯侧节流：拉长冷却，别硬撞（撞了只会更久读不到）
        qzoneAuto.cooldownUntil = Date.now() + 30 * 60 * 1000;
        log('空间自动化：动态接口限流，冷却 30 分钟');
        return { mode, lines: [`腾讯把动态接口限流了，30 分钟后再看（${msg.slice(0, 50)}）。`] };
      }
      throw error;
    }
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    const selfUin = await getQzoneSelfUin();
    const now = Date.now();
    const acts = [];
    const skipped = [];
    let liked = 0;
    let commented = 0;
    const commentBudget = dryRun
      ? lim.maxCommentsPerRound
      : Math.max(0, Math.min(lim.maxCommentsPerRound, lim.maxCommentsPerDay - qzoneAuto.todayComments));

    for (const f of feeds) {
      const tid = String(f?.key ?? f?.tid ?? '');
      const owner = Number(f?.uin ?? 0);
      // 广告 / 非好友动态没有可靠的作者 QQ —— 不记去重表，只跳过
      if (!tid || !owner) continue;
      if (qzoneSeen.has(tid)) continue;
      // 自己的动态也会混在好友动态里（2026-11-01 实测占一半以上）——不给自己点赞评论
      if (selfUin && String(owner) === selfUin) {
        qzoneSeen.set(tid, { at: now, act: 'self' });
        continue;
      }
      const at = Number(f?.time ?? 0) * 1000;
      if (at && now - at > lim.postMaxAgeHours * 3600 * 1000) {
        qzoneSeen.set(tid, { at: now, act: 'too-old' });
        continue;
      }
      // 官方号 / 活动号不是"朋友"，别去人家动态下面留言（实测官方Qzone 就会出现）
      if (QZONE_SKIP_UINS.has(String(owner)) || QZONE_SKIP_NICK.test(String(f?.nickname ?? ''))) {
        qzoneSeen.set(tid, { at: now, act: 'official' });
        continue;
      }
      const who = `${String(f?.nickname ?? owner)}（${owner}）`;
      const text = qzoneFeedText(f);
      const wantLike = liked < lim.maxLikesPerRound;
      const wantComment = Boolean(text) && commented < commentBudget;
      if (!wantLike && !wantComment) break;

      if (wantLike) {
        if (dryRun) {
          liked += 1;
          acts.push(`（试运行）给 ${who} 点赞`);
        } else {
          try {
            await callSnowLuma('like_qzone', { tid, target_uin: String(owner), abstime: Number(f?.time ?? 0) });
            liked += 1;
            qzoneAuto.todayLikes += 1;
            qzoneSeen.set(tid, { at: Date.now(), act: 'like', who });
            auditQzone({ kind: 'like', tid, targetUin: String(owner), from: who, by: 'auto' });
            acts.push(`赞了 ${who}`);
          } catch (error) {
            qzoneSeen.set(tid, { at: Date.now(), act: 'like-failed' });
            log(`空间自动化：点赞失败 ${tid} ${error?.message ?? error}`);
          }
        }
      }

      if (wantComment) {
        try {
          const made = await makeQzoneDraft(tid, { from: who, uin: String(owner) }, text);
          if (!made.ok) {
            if (!dryRun) qzoneSeen.set(tid, { at: Date.now(), act: 'skip' });
            skipped.push(made.why);
          } else if (dryRun) {
            commented += 1;
            acts.push(`（试运行）会评论 ${who}：「${made.draft}」`);
          } else {
            await callSnowLuma('comment_qzone', { tid, content: made.draft, target_uin: String(owner) });
            commented += 1;
            qzoneAuto.todayComments += 1;
            qzoneSeen.set(tid, { at: Date.now(), act: 'comment', who, draft: made.draft });
            auditQzone({ kind: 'comment', tid, targetUin: String(owner), from: who, content: made.draft, by: 'auto' });
            acts.push(`评论 ${who}：「${made.draft}」`);
          }
        } catch (error) {
          qzoneSeen.set(tid, { at: Date.now(), act: 'comment-failed' });
          log(`空间自动化：评论失败 ${tid} ${error?.message ?? error}`);
        }
      } else if (!dryRun) {
        qzoneSeen.set(tid, { at: Date.now(), act: 'seen' });
      }
    }

    if (!dryRun) saveQzoneSeen();

    const lines = acts.length
      ? acts
      : (skipped.length ? [`看过一轮，没有值得开口的（${skipped.length} 条被我跳过了）。`] : ['这一轮没有新动态可碰。']);
    if (acts.length) {
      qzoneAuto.lastSummary = acts.join('；');
      if (!dryRun) {
        const reportKey = `private:${String(cfg.ownerQQ ?? '')}`;
        try { await sendToQQ(reportKey, `🌊 我在空间转了一圈：${acts.join('；')}`); }
        catch (error) { log('空间自动化：简报发送失败 ' + (error?.message ?? error)); }
      }
    }
    return { mode, lines };
  }

  // 60 秒一个心跳，按档位的 intervalMin 决定真正跑不跑（档位文件每次现读 → 改了立刻生效）
  const qzoneAutoTimer = setInterval(() => {
    const mode = qzoneAutoMode();
    if (mode === 'off' || qzoneAuto.running) return;
    const lim = qzoneAutoLimits(mode);
    if (Date.now() - qzoneAuto.lastRunAt < lim.intervalMin * 60 * 1000) return;
    qzoneAuto.lastRunAt = Date.now();
    qzoneAuto.running = true;
    qzoneAutoRound(false)
      .catch((error) => {
        qzoneAuto.lastError = String(error?.message ?? error);
        log('空间自动化：本轮异常 ' + qzoneAuto.lastError);
      })
      .finally(() => { qzoneAuto.running = false; });
  }, 60 * 1000);
  qzoneAutoTimer.unref?.();

  // ── 说说自动生成：从近期记录自己挑素材 → 生成草稿 → 自己决定发不发 ──────────
  // 与点赞/评论自动化方向相反：那些是"回应别人"，这个是"自己发朋友圈"。
  //   素材只用现有数据（social-v2 会话记录 / recent-actions / qq-activity.log 尾部），
  //   生成复用空间评论那个 qq-chat-v2 会话（同一角色卡 → 文风一致），
  //   发不发先由模型判断（可以答"不发"），桥接再用频率闸门兜底（每天 ≤1 条、间隔 ≥8h、随机"这轮懒得发"）。
  // 安全：默认 dry-run——「开」只启动草稿生成；真发必须 state/qzone-post-auto.json 里 publish:true，
  //   QQ 指令故意不提供改 publish 的入口，防止误触。发送走 qzoneReply('发 …') = 与 POST /api/qzone 同一条通道。
  const QZONE_POST_AUTO_FILE = path.join(STATE_DIR, 'qzone-post-auto.json');
  const QZONE_POST_DRAFT_FILE = path.join(STATE_DIR, 'qzone-auto-draft.json');
  const QZONE_POST_DEFAULTS = { enabled: false, publish: false, maxPerDay: 1, minGapHours: 8, postChance: 0.6, ugcRight: 1 };
  // 说说可见范围（OneBot send_qzone_msg 的 ugc_right）：
  //   1 = 所有人可见（默认，真发就是公开的）
  //  64 = 仅自己可见 —— 联调/验收专用：真上传图片、真建说说、真走完整链路，
  //       但只有自己能看到，测完可以妥妥删掉，不会打扰任何人。
  const QZONE_UGC_RIGHTS = new Set([1, 4, 16, 64, 128]);
  function readQzonePostAuto() {
    try {
      const j = readJsonSafe(QZONE_POST_AUTO_FILE, null) ?? {};
      const chance = Number(j.postChance);
      const ugc = Number(j.ugcRight);
      return {
        enabled: j.enabled === true,
        publish: j.publish === true,
        maxPerDay: Math.max(1, Number(j.maxPerDay) || 1),
        minGapHours: Math.max(1, Number(j.minGapHours) || 8),
        postChance: Math.min(1, Math.max(0, Number.isFinite(chance) ? chance : QZONE_POST_DEFAULTS.postChance)),
        ugcRight: QZONE_UGC_RIGHTS.has(ugc) ? ugc : QZONE_POST_DEFAULTS.ugcRight,
      };
    } catch { return { ...QZONE_POST_DEFAULTS }; }
  }
  function writeQzonePostAuto(patch) {
    const next = { ...readQzonePostAuto(), ...patch };
    try { atomicWriteJson(QZONE_POST_AUTO_FILE, next); }
    catch (error) { log('说说自动：写配置失败 ' + (error?.message ?? error)); }
    return next;
  }
  function loadQzonePostDrafts() {
    try {
      const j = readJsonSafe(QZONE_POST_DRAFT_FILE, null);
      return Array.isArray(j?.drafts) ? j.drafts : [];
    } catch { return []; }
  }
  function appendQzonePostDraft(entry) {
    const list = loadQzonePostDrafts();
    list.unshift({ at: Date.now(), ...entry });
    try { atomicWriteJson(QZONE_POST_DRAFT_FILE, { drafts: list.slice(0, 50) }); }
    catch (error) { log('说说自动：写草稿失败 ' + (error?.message ?? error)); }
  }

  /** 素材收集：只读现有数据，不新建存储。 socialV2 会话的真人消息 + 我做过的事 + 活动流水尾部。 */
  function collectQzonePostMaterial() {
    const now = Date.now();
    const bits = [];
    for (const [key, st] of socialV2.conversations) {
      const msgs = (Array.isArray(st?.recentMessages) ? st.recentMessages : [])
        .filter((m) => m && !m.isSelf && now - Number(m.time || 0) < 48 * 3600 * 1000)
        .slice(-8)
        .map((m) => `[${key}] ${String(m.sender || '?')}：${String(m.text || m.plain || '').replace(/\s+/g, ' ').slice(0, 60)}`);
      if (msgs.length) bits.push(...msgs);
    }
    for (const it of recentActions.slice(0, 6)) bits.push(`[我做过] ${it.text}`);
    try {
      const tail = fs.readFileSync(path.join(STATE_DIR, 'qq-activity.log'), 'utf8')
        .split(/\r?\n/).filter((l) => l.includes('消息已入未读')).slice(-12);
      for (const l of tail) bits.push(`[流水] ${l.slice(0, 90)}`);
    } catch { /* 没有活动流水就算了 */ }
    return bits.slice(-60).join('\n').slice(0, 3000);
  }

  /**
   * 配图候选：从本地表情库挑"有备注/标签、有 url"的自定义表情（不带 QQ 自带 face，那种没有图）。
   * 只把这些白名单条目给模型看；发送时也只认白名单里的 md5 —— 模型输出什么 URL 都不会被采纳。
   * 没有可用表情时返回空行，提示词里自然就没有配图选项。
   */
  function qzonePostStickerMenu() {
    const list = getStickerEntries()
      .filter((e) => e.kind !== 'face' && e.url && (e.desc || e.localNote || (e.tags?.length)))
      .map((e) => ({ md5: e.md5, label: e.desc || e.localNote || (e.tags || []).join('/') }));
    if (!list.length) return '';
    const lines = list.slice(0, 20).map((s) => `- ${s.label}（图:${s.md5.slice(0, 10)}）`);
    return `【可选配图（你的 QQ 收藏表情，想配就挑一张；不合适就不配）】\n${lines.join('\n')}\n配图规则：配图不是必须的，多数说说不用配；拿不准就不配。格式：在「发|正文」后面加「|图:<冒号前那串代码>」，例如 发|今天改bug改到怀疑人生|图:3B23BA3564；不需要配图就别加。`;
  }

  /** 从模型输出里解析可选的「图:<md5>」段，返回 { draft, imageMd5 }；md5 必须命中本地表情库白名单。 */
  function parseQzonePostImage(text, stickerList) {
    const t = String(text ?? '');
    const m = t.match(/[|｜]\s*图\s*[:：]?\s*([0-9a-fA-F]{6,40})\s*$/);
    if (!m) return { draft: t.trim(), imageMd5: '' };
    const prefix = m[1].toUpperCase();
    const hit = (stickerList || getStickerEntries()).find((e) => e.kind !== 'face' && e.md5 && e.md5.startsWith(prefix) && e.url);
    if (!hit) return { draft: t.slice(0, m.index).trim(), imageMd5: '' };  // 白名单没有 → 当没写，只留正文
    return { draft: t.slice(0, m.index).trim(), imageMd5: hit.md5, imageUrl: hit.url };
  }

  /**
   * 发说说的唯一出口（带不带图都走它）—— 保证「说说自动」与 owner 手动「指令 空间 发」是同一条通道。
   * ugcRight：1=所有人可见，64=仅自己可见（联调/验收用）。默认 1。
   * 返回给用户看的一句话。
   */
  async function postQzoneMsg({ content, images = null, ugcRight = 1 } = {}) {
    const payload = { content, ugc_right: ugcRight };
    const imgs = Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : [];
    if (imgs.length) payload.images = imgs;
    const data = await callSnowLuma('send_qzone_msg', payload);
    const tid = data?.tid ?? data?.data?.tid ?? '';
    auditQzone({ kind: 'publish', content, tid, images: imgs.length ? imgs : undefined, ugcRight, result: data ?? null });
    const vis = ugcRight === 64 ? '（仅自己可见）' : '';
    return `已发到鲸鲸空间${vis}${tid ? `，tid ${tid}` : ''}${imgs.length ? '（带 1 张配图）' : ''}。`;
  }

  /** 读 state/topic-bias.json：和聊天用的是同一份"小偏好"，让说说和聊天气质一致（是同一个人）。 */
  function qzonePersonaBiasLine() {
    try {
      const j = readJsonSafe(path.join(STATE_DIR, 'topic-bias.json'), null);
      const hot = (Array.isArray(j?.hot) ? j.hot : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
      const cold = (Array.isArray(j?.cold) ? j.cold : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
      if (!hot.length && !cold.length) return '';
      return `【你的小偏好】${hot.length ? `聊到 ${hot.join('、')} 你会多说两句；` : ''}${cold.length ? `${cold.join('、')} 你一般懒得提。` : ''}这是你自己的口味，自然带出来就行，别念叨。`;
    } catch { return ''; }
  }
  // 每轮随机一条"本轮姿态"，让说说的语气有起伏，而不是永远同一个腔调。
  const QZONE_POST_NUDGES = [
    '这轮随性点，有一句没一句都行，不硬凑。',
    '如果素材里有梗，可以带点调侃，但别过头。',
    '这轮允许惜字如金：能一个词说清就不写句子。',
    '如果正好戳中你的兴趣点，多写两句也无妨。',
    '这轮别总结、别升华，平铺直叙最像人。',
  ];
  /** 提示词：角色卡在前（稳定前缀），素材放最后。要求模型在"发/不发"里做真实判断。 */
  function buildQzonePostPrompt(material) {
    const role = currentRoleHint().slice(0, 2000);
    const stickerMenu = qzonePostStickerMenu();
    const bias = qzonePersonaBiasLine();
    const nudge = QZONE_POST_NUDGES[Math.floor(Math.random() * QZONE_POST_NUDGES.length)];
    return `【场景】你想在自己的 QQ 空间发一条说说。下面是你最近两天的生活素材（聊天记录摘要、你自己在电脑上做过的事、系统流水）。
【你的人格设定】
${role || '（没有角色卡：用一个话不多、真诚、偶尔损人但不刻薄的普通网友语气。）'}
${bias ? `\n${bias}\n` : ''}
【素材】
${material}
${stickerMenu ? `\n${stickerMenu}\n` : ''}
【判断（按顺序，认真做）】
1. 素材里有无值得发的点？必须有真实的事、情绪或梗，能让人看出"这是段生活"；没有 → 不发。
2. 有也别每次都发：像真人一样，多数时候其实懒得发。素材平庸、重复、或只是别人的话有意思但不关你的事 → 不发。
【输出格式（严格遵守，只输出一行）】
发|<说说正文>|图:<配图代码>（图是可选的，不要配图就省略）
不发|<一句话原因>
【正文硬要求】像真人发朋友圈：短（不超过 60 字）、有具体事件或情绪、有细节；禁止"今天也是元气满满的一天""感恩生活""不负韶华""记录美好生活"这类 AI 味套话；不 @ 人、不放链接、不提 AI/模型/DeepSeek；不要解释、不要话题标签、不要 emoji 堆砌（最多一个）。
【本轮姿态】${nudge}`;
  }

  /**
   * 跑一轮"要不要发说说"。
   * force=true：跳过频率闸门与随机懒（owner 手动「说说 跑一轮」用），仍然尊重 publish 开关。
   * 返回 { ran, lines }。
   */
  async function qzonePostAutoRound(force = false) {
    const conf = readQzonePostAuto();
    if (!conf.enabled && !force) return { ran: false, lines: ['说说自动是关的。指令 空间 说说 开 可以启动。'] };
    const now = Date.now();
    const dayKey = new Date().toISOString().slice(0, 10);
    const drafts = loadQzonePostDrafts();
    const postedToday = drafts.filter((d) => d?.action === 'posted' && String(d.day ?? '') === dayKey).length;
    let lastPostedAt = 0;
    for (const d of drafts) { if (d?.action === 'posted' && Number(d.at)) { lastPostedAt = Number(d.at); break; } }
    // 上一次"真的让模型想过"（发过、出过草稿、或明确决定不发都算）。
    // 单独卡这道是为了省 token：心跳 10 分钟一次，若不卡，dry-run 下一天会烧掉上百次模型调用。
    // 顺带也更像人——不会每十分钟重新考虑一遍要不要发朋友圈。
    const lastDecisionAt = Number(drafts[0]?.at) || 0;
    if (!force) {
      if (postedToday >= conf.maxPerDay) return { ran: false, lines: null };
      if (lastPostedAt && now - lastPostedAt < conf.minGapHours * 3600 * 1000) return { ran: false, lines: null };
      if (lastDecisionAt && now - lastDecisionAt < conf.minGapHours * 3600 * 1000) return { ran: false, lines: null };
      if (Math.random() > conf.postChance) {
        log('说说自动：这轮随机"懒得发"，跳过');
        return { ran: false, lines: null };
      }
    }
    const material = collectQzonePostMaterial();
    if (!material || material.length < 60) {
      log('说说自动：素材太少，这轮不生成');
      return { ran: false, lines: ['素材太少（最近 48 小时没什么记录），没生成。'] };
    }
    const { raw } = await askQzoneSession(buildQzonePostPrompt(material));
    const first = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
    const m = first.match(/^(发|不发)\s*[|｜:：]\s*(.*)$/);
    if (!m) {
      appendQzonePostDraft({ day: dayKey, action: 'invalid', raw: first.slice(0, 120), materialHead: material.slice(0, 120) });
      return { ran: true, lines: [`模型输出没看懂（${first.slice(0, 40)}…），没发。`] };
    }
    if (m[1] === '不发') {
      const why = m[2].trim().slice(0, 100);
      appendQzonePostDraft({ day: dayKey, action: 'skipped', why, materialHead: material.slice(0, 120) });
      log(`说说自动：模型判断不发（${why}）`);
      return { ran: true, lines: [`这轮没发：${why}`] };
    }
    const draftRaw = m[2].trim().replace(/^["「'“]+/, '');
    const pic = parseQzonePostImage(draftRaw, getStickerEntries());
    const draft = pic.draft.replace(/["」'”]+$/g, '').slice(0, 80);
    if (!draft) {
      appendQzonePostDraft({ day: dayKey, action: 'invalid', raw: first.slice(0, 120), materialHead: material.slice(0, 120) });
      return { ran: true, lines: ['草稿是空的，跳过。'] };
    }
    if (!conf.publish) {
      appendQzonePostDraft({ day: dayKey, action: 'draft-only', draft, imageMd5: pic.imageMd5 || undefined, materialHead: material.slice(0, 120) });
      log(`说说自动：草稿「${draft}」${pic.imageMd5 ? '（配图 ' + pic.imageMd5.slice(0, 10) + '…）' : '（无配图）'}（dry-run，publish=false 不真发）`);
      return { ran: true, lines: [`草稿已存（dry-run 不真发）：${draft}${pic.imageMd5 ? ' ＋配图' : ''}`] };
    }
    // 真发：与 POST /api/qzone「发」同一条通道（send_qzone_msg + auditQzone）；
    // 配图把表情库白名单里的图片 URL 塞进 images 参数，由 OneBot 自动上传——不新增发送路径。
    // 若带配图，就不能走 qzoneReply（那条路只发文字），直接调同一个 OneBot action。
    const blocks = pic.imageMd5
      ? [await postQzoneMsg({ content: draft, images: [pic.imageUrl], ugcRight: conf.ugcRight })]
      : await qzoneReply(`发 ${draft}`, false, { ugcRight: conf.ugcRight });
    appendQzonePostDraft({ day: dayKey, action: 'posted', draft, imageMd5: pic.imageMd5 || undefined, ugcRight: conf.ugcRight, materialHead: material.slice(0, 120) });
    recordRecentAction('qzone', `自己发了条说说：「${draft.slice(0, 30)}」${pic.imageMd5 ? '（配了张图）' : ''}`);
    log(`说说自动：已真发「${draft}」${pic.imageMd5 ? '（配图 ' + pic.imageMd5.slice(0, 10) + '…）' : ''}（可见范围 ugc_right=${conf.ugcRight}${conf.ugcRight === 64 ? '=仅自己可见' : ''}）`);
    return { ran: true, lines: [...blocks, `（说说自动：已真发「${draft}」${pic.imageMd5 ? '，配了张图' : ''}；可见范围 ugc_right=${conf.ugcRight}${conf.ugcRight === 64 ? '（仅自己可见）' : ''}）`] };
  }

  async function qzonePostStatusLines() {
    const conf = readQzonePostAuto();
    const all = loadQzonePostDrafts();
    const drafts = all.slice(0, 5);
    const todayKey = new Date().toISOString().slice(0, 10);
    // 先在全量记录里统计，再取最近 5 条展示——否则只数到展示的那几条，会漏报。
    const postedToday = all.filter((d) => d?.action === 'posted' && String(d.day ?? '') === todayKey).length;
    const lines = [
      `说说自动：${conf.enabled ? '开' : '关'}｜真发=${conf.publish ? '是' : '否（dry-run 只出草稿）'}｜每天最多 ${conf.maxPerDay} 条、两条间隔 ≥${conf.minGapHours} 小时、每轮 ${Math.round(conf.postChance * 100)}% 概率真的去想`,
      `今天已真发 ${postedToday}/${conf.maxPerDay} 条。`,
    ];
    if (drafts.length) {
      lines.push('最近记录：');
      for (const d of drafts) {
        const t = new Date(Number(d.at) || Date.now()).toLocaleString('zh-CN', { hour12: false });
        const body = d.action === 'posted' ? `已发「${d.draft}」${d.imageMd5 ? ' ＋配图' : ''}`
          : d.action === 'draft-only' ? `草稿（未发）「${d.draft}」${d.imageMd5 ? ' ＋配图' : ''}`
          : d.action === 'skipped' ? `决定不发（${d.why || '没说原因'}）`
          : `无效输出：${String(d.raw ?? '').slice(0, 40)}`;
        lines.push(`- ${t} ${body}`);
      }
    } else {
      lines.push('还没有记录（等下一轮，或发「指令 空间 说说 跑一轮」立刻试）。');
    }
    return lines;
  }

  // 心跳：每 10 分钟看一眼；开着的才继续。深夜（1-8 点）既不生成也不发（省 token，也像人）。
  const qzonePostAutoTimer = setInterval(() => {
    try {
      const conf = readQzonePostAuto();
      if (!conf.enabled) return;
      const hour = new Date().getHours();
      if (hour >= 1 && hour < 8) return;
      qzonePostAutoRound(false)
        .then((r) => { if (r?.ran && r.lines?.length) log('说说自动：' + r.lines.join('；')); })
        .catch((error) => log('说说自动：本轮异常 ' + (error?.message ?? error)));
    } catch (error) {
      log('说说自动：心跳异常 ' + (error?.message ?? error));
    }
  }, 10 * 60 * 1000);
  qzonePostAutoTimer.unref?.();

  const QZONE_HELP_LINES = [
    '空间指令（只有你能用；手动指定 + 可选自动化）：',
    '指令 空间 说说 [n] — 看鲸鲸空间最近 n 条说说（默认 3，最多 10）；不带数字 = 看说说自动的状态和最近草稿',
    '指令 空间 说说 开 / 关 — 开关"它自己发说说"（默认 dry-run 只出草稿，真发要改 state/qzone-post-auto.json 的 publish=true，改完即生效）',
    '指令 空间 说说 跑一轮 — 立刻收集素材、判断发不发（不等心跳；素材合适时它会自己挑一张收藏表情配图）',
    '指令 空间 动态 [n] — 看好友最近 n 条动态（默认 3，接口有节流）',
    '指令 空间 发 <内容> — 发一条公开说说',
    '指令 空间 删 <tid> — 删鲸鲸空间的一条说说',
    '指令 空间 赞 <tid> [对方QQ] — 点赞（对方QQ一般不用填，会自动认；认不出才需要）',
    '指令 空间 取消赞 <tid> [对方QQ]',
    '指令 空间 评 <tid> [内容] — 评论；不写内容我自己想一句',
    '指令 空间 评看 <tid> — 我自己想一句，只给你看草稿（不管当前模式）',
    '指令 空间 评发 <tid> — 我自己想一句，直接发（不看草稿）',
    '指令 空间 发评论 [内容] — 把上一条草稿发出去（也可以直接写你要发的内容）',
    '指令 空间 自动 — 看"它自己在看空间"的档位、今天做了什么、下一轮什么时候',
  ];
  function qzoneHelp() {
    const mode = qzoneCommentMode();
    return [
      ...QZONE_HELP_LINES,
      `（当前评论模式：${mode === 'direct' ? '想了就发（评＝直发）' : '先看草稿（评＝只出草稿）'}；` +
      '桌面「空间评论模式」双击可一键切换，立刻生效）'
    ].join('\n');
  }

  /**
   * 空间子命令 → 要回发的消息块。
   * dryRun=true 时只查询、绝不下发写操作（控制台自检用）。
   */
  async function qzoneReply(text, dryRun, opts = {}) {
    const parts = String(text ?? '').trim().split(/[\s\u3000]+/).filter(Boolean);
    const sub = parts.shift() ?? '';
    const arg = parts.join(' ').trim();
    const forceUgcRight = [1, 4, 16, 64, 128].includes(Number(opts?.ugcRight)) ? Number(opts.ugcRight) : null;
    if (!sub || /^(帮助|help|\?|？)$/.test(sub)) return [qzoneHelp()];
    try {
      if (/^(说说|我的|列表)$/.test(sub)) {
        // ── 说说自动生成：开/关/状态/跑一轮（默认 dry-run，真发要改 state 文件）──
        if (/^(开|开启|启用|on)$/i.test(arg)) {
          const c = writeQzonePostAuto({ enabled: true });
          return [`说说自动已开。`,
            `当前真发=${c.publish ? '是' : '否'}——${c.publish ? '它会自己判断并发说说' : '默认 dry-run：只生成草稿写进 state/qzone-auto-draft.json，不真发。想让它真能自己发，把 state/qzone-post-auto.json 里 publish 改成 true（配置每轮现读，改完下一轮就生效，不用重启）。'}`];
        }
        if (/^(关|关闭|停|off)$/i.test(arg)) {
          writeQzonePostAuto({ enabled: false });
          return ['说说自动已关（不会再生成草稿）。'];
        }
        if (/^(跑一轮|试试|试跑)$/.test(arg)) {
          if (dryRun) return ['（试运行：会收集素材并让模型判断发不发，dry-run 下不会真发。）'];
          const r = await qzonePostAutoRound(true);
          return r.lines ?? ['这轮没有产出。'];
        }
        if (!arg || /^(状态|草稿|自动)$/.test(arg)) return await qzonePostStatusLines();
        const num = Math.min(Math.max(Number.parseInt(arg || '3', 10) || 3, 1), 10);
        const data = await callSnowLuma('get_qzone_msg_list', { num });
        const list = Array.isArray(data?.msglist) ? data.msglist : [];
        qzoneState.lastMsgList = list;
        if (!list.length) return ['鲸鲸空间里还没有说说。'];
        const items = list.map((m, i) => {
          const t = String(m?.content ?? '').replace(/\s+/g, ' ').trim();
          const brief = t.length > 70 ? t.slice(0, 70) + '…' : t;
          return `${i + 1}. ${fmtQzoneTime(m?.time)}${m?.is_private ? '（私密）' : ''}\n${brief}\ntid ${m?.tid ?? '?'}`;
        });
        return packTextBlocks(`鲸鲸空间最近 ${list.length} 条（共 ${Number(data?.total ?? list.length)} 条）：`, items);
      }
      if (/^(动态|好友)$/.test(sub)) {
        const num = Math.min(Math.max(Number.parseInt(arg || '3', 10) || 3, 1), 10);
        const now = Date.now();
        let data;
        // 好友动态那个 CGI 有节流：60 秒内重复调用直接吃缓存，别去撞腾讯的限流。
        if (qzoneState.lastFeeds && now - qzoneState.lastFeedsAt < 60000) {
          data = qzoneState.lastFeeds;
          log('空间：好友动态命中 60 秒缓存');
        } else {
          try {
            data = await callSnowLuma('get_qzone_feeds', { page_num: 1, count: num });
            qzoneState.lastFeeds = data;
            qzoneState.lastFeedsAt = now;
          } catch (error) {
            // 这个 CGI 经常回 -10001 network busy（腾讯侧节流）。有旧缓存就用旧的，
            // 没有就直说人话，别把原始错误码丢给用户。
            const msg = String(error?.message ?? error);
            if (qzoneState.lastFeeds) {
              data = qzoneState.lastFeeds;
              log(`空间：动态被限流（${msg}），改用 ${Math.round((now - qzoneState.lastFeedsAt) / 1000)} 秒前的缓存`);
            } else {
              return [`腾讯把好友动态接口限流了（${msg.slice(0, 60)}）。过几分钟再发一次通常就正常。`];
            }
          }
        }
        const list = (Array.isArray(data?.feeds) ? data.feeds : []).slice(0, num);
        if (!list.length) return ['没读到好友动态（可能被限流了，过一会儿再试）。'];
        const selfUin = await getQzoneSelfUin();
        const items = list.map((f, i) => {
          const t = qzoneFeedText(f);
          const brief = t.length > 70 ? t.slice(0, 70) + '…' : t;
          const owner = Number(f?.uin ?? 0);
          const who = !owner ? '广告 / 非好友动态'
            : (selfUin && String(owner) === selfUin ? `${String(f?.nickname ?? '?')}（我自己）` : `${String(f?.nickname ?? '?')}（${owner}）`);
          return `${i + 1}. ${who} ${fmtQzoneTime(f?.time)}\n${brief || '（这条没有文字内容）'}${owner ? `\ntid ${f?.key ?? '?'}` : ''}`;
        });
        return packTextBlocks(`好友最近 ${list.length} 条动态：`, items);
      }
      if (/^(发|发布|发说说)$/.test(sub)) {
        if (!arg) return ['用法：指令 空间 发 <内容>'];
        // 支持「指令 空间 发 <内容> ｜私密」只发给自己看（联调/验收用，不打扰任何人）。
        let content = arg;
        let ugcRight = 1;
        const priv = content.match(/\s*[|｜]\s*(私密|仅自己可见|只给自己看)\s*$/);
        if (priv) { ugcRight = 64; content = content.slice(0, priv.index).trim(); }
        if (forceUgcRight) ugcRight = forceUgcRight;   // 调用方（说说自动）指定的可见范围优先
        if (!content) return ['用法：指令 空间 发 <内容> [｜私密]'];
        if (dryRun) return [`（试运行：这里会发一条说说「${content.slice(0, 40)}」${ugcRight === 64 ? '（仅自己可见）' : ''}，dry-run 不执行。）`];
        return [await postQzoneMsg({ content, ugcRight })];
      }
      if (/^(删|删除)$/.test(sub)) {
        if (!arg) return ['用法：指令 空间 删 <tid>（tid 用「指令 空间 说说」查）'];
        if (!/^[0-9a-zA-Z_-]{6,}$/.test(arg)) return ['tid 看起来不对，用「指令 空间 说说」把 tid 复制过来。'];
        if (dryRun) return [`（试运行：这里会删 tid ${arg}，dry-run 不执行。）`];
        await callSnowLuma('delete_qzone_msg', { tid: arg });
        auditQzone({ kind: 'delete', tid: arg });
        return [`已删除 tid ${arg}。`];
      }
      // ── 点赞 / 取消赞 / 评论：只做"你手动给了 tid 的那一条"，没有任何自动扫描 ──
      if (/^(赞|点赞)$/.test(sub) || /^(取消赞|取消点赞)$/.test(sub)) {
        const unlike = sub.startsWith('取消');
        const { tid, uin } = splitTidAndUin(arg);
        if (!tid) return [`用法：指令 空间 ${unlike ? '取消赞' : '赞'} <tid> [对方QQ]（tid 用「指令 空间 动态」查）`];
        const target = await resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 ${unlike ? '取消赞' : '赞'} ${tid} <对方QQ>`];
        if (target.error) return [target.error];
        const verb = unlike ? '取消赞' : '点赞';
        if (dryRun) return [`（试运行：会给 ${target.from} 的 tid ${tid} ${verb}，dry-run 不执行。）`];
        await callSnowLuma(unlike ? 'unlike_qzone' : 'like_qzone', {
          tid,
          ...(target.uin ? { target_uin: target.uin } : {}),
          abstime: target.abstime || 0
        });
        auditQzone({ kind: unlike ? 'unlike' : 'like', tid, targetUin: target.uin || '(自己)', from: target.from });
        return [`已${verb}：${target.from} 的 tid ${tid}。`];
      }
      if (/^(评|评论)$/.test(sub)) {
        const { tid, uin, rest } = splitTidAndUin(arg);
        if (!tid) return ['用法：指令 空间 评 <tid> [对方QQ] [内容]\n不给内容我就自己想一句，先给你看草稿；想直接发用「指令 空间 评发 <tid>」。'];
        const target = await resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 评 ${tid} <对方QQ> [内容]`];
        if (target.error) return [target.error];
        // 你给了内容 → 照发你的
        if (rest) {
          if (dryRun) return [`（试运行：会给 ${target.from} 的 tid ${tid} 评论「${rest.slice(0, 30)}」，dry-run 不执行。）`];
          await callSnowLuma('comment_qzone', { tid, content: rest, ...(target.uin ? { target_uin: target.uin } : {}) });
          auditQzone({ kind: 'comment', tid, targetUin: target.uin || '(自己)', content: rest, by: 'owner' });
          return [`已评论：${target.from} 的 tid ${tid}。`];
        }
        // 没给内容 → 让模型想；按当前模式决定"只出草稿"还是"想完直接发"
        const mode = qzoneCommentMode();
        if (dryRun) {
          return [mode === 'direct'
            ? `（试运行：当前是「想了就发」，这条会让模型写一句并**直接评论** ${target.from} 的 tid ${tid}，dry-run 不执行。）`
            : `（试运行：当前是「先看草稿」，这条会让模型写一句 ≤40 字的草稿给你看，不直接发。）`];
        }
        const made = await makeQzoneDraft(tid, target);
        if (!made.ok) return [made.why];
        if (mode === 'direct') {
          await callSnowLuma('comment_qzone', { tid, content: made.draft, ...(target.uin ? { target_uin: target.uin } : {}) });
          auditQzone({ kind: 'comment', tid, targetUin: target.uin || '(自己)', content: made.draft, by: 'ai-direct' });
          return [`已评论：${target.from} 的 tid ${tid} ——「${made.draft}」`];
        }
        qzoneState.pendingComment = { tid, uin: target.uin, from: target.from, draft: made.draft, at: Date.now() };
        return [`草稿：${made.draft}`, `发给 ${target.from}。回「指令 空间 发评论」我就发；想换一句再发一次「指令 空间 评 ${tid}」。`];
      }
      if (/^(评看|看草稿)$/.test(sub)) {
        const { tid, uin } = splitTidAndUin(arg);
        if (!tid) return ['用法：指令 空间 评看 <tid> [对方QQ]'];
        const target = await resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 评看 ${tid} <对方QQ>`];
        if (target.error) return [target.error];
        if (dryRun) return ['（试运行：会让模型写一句草稿给你看（不管当前模式），dry-run 不执行。）'];
        const made = await makeQzoneDraft(tid, target);
        if (!made.ok) return [made.why];
        qzoneState.pendingComment = { tid, uin: target.uin, from: target.from, draft: made.draft, at: Date.now() };
        return [`草稿：${made.draft}`, `回「指令 空间 发评论」我就发。`];
      }
      if (/^(评发|快评|直接评)$/.test(sub)) {
        const { tid, uin } = splitTidAndUin(arg);
        if (!tid) return ['用法：指令 空间 评发 <tid> [对方QQ]\n（想先看草稿用「指令 空间 评 <tid>」）'];
        const target = await resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 评发 ${tid} <对方QQ>`];
        if (target.error) return [target.error];
        if (dryRun) return [`（试运行：会让模型写一句并直接评论 ${target.from} 的 tid ${tid}，dry-run 不执行。）`];
        const made = await makeQzoneDraft(tid, target);
        if (!made.ok) return [made.why];
        await callSnowLuma('comment_qzone', { tid, content: made.draft, ...(target.uin ? { target_uin: target.uin } : {}) });
        auditQzone({ kind: 'comment', tid, targetUin: target.uin || '(自己)', content: made.draft, by: 'ai' });
        return [`已评论：${target.from} 的 tid ${tid} ——「${made.draft}」`];
      }
      if (/^(发评论|发草稿|确认评论)$/.test(sub)) {
        const p = qzoneState.pendingComment;
        const typed = String(arg ?? '').trim();
        if (!p && !typed) return ['没有待发的草稿。先发「指令 空间 评 <tid>」让我想一句，或者直接：指令 空间 发评论 <你要发的内容>'];
        const content = typed || p.draft;
        const tid = p?.tid ?? '';
        if (!tid) return ['没有待发的草稿，而且我也没有目标 tid。请用：指令 空间 评 <tid>（先出草稿）'];
        if (dryRun) return [`（试运行：会把「${content}」发到 ${p.from} 的 tid ${tid}，dry-run 不执行。）`];
        await callSnowLuma('comment_qzone', { tid, content, ...(p.uin ? { target_uin: p.uin } : {}) });
        auditQzone({ kind: 'comment', tid, targetUin: p.uin || '(自己)', content, by: typed ? 'owner-after-draft' : 'ai-confirmed' });
        qzoneState.pendingComment = null;
        return [`已评论：${p.from} 的 tid ${tid}。`];
      }
      if (/^(自动|自动化)$/.test(sub)) {
        const mode = qzoneAutoMode();
        const lim = qzoneAutoLimits(mode);
        qzoneAutoRollDay();
        if (mode === 'off') return ['空间自动化：关闭。双击桌面「空间自动化」可切成 仅点赞 / 点赞+评论 / 更活跃。'];
        const next = new Date(qzoneAuto.lastRunAt + lim.intervalMin * 60 * 1000).toLocaleString('zh-CN', { hour12: false });
        return [
          `空间自动化：${mode}｜每 ${lim.intervalMin} 分钟一轮，每轮最多赞 ${lim.maxLikesPerRound} 条、评论 ${lim.maxCommentsPerRound} 条（每天最多评 ${lim.maxCommentsPerDay} 条）`,
          `今天：赞 ${qzoneAuto.todayLikes}、评 ${qzoneAuto.todayComments}${qzoneAuto.lastError ? `｜上次异常：${qzoneAuto.lastError.slice(0, 60)}` : ''}`,
          `下一轮约 ${next}${qzoneAuto.cooldownUntil > Date.now() ? `（正被限流冷却，约 ${Math.ceil((qzoneAuto.cooldownUntil - Date.now()) / 60000)} 分钟）` : ''}`,
        ];
      }
      return [`不认识的子命令「${sub}」。\n${qzoneHelp()}`];
    } catch (error) {
      const msg = String(error?.message ?? error);
      log(`空间：${sub || '(空)'} 出错 ${msg}`);
      return [`⚠️ 空间接口出错：${msg.slice(0, 160)}`];
    }
  }

  async function handleQzone(key, raw) {
    const blocks = await qzoneReply(String(raw ?? '').trim(), false);
    for (const block of blocks) {
      for (const piece of splitTextForQQ(block)) { await sendToQQ(key, piece); await sleep(400); }
    }
  }

  // ── 对外暴露面：只有这些被 bridge.js（控制台路由 / handleIncoming）用到 ──
  return {
    qzoneHelp, qzoneReply, handleQzone, handleCommentFrame,
    qzoneAutoRound, qzoneAutoMode, qzoneAutoLimits, qzoneCommentMode,
    readQzonePostAuto, writeQzonePostAuto, loadQzonePostDrafts,
    qzoneAuto,
    QZONE_AUTO_MODES, QZONE_AUTO_FILE, QZONE_MODE_FILE, QZONE_UGC_RIGHTS,
  };
}
