// 语音策略 + 文本清洗的纯函数回归测试（不依赖模型 / SnowLuma / QQ）。
// 用法：node scripts/test-voice-policy.mjs
import { toSpeakable, normalizeNumbers, hasSpeakableContent } from '../src/tts-text.js';
import { decide, emotionScore, recordSpoken, looksUnspeakable } from '../src/voice-policy.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── 文本清洗 ─────────────────────────────────────────────────────────────
assert('去粗体/斜体', toSpeakable('**收到啦** *好的*') === '收到啦好的');
assert('去行内代码', toSpeakable('用 `npm i` 装') === '用，装');
assert('代码块整段丢弃', toSpeakable('前\n```js\nx=1\n```\n后') === '前，后');
assert('链接换成"链接"', toSpeakable('看 https://a.com/x 这里') === '看链接这里');
assert('括号动作不念', toSpeakable('好的（小声）走吧') === '好的，走吧');
assert('emoji 不念', toSpeakable('好耶🐋！') === '好耶！');
assert('中文标点前不留空格', toSpeakable('好 ！') === '好！');
assert('中文字之间不留空格', toSpeakable('三 个 点') === '三个点');

// ── 数字读法 ─────────────────────────────────────────────────────────────
assert('个位数', normalizeNumbers('有3个') === '有三个');
assert('十位', normalizeNumbers('12点') === '十二点');
assert('一十 → 十', normalizeNumbers('15') === '十五');
assert('百位带零', normalizeNumbers('105') === '一百零五');
assert('千位', normalizeNumbers('2026') === '二千零二十六');
assert('年份逐位念', normalizeNumbers('2026 年') === '二零二六 年');
assert('小数', normalizeNumbers('3.5') === '三点五');
assert('百分比', normalizeNumbers('50%') === '百分之五十');
assert('万级', normalizeNumbers('12000') === '一万二千');
assert('零', normalizeNumbers('0') === '零');

assert('纯标点不念', hasSpeakableContent('。。。') === false);
assert('有汉字可念', hasSpeakableContent('嗯') === true);

// ── 情绪分 ───────────────────────────────────────────────────────────────
assert('平淡句子情绪低', emotionScore('今天下午三点开会') < 0.15);
assert('语气词情绪高', emotionScore('好耶！好耶呀～') > 0.3);

// ── 不该念的 ─────────────────────────────────────────────────────────────
assert('系统提示不念', looksUnspeakable('⚠️ 发送失败') !== '');
assert('含链接不念', looksUnspeakable('看 https://a.com') !== '');
assert('含代码不念', looksUnspeakable('跑 ```js```') !== '');

// ── 策略 ─────────────────────────────────────────────────────────────────
const base = { enabled: true, scope: 'private', maxChars: 20, probability: 0.5, cooldownMs: 60000, dailyCap: 5, hourlyCapPerConv: 2 };
const key = 'private:10001';
const ownerKey = 'private:10001';
const never = () => 0.99;
const always = () => 0;

assert('关闭时不说', decide({ key, text: '好呀', cfg: { ...base, enabled: false }, memory: {}, rand: always }).speak === false);
assert('群聊默认不说', decide({ key: 'group:20002', text: '好呀', cfg: base, memory: {}, rand: always }).speak === false);
assert('scope=all 时群聊可说', decide({ key: 'group:20002', text: '好呀', cfg: { ...base, scope: 'all' }, memory: {}, rand: always }).speak === true);
assert('scope=owner 只对主人', decide({ key: 'private:999', text: '好呀', cfg: { ...base, scope: 'owner' }, memory: {}, ownerKey, rand: always }).speak === false);
assert('超长只发文字', decide({ key, text: '这是一句特别特别长的话'.repeat(3), cfg: base, memory: {}, rand: always }).speak === false);
assert('掷骰未中不发', decide({ key, text: '好呀', cfg: { ...base, probability: 0, emotionBoost: 0 }, memory: {}, rand: never }).speak === false);

const mem = {};
assert('首次满足条件会说', decide({ key, text: '好呀', cfg: { ...base, probability: 1 }, memory: mem, rand: always }).speak === true);

recordSpoken(mem, key, Date.now());
const afterOne = decide({ key, text: '好呀', cfg: { ...base, probability: 1 }, memory: mem, rand: always });
assert('冷却中不说', afterOne.speak === false && afterOne.reason === '冷却中');

const later = Date.now() + 61000;
recordSpoken(mem, key, later);
recordSpoken(mem, key, later + 1);
const capped = decide({ key, text: '好呀', cfg: { ...base, probability: 1 }, memory: mem, rand: always, now: later + 62000 });
assert('本小时配额用完不说', capped.speak === false, capped.reason);

const dailyMem = { day: new Date().toISOString().slice(0, 10), countToday: 5, conv: {} };
assert('每日上限拦住', decide({ key, text: '好呀', cfg: { ...base, probability: 1 }, memory: dailyMem, rand: always }).speak === false);

const quiet = { ...base, probability: 1, quietHours: [0, 24] };
const noon = new Date();
noon.setHours(12, 0, 0, 0);
assert('静音时段不说', decide({ key, text: '好呀', cfg: quiet, memory: {}, rand: always, now: noon.getTime() }).speak === false);

// 跨天自动重置计数
const staleMem = { day: '2000-01-01', countToday: 99, conv: {} };
assert('跨天重置计数', decide({ key, text: '好呀', cfg: { ...base, probability: 1 }, memory: staleMem, rand: always }).speak === true && staleMem.countToday === 0);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
