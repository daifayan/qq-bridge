/**
 * 清未读积压（管理端，只清"未读"标记）。
 *
 *   node scripts/clear-unread.mjs              # 所有会话里凡是有未读的都清
 *   node scripts/clear-unread.mjs group:123    # 只清指定会话
 *   node scripts/clear-unread.mjs --dry        # 只看不动
 *
 * 为什么需要它：AI 潜水久了，群里/私聊的消息会堆成"未读"。它一被叫醒就会看到
 * 一大坨过期消息，容易对着一个礼拜前的话回话。清掉未读 = "这些我看过了"，
 * **不删上下文**（recentMessages 保留），也不改唤醒配置。
 *
 * 只能走控制台 API（未读是内存态）：POST /api/socialV2/mark-read
 * ⚠️ 若某个会话"刚有人说话"（5 分钟内）且处于潜水配置，桥接的沉睡前观察闸门会拒绝，
 *    脚本会把桥接的原话打出来（等几分钟再跑一次即可）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const dry = process.argv.includes('--dry');
const only = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const token = String(cfg.consoleToken || '');
const base = `http://127.0.0.1:${cfg.consolePort || 3100}`;

const api = async (p, init = {}) => {
  const res = await fetch(base + p, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-console-token': token, ...(init.headers ?? {}) },
  });
  const body = await res.text();
  try { return { status: res.status, json: JSON.parse(body) }; } catch { return { status: res.status, json: null, body }; }
};

let states;
try {
  states = await api('/api/socialV2/states');
} catch (error) {
  console.error(`桥接控制台连不上（${base}）：${error?.message ?? error}`);
  console.error('先确认桥接在跑（双击桌面「DeepSeek 全家桶」）。');
  process.exit(1);
}
if (states.status !== 200) {
  console.error(`桥接返回 HTTP ${states.status}：${states.body ?? ''}`);
  process.exit(1);
}

const keys = (states.json?.conversations ?? []).map((c) => c.key);
const targets = only ? keys.filter((k) => k === only) : keys;
if (!targets.length) {
  console.error(only ? `没找到会话 ${only}（现有：${keys.join(', ')}）` : '没有任何会话');
  process.exit(1);
}

let cleared = 0;
let total = 0;
for (const key of targets) {
  const s = await api('/api/socialV2/state?key=' + encodeURIComponent(key));
  const unread = Number(s.json?.unreadCount) || 0;
  if (!unread) {
    console.log(`  ${key.padEnd(22)} 无未读`);
    continue;
  }
  if (dry) {
    console.log(`  ${key.padEnd(22)} 未读 ${unread} 条（--dry，未动）`);
    total += unread;
    continue;
  }
  const r = await api('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key }) });
  if (r.json?.ok) {
    const n = Number(r.json.markedCount) || unread;
    console.log(`  ${key.padEnd(22)} 已清 ${n} 条`);
    cleared += n;
  } else {
    console.log(`  ${key.padEnd(22)} ❌ 清失败：${r.json?.error ?? r.status}`);
  }
}

console.log('');
console.log(dry ? `共 ${total} 条未读（未改动）` : `清掉 ${cleared} 条未读（上下文与唤醒配置都没动）`);
