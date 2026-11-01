// 有界日志写入器。
//
// 旧实现每写一行都会同步读回整个日志、split 全部内容，超限后整份重写。
// 日志密集时这会把消息收发主线程拖慢几个数量级。这里做两件事：
// 1. 首次写入才读一次现有行数，之后用内存计数，超限时批量裁剪；
// 2. 同一轮事件循环里的多行合并成一次 append，避免每行一次同步磁盘写。
// 单行最多延迟一个定时器周期（0ms）落盘；退出前由调用方 flush。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TRIM_SLACK = 100;
const MAX_QUEUED_LINES = 256;

function countLines(text) {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (line) count += 1;
  }
  return count;
}

/**
 * @param {{file: string, maxLines: number, trimSlack?: number}} opts
 */
export function createBoundedLineWriter({ file, maxLines, trimSlack = DEFAULT_TRIM_SLACK }) {
  if (!file) throw new Error('日志文件路径不能为空');
  const limit = Math.max(1, Math.floor(Number(maxLines) || 1));
  const slack = Math.max(0, Math.floor(Number(trimSlack) || 0));
  let lineCount = 0;
  let initialized = false;
  let directoryReady = false;
  let queued = [];
  let flushTimer = null;

  function initialize() {
    try {
      lineCount = countLines(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      lineCount = 0;
    }
    initialized = true;
  }

  function trim() {
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const kept = lines.slice(-limit);
    fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
    lineCount = kept.length;
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queued.length) return;
    const batch = queued;
    queued = [];
    try {
      if (!directoryReady) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        directoryReady = true;
      }
      if (!initialized) initialize();
      fs.appendFileSync(file, `${batch.join('\n')}\n`, 'utf8');
      lineCount += batch.length;
      if (lineCount > limit + slack) trim();
    } catch (error) {
      // 日志写不进去时不能再调用 log（会递归）；直接打到 stderr，至少不静默。
      console.error(`[log-utils] 写入 ${file} 失败（丢弃 ${batch.length} 行）：${error?.message ?? error}`);
    }
  }

  function scheduleFlush() {
    if (flushTimer || !queued.length) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 0);
  }

  return {
    append(line) {
      queued.push(String(line));
      // 极端刷屏时先落盘，避免内存无限增长；正常情况一轮事件循环只写一次。
      if (queued.length >= MAX_QUEUED_LINES) flush();
      else scheduleFlush();
    },
    flush,
    get lineCount() {
      return lineCount + queued.length;
    }
  };
}
