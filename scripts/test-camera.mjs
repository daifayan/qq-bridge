// camera MCP 离线自检：握手 / 工具表 / 设备探测 / 同意闸门 / 无设备时的报错是否说人话。
// 不真拍照（本机没有 DirectShow 摄像头时也只能验证报错路径）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-camera.js')], {
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

const textOf = (m) => m?.result?.content?.[0]?.text ?? '';
const jsonOf = (m) => { try { return JSON.parse(textOf(m)); } catch { return {}; } };

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '1' } });
  must('initialize 握手', init?.result?.serverInfo?.name === 'camera');

  const list = await call('tools/list', {});
  const names = (list?.result?.tools ?? []).map((t) => t.name);
  must('6 个工具齐全', names.length === 6, names.join(','));
  for (const n of ['camera_list', 'camera_snapshot', 'camera_record', 'camera_phone_screen', 'camera_last', 'camera_policy']) {
    must(`工具 ${n}`, names.includes(n));
  }

  const policy = jsonOf(await call('tools/call', { name: 'camera_policy', arguments: {} }));
  must('ffmpeg 探测到', /ffmpeg\.exe$/i.test(String(policy.ffmpeg ?? '')), String(policy.ffmpeg ?? ''));
  must('默认要求同意', policy?.policy?.requireConsent === true);

  const devices = jsonOf(await call('tools/call', { name: 'camera_list', arguments: {} }));
  must('camera_list 返回数组', Array.isArray(devices.pcDevices), `pcDevices=${(devices.pcDevices ?? []).length}`);
  must('adb 状态有结论', typeof devices?.adb?.available === 'boolean', `adb=${devices?.adb?.available}`);

  const noConsent = jsonOf(await call('tools/call', { name: 'camera_snapshot', arguments: {} }));
  must('未确认 → 拒绝并提示', noConsent?.needsConsent === true, String(noConsent?.message ?? '').slice(0, 30));

  const withConsent = jsonOf(await call('tools/call', { name: 'camera_snapshot', arguments: { confirmed: true } }));
  // 本机没有摄像头时应该是明确错误；有摄像头时应该 ok
  must('确认后给出结果（拍照或明确报错）', withConsent?.ok === true || Boolean(withConsent?.error), String(withConsent?.error ?? withConsent?.path ?? '').slice(0, 50));

  const last = jsonOf(await call('tools/call', { name: 'camera_last', arguments: {} }));
  must('camera_last 可用', last?.ok === true, String(last?.empty ? '空' : last?.path ?? ''));
} finally {
  child.kill();
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
