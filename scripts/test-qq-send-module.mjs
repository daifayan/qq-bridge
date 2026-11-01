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

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
