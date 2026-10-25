// 去重契约测试：验证「replaceText=true 时，发语音的那条不再发同样的文字」。
// 用桥接真实的 decide / toSpeakable / hasSpeakableContent 策略引擎，
// 复刻 auditAndSend 分支，用 mock 统计 sendToQQ（文字）与 sendVoiceRecord（语音）的调用次数。
// 用法：node scripts/test-voice-replace.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../src/voice-policy.js';
import { toSpeakable, hasSpeakableContent } from '../src/tts-text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';

// 与 bridge.js 里 planVoice 完全一致的实现（直接复用真实策略引擎）
function planVoice(key, rawText, voiceCfg, memory) {
  if (!voiceCfg.enabled) return null;
  const maxChars = Number(voiceCfg.maxChars) || 60;
  // 原文超长：只发文字、不补语音（与 bridge.js 一致，防止替代模式丢内容）
  if (String(rawText ?? '').trim().length > maxChars) return null;
  let spoken;
  try {
    spoken = toSpeakable(rawText, { maxChars });
  } catch {
    return null;
  }
  if (!hasSpeakableContent(spoken)) return null;
  const decision = decide({ key, text: spoken, cfg: voiceCfg, memory, ownerKey });
  if (!decision.speak) return null;
  return { decision, spoken, replace: !!voiceCfg.replaceText };
}

// 复刻 auditAndSend 的分支：replace 时只发语音，否则发文字（命中再补语音）
function simulate(text, voiceCfg, memory, mocks) {
  const plan = planVoice(ownerKey, text, voiceCfg, memory);
  if (plan && plan.replace) {
    mocks.enqueueVoice();
  } else {
    mocks.sendToQQ(text);
    if (plan) mocks.enqueueVoice();
  }
}

let failures = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`✅ ${name}`);
  else {
    console.log(`❌ ${name} — ${detail}`);
    failures++;
  }
}

// 概率性判定：用固定 rand 让短句必中
const memory = {};
const baseCfg = { ...cfg.voice, probability: 1, cooldownMs: 0, hourlyCapPerConv: 99, dailyCap: 99 };

console.log('== 场景1：短句 + replaceText=true → 应只发语音、不重复发文字 ==');
{
  const mocks = { textCalls: 0, voiceCalls: 0, sendToQQ() { this.textCalls++; }, enqueueVoice() { this.voiceCalls++; } };
  simulate('老大，我在这儿呢，语音去重测一下！', { ...baseCfg, replaceText: true }, memory, mocks);
  assert('文字发送次数 = 0', mocks.textCalls === 0, `实际 ${mocks.textCalls}`);
  assert('语音发送次数 = 1', mocks.voiceCalls === 1, `实际 ${mocks.voiceCalls}`);
}

console.log('== 场景2：同样的短句 + replaceText=false → 旧行为：文字+语音都发 ==');
{
  const mocks = { textCalls: 0, voiceCalls: 0, sendToQQ() { this.textCalls++; }, enqueueVoice() { this.voiceCalls++; } };
  simulate('老大，我在这儿呢，语音去重测一下！', { ...baseCfg, replaceText: false }, memory, mocks);
  assert('文字发送次数 = 1', mocks.textCalls === 1, `实际 ${mocks.textCalls}`);
  assert('语音发送次数 = 1', mocks.voiceCalls === 1, `实际 ${mocks.voiceCalls}`);
}

console.log('== 场景3：长句（>maxChars）→ 不补语音，只发文字 ==');
{
  const mocks = { textCalls: 0, voiceCalls: 0, sendToQQ() { this.textCalls++; }, enqueueVoice() { this.voiceCalls++; } };
  const longText = '这是一段明显超过六十个字的超长回复内容，用来验证当回复太长时桥接应当只发送文字而不会补发语音，从而避免任何可能的重复或截断带来的信息丢失问题。';
  simulate(longText, { ...baseCfg, replaceText: true }, memory, mocks);
  assert('文字发送次数 = 1', mocks.textCalls === 1, `实际 ${mocks.textCalls}`);
  assert('语音发送次数 = 0', mocks.voiceCalls === 0, `实际 ${mocks.voiceCalls}`);
}

console.log('== 场景4：空/纯动作提示 → 不念也不发语音 ==');
{
  const mocks = { textCalls: 0, voiceCalls: 0, sendToQQ() { this.textCalls++; }, enqueueVoice() { this.voiceCalls++; } };
  simulate('（小声）', { ...baseCfg, replaceText: true }, memory, mocks);
  assert('文字发送次数 = 1（动作提示仍走文字）', mocks.textCalls === 1, `实际 ${mocks.textCalls}`);
  assert('语音发送次数 = 0', mocks.voiceCalls === 0, `实际 ${mocks.voiceCalls}`);
}

console.log(failures === 0 ? '\n全部通过：去重逻辑正确 ✅' : `\n有 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
