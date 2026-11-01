// pc-hands MCP 离线自检：走真实 stdio JSON-RPC，验证握手 / 工具表 / 截屏落盘。
// 不发 QQ、不点鼠标（点击类只验证工具存在，不真执行）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-pc-hands.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let seq = 0;
const pending = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function call(method, params, ms = 60000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, ms);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '1' } });
  must('initialize 握手', init?.result?.serverInfo?.name === 'pc-hands');

  const list = await call('tools/list', {});
  const names = (list?.result?.tools ?? []).map((t) => t.name);
  must('9 个工具齐全', names.length === 9, names.join(','));
  for (const n of ['pc_info', 'pc_screenshot', 'pc_click', 'pc_double_click', 'pc_move', 'pc_drag', 'pc_scroll', 'pc_type', 'pc_key']) {
    must(`工具 ${n}`, names.includes(n));
  }

  const info = await call('tools/call', { name: 'pc_info', arguments: {} });
  const infoText = info?.result?.content?.[0]?.text ?? '';
  const infoJson = JSON.parse(infoText || '{}');
  must('pc_info 返回屏幕尺寸', Number(infoJson?.screen?.width) > 0, `${infoJson?.screen?.width}x${infoJson?.screen?.height}`);
  must('pc_info 返回前台窗口', typeof infoJson?.foreground?.title === 'string', String(infoJson?.foreground?.title ?? '').slice(0, 30));

  const shot = await call('tools/call', { name: 'pc_screenshot', arguments: { label: 'selftest' } });
  const shotJson = JSON.parse(shot?.result?.content?.[0]?.text ?? '{}');
  must('pc_screenshot 落盘', Boolean(shotJson?.path) && fs.existsSync(shotJson.path), shotJson?.path ?? '');
  must('截图非空', (() => { try { return fs.statSync(shotJson.path).size > 1000; } catch { return false; } })());

  const policy = await call('tools/call', { name: 'pc_move', arguments: { x: 10, y: 10 } });
  must('pc_move 可执行', !policy?.result?.isError, policy?.result?.content?.[0]?.text?.slice(0, 40) ?? '');
} finally {
  child.kill();
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
