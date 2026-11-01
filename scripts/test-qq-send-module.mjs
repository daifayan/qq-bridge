// src/qq-send.js 的离线回归：不读真实 config、不发 QQ、不碰网络。
// 盯三件事：依赖注入缺项、暴露面缺失、以及"发送通道"里最容易静默坏掉的分条/闸门逻辑。
import { createQQSend } from '../src/qq-send.js';

const noop = () => {};
let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

function makeCtx(over = {}) {
  return {
    cfg: { voice: { enabled: false }, ownerQQ: '0', social: {} },
    log: noop,
    ROOT: '.',
    STATE_DIR: 'state',
    sendQueue: { chain: Promise.resolve() },
    sendToQQ: async () => {},
    appendActivity: noop,
    escapeCqText: (s) => s,
    randInt: (a) => a,
    sessionPolicy: () => ({}),
    readRoleState: () => ({}),
    isSessionAllowedInCurrentMode: () => true,
    redactKnownTokensOnly: (s) => s,
    hasKnownAgentToken: () => false,
    getSocialV2State: () => ({}),
    getState: () => ({ sessions: {} }),
    getMode: () => 'chat',
    getBot: () => ({}),
    getVideoStoryboard: () => ({ available: () => false }),
    getMessageMediaStore: () => new Map(),
    getSocialV2: () => ({ conversations: new Map() }),
    ...over,
  };
}

console.log('\n[1] 依赖注入缺项 → 立刻抛（fail-closed）');
for (const key of ['cfg', 'log', 'sendQueue', 'getBot', 'randInt', 'getState']) {
  let threw = '';
  try { createQQSend({ ...makeCtx(), [key]: undefined }); } catch (e) { threw = e.message; }
  must(`缺 ${key} 时抛错`, /ctx 缺少/.test(threw), threw);
}

console.log('\n[2] 暴露面：桥接 / 控制台 / social 层要用的一个都不能少');
const q = createQQSend(makeCtx());
for (const k of ['singleLineForQQ', 'splitLongSegment', 'planSocialTimeline', 'sendBurstToQQ', 'onebotSend',
  'tts', 'voiceCfg', 'voiceMemory', 'sendVoiceRecord', 'planVoice', 'toneFor', 'enqueueVoice', 'maybeSendVoice',
  'mimeFromBuffer', 'mimeFromUrl', 'getImageDimensions', 'fetchOneBotImage', 'resolveMediaList', 'fetchMediaData',
  'mediaHintFor', 'findMessageMedia', 'computeGapsV2', 'sendMessagesV2', 'shouldAuditKey', 'captureSendGuard',
  'shouldBlockSilentReply', 'auditAndSend']) {
  must(`暴露 ${k}`, q[k] !== undefined);
}

console.log('\n[3] 纯函数行为（不触网）');
must('singleLineForQQ 压平换行', q.singleLineForQQ('a\n\n b  c') === 'a b c');
must('mimeFromBuffer PNG', q.mimeFromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) === 'image/png');
must('mimeFromBuffer JPEG 兜底', q.mimeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'image/jpeg');
must('mimeFromUrl 认扩展名', q.mimeFromUrl('https://x.invalid/a.webp') === 'image/webp');
must('splitLongSegment 不丢内容', q.splitLongSegment('短句', 10).join('').replace(/\s/g, '').includes('短句'));
{
  const gaps = q.computeGapsV2(['一', '二', '三'], 'fixed', 100, [], {});
  must('computeGapsV2 返回 n-1 个间隔', Array.isArray(gaps) && gaps.length === 2, JSON.stringify(gaps));
}
must('shouldAuditKey 对群聊返回布尔', typeof q.shouldAuditKey('group:1') === 'boolean');
must('shouldBlockSilentReply 对未知会话不阻塞', q.shouldBlockSilentReply('private:999999') === false);

console.log('\n[4] 发送前的令牌闸门（2026-11-01 事故回归）');
// 事故：qq-send.js 直接引用 bridge 的 KNOWN_AGENT_TOKENS，模块里没有这个变量，
// 每条消息都在 onebotSend 里 ReferenceError。回归点有两个：
//   ① selfTest 必须存在且能跑通（桥接启动时会调）
//   ② 判断必须走注入函数，不能再去碰那个 Set 的名字
must('selfTest 可调用', typeof q.selfTest === 'function');
{
  let threw = '';
  try { q.selfTest(); } catch (e) { threw = e.message; }
  must('selfTest 正常返回', threw === '', threw);
}
{
  // 注入一个"认得假令牌"的判断函数，确认 onebotSend 真的会拦
  const SECRET = 'agent-token-abc123';
  const q2 = createQQSend(makeCtx({ hasKnownAgentToken: (s) => String(s ?? '').includes(SECRET) }));
  let threw = '';
  try {
    await q2.onebotSend('private', 1, `泄露 ${SECRET}`);
  } catch (e) { threw = e.message; }
  must('含令牌的消息被拦截', /会话令牌/.test(threw), threw);
}
{
  // 反过来：不含令牌时必须放行（不能因为改调用方式而误拦一切）
  const q3 = createQQSend(makeCtx({ hasKnownAgentToken: () => false, getBot: () => ({ sendPrivateMessage: async () => ({ message_id: 1 }) }) }));
  let err = '';
  try { await q3.onebotSend('private', 1, '普通一句话'); } catch (e) { err = e.message; }
  must('普通消息不被令牌闸门拦下', !/会话令牌/.test(err), err);
}
{
  // 注入缺失时必须 fail-closed，而不是悄悄放行
  let threw = '';
  try { createQQSend({ ...makeCtx(), hasKnownAgentToken: undefined }); } catch (e) { threw = e.message; }
  must('缺 hasKnownAgentToken 时抛错', /ctx 缺少/.test(threw), threw);
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
