// 刷屏 / 复读守卫（纯本地判断，零 token 成本）
//
// 来源：2026-11-01 移植自阿深的 loop-guard.js，改了两处：
//   1. 不再骂人——命中只静默丢弃（可选回一句温和提醒，默认关），免得把群友激得更来劲；
//   2. 阈值和文案提到常量区，方便按群调。
//
// 为什么值得挂：群友复读/刷屏时，每一条都会被 appendSocialV2Message 入库并触发唤醒，
// 那都是真金白银的 token。这里在**入库之前**就丢掉，连记忆都不污染。
//
// 三个判据（任一命中即丢）：
//   ① 内容明显是「循环指令」（重复同一字符、念 N 遍、死循环…）
//   ② 60 秒内同一内容出现 DUP_THRESHOLD 次
//   ③ 60 秒内同一人发了 FLOOD_THRESHOLD 条
import crypto from 'node:crypto';

const WINDOW_MS = 60_000;       // 观察窗口 1 分钟
const DUP_THRESHOLD = 3;        // 同一内容出现 3 次即判复读
const FLOOD_THRESHOLD = 8;      // 同一人 1 分钟 8 条即判刷屏

/** key -> [{ hash, at, sender }] */
const recentByKey = new Map();

/** 循环/刷屏的典型特征（中文场景） */
const LOOP_PATTERNS = [
  /^(.)\1{10,}$/,                                   // 重复同一字符
  /(.{2,20})\1{4,}/,                                // 同一片段重复 5 次
  /(?:再|重复|继续|一直|无限)\s*(?:说|发|执行|输出|重复)?/,
  /(?:for\s*\(|while\s*\(|loop|递归|死循环)/i,
  /(?:把上面|上面那句|这句话).{0,6}(?:重复|再说|发)/,
  /(?:念|输出|说)\s*\d+\s*(?:遍|次)/,
  /(?:自我复制|无限循环|一直循环|连发|刷屏)/,
];

function hashOf(s) {
  const t = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);
}

/**
 * 检查一条群消息是不是刷屏/复读。
 * @param {string} key 会话 key（group:xxx）
 * @param {string} text 本条消息的纯文本
 * @param {string|number} senderId 发送者 QQ
 * @returns {{loop: boolean, reason?: string}}
 */
export function checkLoop(key, text, senderId = '') {
  const now = Date.now();
  const t = String(text || '').trim();
  if (!t) return { loop: false };

  // ① 循环指令特征
  for (const re of LOOP_PATTERNS) {
    if (re.test(t)) return { loop: true, reason: '循环指令特征' };
  }

  // ②③ 基于滑动窗口
  const arr = (recentByKey.get(key) || []).filter((x) => now - x.at < WINDOW_MS);
  const h = hashOf(t);
  arr.push({ hash: h, at: now, sender: String(senderId) });
  recentByKey.set(key, arr);

  const sameCount = arr.filter((x) => x.hash === h).length;
  if (sameCount >= DUP_THRESHOLD) {
    return { loop: true, reason: `同一内容 ${sameCount} 次/分钟` };
  }
  if (senderId) {
    const sameSender = arr.filter((x) => x.sender === String(senderId)).length;
    if (sameSender >= FLOOD_THRESHOLD) {
      return { loop: true, reason: `同一人 ${sameSender} 条/分钟` };
    }
  }
  return { loop: false };
}

/** 清空某个会话的窗口（切模式 / 重置时用，避免旧计数误伤新对话）。 */
export function resetLoopState(key) {
  if (key) recentByKey.delete(String(key));
  else recentByKey.clear();
}

/** 清理过期数据，防止内存无界增长。由桥接的定期巡检调用即可。 */
export function pruneLoopState() {
  const now = Date.now();
  for (const [k, arr] of recentByKey) {
    const kept = arr.filter((x) => now - x.at < WINDOW_MS);
    if (kept.length) recentByKey.set(k, kept);
    else recentByKey.delete(k);
  }
}

export const LOOP_GUARD_LIMITS = { WINDOW_MS, DUP_THRESHOLD, FLOOD_THRESHOLD };
