// src/qzone.js 的离线回归：不读真实 config、不发 QQ、不碰 SnowLuma。
// 用假 ctx 驱动，专门盯"抽出 bridge.js 之后"最容易坏的三件事：
//   1. 依赖注入缺项（桥接改名/改作用域时）；
//   2. 暴露面缺失（控制台路由、handleIncoming、事件流要用的符号）；
//   3. 评论会话的事件帧收尾链路（挂在桥接"未知会话"分支里，坏了不会报错只会超时）。
import { createQzone } from '../src/qzone.js';

const noop = () => {};
let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

function makeCtx(over = {}) {
  const ctx = {
    cfg: { ownerQQ: '0', socialV2: { sticker: {} }, dsh: {}, snowluma: {} },
    log: noop,
    api: {
      sessions: { create: async () => ({ sessionId: 'fake-s1' }), prompt: async () => ({ result: { ok: true } }) },
      workspace: { create: async () => ({ created: false }) },
      events: { follow: noop },
    },
    STATE_DIR: 'state',
    ROOT: '.',
    currentRoleHint: () => '（测试角色卡）',
    ensureChatModel: async () => {},
    sendToQQ: async () => {},
    sleep: async () => {},
    readJsonSafe: () => null,
    atomicWriteJson: noop,
    recordRecentAction: noop,
    recentActions: [],
    getStickerEntries: () => [],
    callSnowLuma: async (action) => { throw new Error('离线测试不发真实请求：' + action); },
    ...over,
  };
  return ctx;
}

console.log('\n[1] 依赖注入缺项 → 必须立刻抛错（fail-closed，不要等到运行时 undefined）');
for (const key of ['cfg', 'log', 'api', 'sendToQQ', 'callSnowLuma', 'getStickerEntries']) {
  let threw = '';
  try { createQzone({ ...makeCtx(), [key]: undefined }); } catch (e) { threw = e.message; }
  must(`缺 ${key} 时抛错`, /ctx 缺少/.test(threw), threw);
}

console.log('\n[2] 暴露面：桥接控制台 / handleIncoming / 事件流要用的符号一个都不能少');
const q = createQzone(makeCtx());
for (const k of ['qzoneHelp', 'qzoneReply', 'handleQzone', 'handleCommentFrame',
  'qzoneAutoRound', 'qzoneAutoMode', 'qzoneAutoLimits', 'qzoneCommentMode',
  'readQzonePostAuto', 'writeQzonePostAuto', 'loadQzonePostDrafts', 'qzoneAuto',
  'QZONE_AUTO_MODES', 'QZONE_AUTO_FILE', 'QZONE_MODE_FILE', 'QZONE_UGC_RIGHTS']) {
  must(`暴露 ${k}`, q[k] !== undefined);
}

console.log('\n[3] 纯函数行为（不触网）');
must('qzoneAutoMode 默认 off', q.qzoneAutoMode() === 'off');
must('qzoneAutoLimits(off) 全 0', q.qzoneAutoLimits('off').intervalMin === 0);
must('qzoneAutoLimits(comment) 有评论额度', q.qzoneAutoLimits('comment').maxCommentsPerDay === 5);
must('QZONE_AUTO_MODES 四档齐全', q.QZONE_AUTO_MODES.join(',') === 'off,like,comment,active');
must('QZONE_UGC_RIGHTS 含 64（仅自己可见）', q.QZONE_UGC_RIGHTS.has(64));
must('qzoneHelp 是字符串且含用法', typeof q.qzoneHelp() === 'string' && q.qzoneHelp().includes('空间'));
must('loadQzonePostDrafts 返回数组', Array.isArray(q.loadQzonePostDrafts()));
must('readQzonePostAuto 有 publish 字段', typeof q.readQzonePostAuto().publish === 'boolean');

console.log('\n[4] 事件帧收尾：不能吞掉别人的帧，也不能漏掉自己的');
must('陌生会话 → false（不吞别人的帧）', q.handleCommentFrame({ sessionId: 'other', event: { type: 'turn/start' } }) === false);
{
  // 持久化会话 id 会被初始化块加进 SessionIds —— 复刻桥接重启后继续用同一会话的情形
  const q2 = createQzone(makeCtx({ readJsonSafe: () => ({ sessionId: 'fake-s1' }) }));
  must('评论会话 turn/start → true', q2.handleCommentFrame({ sessionId: 'fake-s1', event: { type: 'turn/start', data: { turn: 't1' } } }) === true);
  let ended = 'no';
  q2.handleCommentFrame({
    sessionId: 'fake-s1',
    event: { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } },
  });
  ended = 'ok';
  must('评论会话 turn/end 不抛错', ended === 'ok');
  must('收尾后不该再持有收集器', q2.handleCommentFrame({ sessionId: 'nope', event: {} }) === false);
}

console.log('\n[5] 端到端（离线）：说说列表 → 评论草稿 → 事件帧唤醒（2026-11-01 抽模块时坏过的那条链）');
{
  const q5 = createQzone(makeCtx({
    readJsonSafe: () => ({ sessionId: 'fake-s1' }),
    callSnowLuma: async (action) => (
      action === 'get_qzone_msg_list'
        ? { msglist: [{ tid: 't1', content: '测试说说内容', time: Math.floor(Date.now() / 1000) }] }
        : {}
    ),
  }));
  const listed = await q5.qzoneReply('说说 2');
  must('说说列表读到内容', String(listed?.[0] ?? '').includes('测试说说内容'));

  const pending = q5.qzoneReply('评 t1');
  await new Promise((r) => setTimeout(r, 50));   // 等 waiter 注册完
  q5.handleCommentFrame({ sessionId: 'fake-s1', event: { type: 'turn/start', data: { turn: 'r1' } } });
  q5.handleCommentFrame({
    sessionId: 'fake-s1',
    event: { type: 'assistant/message', data: { turn: 'r1', message: { content: [{ type: 'text', text: '这是一句草稿' }] } } },
  });
  q5.handleCommentFrame({ sessionId: 'fake-s1', event: { type: 'turn/end', data: { turn: 'r1', reason: { kind: 'completed' } } } });
  const lines = await pending;
  must('端到端拿到草稿', String(lines?.[0] ?? '').includes('草稿'), String(lines?.[0] ?? '').slice(0, 40));
  must('草稿内容来自模型输出', String(lines?.[0] ?? '').includes('这是一句草稿'));
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
