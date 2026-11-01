// 极小的异步工具：原先定义在 bridge.js 顶层，2026-11-01 抽出发送模块时移到这里，
// 避免 bridge.js ↔ qq-send.js 互相 import 造成循环依赖。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SEND_TIMEOUT_MS = 15000;

/** 给一个 promise 加超时（超时抛中文错误，label 用于定位是哪一步）。 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
