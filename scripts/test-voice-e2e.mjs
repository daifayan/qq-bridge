// 端到端实测：复刻 bridge.js 里 maybeSendVoice 的完整路径
// （decide → synthesize → 经 OneBot 发 record 到 QQ），用真实 config 与真实模块，
// 确认生产链路在生产环境里能真的把语音送到老大 QQ。
// 用法：node scripts/test-voice-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTts } from '../src/tts.js';
import { toSpeakable, hasSpeakableContent } from '../src/tts-text.js';
import { decide, recordSpoken, createVoiceMemory } from '../src/voice-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';

const log = (m) => console.log(`[e2e] ${m}`);

function sendVoiceRecord(key, wav) {
  const [kind, id] = key.split(':');
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  const params =
    kind === 'private'
      ? { user_id: Number(id), message: [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }] }
      : { group_id: Number(id), message: [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }] };
  const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  return fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(25000)
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`语音发送失败：${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  });
}

const voiceCfg = cfg.voice || {};
const tts = createTts(voiceCfg, { log, rootDir: ROOT });
// 用独立临时记忆文件，避免和运行中桥接的 state/voice.json 互相覆盖
const testMemPath = path.join(STATE_DIR, 'voice-e2e-test.json');
const voiceMemory = createVoiceMemory(testMemPath);

async function run(text, force = false) {
  const spoken = toSpeakable(text, { maxChars: Number(voiceCfg.maxChars) || 60 });
  if (!hasSpeakableContent(spoken)) {
    log(`「${text.slice(0, 20)}…」清洗后无可念内容，跳过`);
    return false;
  }
  // 默认 rand 真实，force=true 时强制命中（让骰子必然 <= 阈值）
  const decision = decide({
    key: ownerKey,
    text: spoken,
    cfg: { ...voiceCfg, probability: force ? 1 : voiceCfg.probability },
    memory: voiceMemory.data,
    ownerKey,
    rand: force ? () => 0 : Math.random
  });
  log(`判定「${spoken.slice(0, 18)}…」→ ${decision.speak ? '发语音' : '跳过'}（${decision.reason}）`);
  if (!decision.speak) return false;
  const started = Date.now();
  const audio = await tts.synthesize(decision.text, { timeoutMs: Number(voiceCfg.timeoutMs) || 25000 });
  await sendVoiceRecord(ownerKey, audio.wav);
  recordSpoken(voiceMemory.data, ownerKey);
  voiceMemory.save();
  const dur = (audio.wav.length - 44) / 2 / (audio.sampleRate || 22050);
  log(`✅ 已发语音：${decision.text.length}字 / ${dur.toFixed(1)}s 音频 / 合成 ${Date.now() - started}ms`);
  return true;
}

const ok = await run('老大，语音功能实测跑通啦，以后你问我话，我偶尔会用声音回你。', true);
// 第二条：超长应被策略拒（触发 maxChars 截断后仍可能发，这里用纯超长验证门控）
await run('这是一条用来验证长文本门控的回复，它超过了最大字数限制，按理说桥接只会发文字而不会补语音，或者至少会被概率和长度规则约束住，确保不会刷屏。', false);

tts.close();
fs.rmSync(testMemPath, { force: true });
log(ok ? '端到端实测：语音已真实送达老大 QQ ✅' : '端到端实测：未发出（检查上面的原因）');
process.exit(ok ? 0 : 1);
