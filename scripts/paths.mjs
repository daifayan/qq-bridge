/**
 * 路径配置读取 —— 唯一真源是项目根目录的 `paths.bat`。
 *
 * 为什么用 .bat 而不是 .json：
 *   启动脚本必须自己先找到 node 才能读配置，这是鸡生蛋。
 *   所以配置写成 bat 的 `set "KEY=VALUE"` 格式：.bat 直接 call，
 *   Node 用正则解析，一份文件两边都能用，不用维护副本。
 *
 * 解析规则很简单：只认整行 `set "KEY=VALUE"`，其余一律忽略。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * No hardcoded machine fallback: `paths.bat` NODE is empty AND the current
 * process is not node -> we hand the literal 'node' string to the callers,
 * which resolve it via PATH (and fail loudly if node is nowhere to be found).
 * A machine-specific fallback path here would leak one user's layout into
 * the open-source repo and help nobody.
 */
const FALLBACK_NODE = '';

/** 把 paths.bat 解析成 { KEY: value }。 */
export function parsePathsBat(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*set\s+"([A-Za-z_][A-Za-z0-9_]*)=(.*)"\s*$/i.exec(line);
    if (m) out[m[1].toUpperCase()] = m[2];
  }
  return out;
}

let cached = null;

/**
 * 读取路径配置。结果会缓存；改完 paths.bat 想立刻生效就传 { refresh: true }。
 * 任何一项缺失都不会抛错，只会落进 warnings —— 启动脚本不该因为配置不全就崩掉。
 */
export function loadPaths({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const warnings = [];
  const batPath = join(ROOT, 'paths.bat');
  let raw = {};
  try {
    raw = parsePathsBat(readFileSync(batPath, 'utf8'));
  } catch {
    warnings.push(`读不到 ${batPath}，全部走默认值`);
  }

  const pick = (key, fallback) => {
    const v = String(raw[key] ?? '').trim();
    return v || fallback;
  };

  // node：paths.bat → 当前进程自身 → 沙盒兜底
  let node = String(raw.NODE ?? '').trim();
  if (!node) node = process.execPath;
  if (!node || !existsSync(node)) {
    if (node) warnings.push(`paths.bat 里的 NODE 不存在：${node}`);
    node = existsSync(FALLBACK_NODE) ? FALLBACK_NODE : 'node';
  }

  const paths = {
    node,
    dshLnk: pick('DSHLNK', join(ROOT, 'dsh-launcher.lnk')),
    dshOpen: pick('DSHOPEN', ''),
    dshBin: pick('DSHBIN', ''),
    snowDir: pick('SNOWDIR', ''),
    bridgeDir: pick('BRIDGEDIR', ROOT),
    logDir: pick('LOGDIR', resolve(ROOT, '..', 'bridge-logs')),
    // QQ 客户端本体：SnowLuma 只能挂到「已经登录」的 QQ 上，
    // 所以启动链路需要自己把 QQ 拉起来（留空 = 不自动拉起）。
    qqExe: pick('QQEXE', ''),
    warnings,
    source: batPath
  };
  cached = paths;
  return paths;
}

/** 列出配置里指向不存在位置的关键项（供启动器打印提示）。 */
export function missingPaths(paths = loadPaths()) {
  const checks = [
    ['NODE', paths.node],
    ['DSHLNK', paths.dshLnk],
    ['SNOWDIR', paths.snowDir],
    ['BRIDGEDIR', paths.bridgeDir]
  ];
  return checks
    .filter(([, v]) => v && v !== 'node' && !existsSync(v))
    .map(([k, v]) => `${k} → ${v}`);
}
