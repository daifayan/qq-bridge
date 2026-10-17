/**
 * 打开桥接控制台的「白名单 / 管理员」分区（桌面「白名单管理」快捷方式的入口）。
 *
 * 为什么不再用命令行菜单：
 *   加白名单时人是按"名字"认人的，但命令行要求先输入 10 位 QQ 号 —— 顺序反了。
 *   控制台会把好友/群按名字列出来（备注优先），点一下「加白 / 加黑」就完事。
 *
 * CLI 兜底（同样需要桥接在跑）：node whitelist-menu.mjs
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 3100;

/** 令牌优先取 config.json，其次 state/console-token（与 whitelist-lib.mjs 一致）。 */
function readToken() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return readFileSync(join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {}
  return '';
}

/** 桥接是否在跑。401 也算"在跑"（说明服务活着，只是没带令牌）。 */
async function bridgeAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

if (!(await bridgeAlive())) {
  console.log('');
  console.log('  QQ 桥接没有在运行（端口 3100 没响应）。');
  console.log('  先双击「启动全家桶.bat」把服务拉起来，再试一次。');
  console.log('');
  process.exit(1);
}

const token = readToken();
// token 走 query 是控制台既有的登录方式（服务端同时支持 x-console-token 头）。
// #sec-10 = 白名单分区，打开就直接定位到那里。
const url = `http://127.0.0.1:${PORT}/`
  + (token ? `?token=${encodeURIComponent(token)}` : '')
  + '#sec-10';

console.log('  正在打开控制台白名单页…');
console.log('  ' + url.replace(/token=[^&#]+/, 'token=***'));

const isWin = process.platform === 'win32';
const child = isWin
  ? spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
  : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
child.unref();
