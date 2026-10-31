// 视频分镜（QQ 视频 → 宫格图 + 时间码清单）
//
// 为什么要有这一层：桥接原来把视频消息段渲染成一行 `[视频]` 就完事了，
// 模型根本不知道里面有什么。这里借 dsh-video-storyboard 的思路（一张宫格图
// 384 token 封顶 + 一份按时间对齐的文本清单），把"看过视频"变成模型能消费的
// 两种输入：一张 PNG（走多模态）+ 一段文字（走上下文）。
//
// 分工：
//   - 插件负责重活（探测、扫切点、取帧、拼图、烧格号、算响度）；
//   - 本文件只负责：把 QQ 的 url 落成本地文件 → 起子进程 → 收图收文字 → 清理。
//
// 失败策略：一律抛错，由调用方降级成 `[视频（没能解析）]` 之类的文字占位，
// 绝不静默假装看过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeFetchBinary } from './safe-fetch.js';

const DEFAULTS = {
  enabled: true,
  cells: 9,                       // 0 = 让插件按画面密度自己决定
  maxBytes: 40 * 1024 * 1024,     // 单个视频下载上限
  timeoutMs: 150_000,             // 单次分镜总时限（4K 慢机器留足余量）
  transcript: 'off',              // off | auto（auto 需要配好 ASR，否则也会退化成空）
  keepDays: 2,                    // 分镜产物保留天数
  maxTextChars: 4000              // 清单进上下文的字符上限
};

/** 找到 dsh-video-storyboard 的 CLI 入口；找不到返回 null（不是抛错，调用方要能降级）。 */
export function resolveStoryboardBin(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_VIDEO_STORYBOARD_BIN,
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-video-storyboard', 'bin', 'storyboard.mjs'),
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'bin', 'storyboard.mjs')
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/** 只在 state 目录里生成文件名：QQ 的 file 字段完全不可信，不能让它参与拼路径。 */
function safeBaseName(seed) {
  const hash = String(seed ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'video';
  return `${Date.now().toString(36)}-${hash}`;
}

function runCli(bin, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`分镜超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split('\n').slice(-3).join(' / ');
        reject(new Error(`分镜进程退出码 ${code}${tail ? `：${tail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * @param {{cfg?: object, log?: Function, stateDir: string}} opts
 */
export function createVideoStoryboard({ cfg = {}, log = () => {}, stateDir }) {
  const conf = { ...DEFAULTS, ...(cfg.video ?? {}) };
  const bin = resolveStoryboardBin(conf.storyboardBin);
  const outDir = path.join(stateDir, 'media', 'video');

  // 顺手清理：分镜产物只留着排错，不长期占地。
  try {
    const cutoff = Date.now() - Math.max(1, Number(conf.keepDays) || 2) * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(outDir)) {
      const full = path.join(outDir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}

  function available() {
    return Boolean(conf.enabled && bin);
  }

  /**
   * @param {{url?: string, filePath?: string, tag?: string}} source
   * @returns {Promise<{pngPath: string, pngBuffer: Buffer, text: string, ms: number}>}
   */
  async function run(source) {
    if (!conf.enabled) throw new Error('视频分镜未启用（config.video.enabled=false）');
    if (!bin) throw new Error('没找到 dsh-video-storyboard（先 dsh plugin --profile web add dsh-video-storyboard）');
    fs.mkdirSync(outDir, { recursive: true });

    const base = safeBaseName(source.tag ?? source.url ?? source.filePath);
    let inputPath = source.filePath ? String(source.filePath) : '';
    if (!inputPath) {
      const url = String(source.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('视频地址不合法（只接受 http/https）');
      const { buffer } = await safeFetchBinary(url, Number(conf.maxBytes) || DEFAULTS.maxBytes, {
        timeoutMs: Math.min(Number(conf.timeoutMs) || DEFAULTS.timeoutMs, 120_000)
      });
      inputPath = path.join(outDir, `${base}.mp4`);
      fs.writeFileSync(inputPath, buffer);
    } else if (!fs.existsSync(inputPath)) {
      throw new Error(`视频文件不存在：${path.basename(inputPath)}`);
    }

    const pngPath = path.join(outDir, `${base}.png`);
    const started = Date.now();
    const { stdout } = await runCli(bin, [
      inputPath,
      '--cells', String(Number(conf.cells) || 0),
      '--transcript', String(conf.transcript || 'off'),
      '--out', pngPath,
      '--text'
    ], { timeoutMs: Number(conf.timeoutMs) || DEFAULTS.timeoutMs, env: process.env });

    // CLI 的输出：前面是进度行，`[done]` 之后才是给模型看的清单。
    const lines = stdout.split('\n');
    const doneAt = lines.findIndex((line) => line.startsWith('[done]'));
    const text = (doneAt >= 0 ? lines.slice(doneAt + 1) : lines).join('\n').trim();
    if (!fs.existsSync(pngPath)) throw new Error('分镜进程没有产出图片');

    const pngBuffer = fs.readFileSync(pngPath);
    const maxChars = Number(conf.maxTextChars) || DEFAULTS.maxTextChars;
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…（清单已截断）` : text;
    log(`视频分镜完成：${path.basename(pngPath)} ${Math.round(pngBuffer.length / 1024)}KB / ${Date.now() - started}ms`);
    return { pngPath, pngBuffer, text: clipped, ms: Date.now() - started };
  }

  return { available, run, bin, conf };
}
