// 「停止全部」的两步确认（纯鼠标，不需要键盘）：
//   第一次双击 bat → 写布防标记，退出码 1（不动服务）
//   60 秒内再双击 → 清标记，退出码 0（bat 继续执行停止）
//   超过 60 秒再双击 → 重新布防，仍然是退出码 1
//
// 为什么不用 choice / set /p：远程桌面或手机上 cmd 窗口可能收不到按键，
// 那种脚本会永远停在等待输入那一行（2026-11-01 真实踩过）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');
const FLAG = path.join(STATE_DIR, 'stop-armed.json');
const WINDOW_MS = 60_000;

fs.mkdirSync(STATE_DIR, { recursive: true });

const now = Date.now();
let prev = null;
try { prev = JSON.parse(fs.readFileSync(FLAG, 'utf8')); } catch { /* 没有标记 */ }

if (prev && Number(prev.at) && now - Number(prev.at) < WINDOW_MS) {
  try { fs.rmSync(FLAG, { force: true }); } catch { /* 删不掉也不影响停止 */ }
  console.log('STOP CONFIRMED');
  process.exit(0);
}

try { fs.writeFileSync(FLAG, JSON.stringify({ at: now }), 'utf8'); } catch { /* 写不了就当作未布防 */ }
console.log('ARMED');
process.exit(1);
