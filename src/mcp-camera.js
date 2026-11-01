/**
 * camera MCP —— "眼睛"
 *
 * 来源：2026-11-01 移植自阿深的便携包，按本仓库结构适配：
 *   - 产物目录改为 state/media/camera/（不再依赖 ashome）
 *   - ffmpeg / adb 改成自动探测（环境变量 → 本机常见路径 → PATH）
 *   - 政策和审计文件放在 state/ 下，可用 state/camera-policy.json 调
 *
 * 两种画面来源：
 *   1) 电脑：内置/外接摄像头，走 ffmpeg DirectShow（抓帧 / 录一小段）
 *   2) 手机：连着 USB 时用 adb 调相机拍一张（也可以截手机屏幕）
 *
 * 边界（重要）：
 *   - 默认「拍之前先问」：requireConsent=true 时，不带 confirmed:true 的调用只回一句
 *     "先征得同意"，不会真的拍。
 *   - 每小时最多 maxPerHour 次；文件只写 state/media/camera/，超过 keepDays 天自动清。
 *   - 每次调用写 state/camera-audit.log。
 *   - 只给 owner 私聊（closed-agent / standard）用；群聊 preset 的 qq-tool-restrict
 *     白名单里没有 mcp__camera__*。
 *
 * 工具：
 *   camera_list          有哪些摄像头（电脑 DirectShow + 手机是否连上）
 *   camera_snapshot      拍一张（source=pc|phone），返回文件路径
 *   camera_record        电脑摄像头录 N 秒 mp4（默认 10 秒，最多 15）
 *   camera_phone_screen  截一张手机屏幕
 *   camera_last          最近一张是什么
 *   camera_policy        看当前的同意/限额/保留策略
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const CAM_DIR = path.join(STATE, 'media', 'camera');
const AUDIT = path.join(STATE, 'camera-audit.log');
const POLICY_FILE = path.join(STATE, 'camera-policy.json');
const MAX_TEXT = 3000;

/** ffmpeg：环境变量 → DSH 自带 → PATH */
function resolveFfmpeg() {
  const fromEnv = String(process.env.FFMPEG_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const dsh = path.join(process.env.USERPROFILE || '', '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(dsh)) return dsh;
  return 'ffmpeg';
}

/** adb：环境变量 → PATH → WinGet 常见目录（找不到就返回空，手机功能给指引） */
function resolveAdb() {
  const fromEnv = String(process.env.ADB_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const wingetRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const dir of fs.readdirSync(wingetRoot)) {
      if (!/platform-tools/i.test(dir)) continue;
      const exe = path.join(wingetRoot, dir, 'platform-tools', 'adb.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* 没有 WinGet 目录 */ }
  return 'adb';
}

const FFMPEG = resolveFfmpeg();
const ADB = resolveAdb();

const POLICY_DEFAULT = {
  requireConsent: true,
  maxPerHour: 10,
  keepDays: 7,
  maxRecordSeconds: 15,
  pcDevice: '',
  adbPath: '',
};

function readPolicy() {
  try { return { ...POLICY_DEFAULT, ...JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) }; }
  catch { return { ...POLICY_DEFAULT }; }
}

function ensureDir() {
  fs.mkdirSync(CAM_DIR, { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function audit(entry) {
  try {
    ensureDir();
    fs.appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 审计写不了不挡拍摄 */ }
}

function prune() {
  const policy = readPolicy();
  const cutoff = Date.now() - Math.max(1, Number(policy.keepDays) || 7) * 86400_000;
  try {
    for (const name of fs.readdirSync(CAM_DIR)) {
      const file = path.join(CAM_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch { /* 单个文件删不掉就算了 */ }
    }
  } catch { /* 目录还没有 */ }
}

function countLastHour() {
  try {
    const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - 3600_000;
    return lines.filter((line) => {
      try { const j = JSON.parse(line); return j.result !== 'needs-consent' && Date.parse(j.at) >= cutoff; } catch { return false; }
    }).length;
  } catch { return 0; }
}

/** 同意 + 频率闸门；返回 undefined 表示放行。 */
function gate(tool, args) {
  const policy = readPolicy();
  if (policy.requireConsent && args?.confirmed !== true) {
    audit({ tool, result: 'needs-consent', note: args?.note || '' });
    return {
      needsConsent: true,
      message: '拍之前要先问：说清楚要拍什么、为什么，等明确同意后，再用 confirmed:true 调用一次。这次没有拍。',
    };
  }
  if (countLastHour() >= Number(policy.maxPerHour || 10)) {
    audit({ tool, result: 'rate-limited' });
    return { error: `这一小时已经用过 ${countLastHour()} 次摄像头了（上限 ${policy.maxPerHour}），先别拍了。` };
  }
  return undefined;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(e?.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** 列出电脑上 DirectShow 的视频设备名（只取 video 段）。 */
async function pcDevices() {
  const r = await run(FFMPEG, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 20_000);
  const text = `${r.err}\n${r.out}`;
  const video = [];
  for (const line of text.split('\n')) {
    // 有些 ffmpeg 构建不打印 "DirectShow video devices" 标题，直接按 (video) 行认
    const m = line.match(/"([^"]+)"\s*\(video\)/);
    if (m && !m[1].startsWith('@device')) video.push(m[1]);
  }
  return [...new Set(video)];
}

function pcDeviceName(policy) {
  return String(policy.pcDevice || '').trim();
}

async function capturePc(confirmed, note) {
  const blocked = gate('camera_snapshot', { confirmed, note });
  if (blocked) return blocked;
  ensureDir();
  prune();
  const policy = readPolicy();
  let device = pcDeviceName(policy);
  if (!device) {
    const devices = await pcDevices();
    device = devices[0] || '';
  }
  if (!device) return { error: '没找到电脑摄像头（ffmpeg -list_devices 里没有 video 设备）。外接摄像头插上后重试，或在 state/camera-policy.json 的 pcDevice 里写设备名。' };
  const file = path.join(CAM_DIR, `pc-${stamp()}.jpg`);
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow', '-rtbufsize', '64M', '-i', `video=${device}`, '-frames:v', '1', '-q:v', '2', file], 25_000);
  if (r.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    audit({ tool: 'camera_snapshot', source: 'pc', result: 'failed', error: r.err.slice(-300) });
    return { error: `抓帧失败：${r.err.trim().slice(-300) || 'ffmpeg 没输出'}`, device };
  }
  const bytes = fs.statSync(file).size;
  audit({ tool: 'camera_snapshot', source: 'pc', result: 'ok', file, bytes, device, note: note || '' });
  return { ok: true, source: 'pc', device, path: file, bytes, hint: '用 read_image 打开这个 path 看画面；要发出去就用 qq_send_image 传这个路径。' };
}

async function recordPc(confirmed, seconds, note) {
  const blocked = gate('camera_record', { confirmed, note });
  if (blocked) return blocked;
  ensureDir();
  prune();
  const policy = readPolicy();
  const secs = Math.max(1, Math.min(Number(policy.maxRecordSeconds) || 15, Number(seconds) || 10));
  let device = pcDeviceName(policy);
  if (!device) device = (await pcDevices())[0] || '';
  if (!device) return { error: '没找到电脑摄像头。' };
  const file = path.join(CAM_DIR, `pc-${stamp()}.mp4`);
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow', '-rtbufsize', '128M', '-i', `video=${device}`, '-t', String(secs), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file], (secs + 20) * 1000);
  if (r.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    audit({ tool: 'camera_record', source: 'pc', result: 'failed', error: r.err.slice(-300) });
    return { error: `录像失败：${r.err.trim().slice(-300) || 'ffmpeg 没输出'}`, device };
  }
  const bytes = fs.statSync(file).size;
  audit({ tool: 'camera_record', source: 'pc', result: 'ok', file, bytes, seconds: secs, device, note: note || '' });
  return { ok: true, source: 'pc', device, path: file, bytes, seconds: secs };
}

function adb(args, timeoutMs = 30_000) {
  return run(ADB, args, timeoutMs);
}

function adbMissing() {
  return { error: '这台机器没装 adb（Android Platform Tools）。要用手机拍照/截屏，先装 platform-tools 并把 adb 加进 PATH，或在 state/camera-policy.json 的 adbPath 里写完整路径。' };
}

async function adbAvailable() {
  const r = await run(ADB, ['version'], 8_000);
  return r.code === 0;
}

async function phoneReady() {
  if (!(await adbAvailable())) return { ok: false, ...adbMissing() };
  const r = await adb(['devices'], 15_000);
  if (!/\tdevice/.test(r.out)) return { ok: false, error: '手机没连上（adb devices 里没有 device）。插 USB、开 USB 调试。' };
  const power = await adb(['shell', 'dumpsys power | grep mWakefulness='], 15_000);
  if (!/Awake/.test(power.out)) return { ok: false, error: '手机息屏了。先解锁手机再拍（解不了锁）。' };
  const window = await adb(['shell', 'dumpsys window | grep mDreamingLockscreen'], 15_000);
  if (/mDreamingLockscreen=true/.test(window.out)) return { ok: false, error: '手机锁着。先解锁再拍。' };
  return { ok: true };
}

async function capturePhone(confirmed, note) {
  const blocked = gate('camera_snapshot', { confirmed, note });
  if (blocked) return blocked;
  ensureDir();
  prune();
  const ready = await phoneReady();
  if (!ready.ok) return { error: ready.error };

  const before = (await adb(['shell', 'ls -t /sdcard/DCIM/Camera/ 2>/dev/null | head -1'], 15_000)).out.trim();
  await adb(['shell', 'am start -a android.media.action.STILL_IMAGE_CAMERA'], 20_000);
  await new Promise((r) => setTimeout(r, 2500));
  await adb(['shell', 'input keyevent 27'], 15_000);   // KEYCODE_CAMERA
  await new Promise((r) => setTimeout(r, 2500));
  const after = (await adb(['shell', 'ls -t /sdcard/DCIM/Camera/ 2>/dev/null | head -1'], 15_000)).out.trim();
  if (!after) return { error: '手机 DCIM/Camera 里没找到照片。' };
  if (after === before) {
    audit({ tool: 'camera_snapshot', source: 'phone', result: 'failed', error: 'no new file' });
    return { error: '相机没响应（没有新照片）。可能是相机界面没起来，或者相机权限/锁屏限制。' };
  }
  const remote = `/sdcard/DCIM/Camera/${after}`;
  const file = path.join(CAM_DIR, `phone-${stamp()}${path.extname(after) || '.jpg'}`);
  // adb exec-out 的二进制走 stdout；run() 用的是 utf8 解码，这里单独用 spawn 拉二进制
  const bytes = await new Promise((resolve) => {
    const child = spawn(ADB, ['exec-out', `cat "${remote}"`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) fs.writeFileSync(file, buf);
      resolve(buf.length);
    });
    child.on('error', () => resolve(0));
  });
  if (!bytes) {
    audit({ tool: 'camera_snapshot', source: 'phone', result: 'failed', error: 'pull failed' });
    return { error: '照片拉不下来（空文件）。' };
  }
  audit({ tool: 'camera_snapshot', source: 'phone', result: 'ok', file, bytes, remote, note: note || '' });
  return { ok: true, source: 'phone', path: file, bytes, remote, hint: '用 read_image 看；要发出去用 qq_send_image 传这个路径。' };
}

async function phoneScreen(confirmed, note) {
  const blocked = gate('camera_phone_screen', { confirmed, note });
  if (blocked) return blocked;
  ensureDir();
  if (!(await adbAvailable())) return adbMissing();
  const ready = await adb(['devices'], 15_000);
  if (!/\tdevice/.test(ready.out)) return { error: '手机没连上（adb devices 里没有 device）。' };
  const file = path.join(CAM_DIR, `phone-screen-${stamp()}.png`);
  const bytes = await new Promise((resolve) => {
    const child = spawn(ADB, ['exec-out', 'screencap', '-p'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) fs.writeFileSync(file, buf);
      resolve(buf.length);
    });
    child.on('error', () => resolve(0));
  });
  if (!bytes) {
    audit({ tool: 'camera_phone_screen', result: 'failed' });
    return { error: '截屏失败（空文件）。' };
  }
  audit({ tool: 'camera_phone_screen', result: 'ok', file, bytes, note: note || '' });
  return { ok: true, source: 'phone-screen', path: file, bytes };
}

function lastShot() {
  try {
    const files = fs.readdirSync(CAM_DIR)
      .map((n) => ({ n, t: fs.statSync(path.join(CAM_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) return { ok: true, empty: true, message: '还没拍过。' };
    const f = files[0];
    return { ok: true, path: path.join(CAM_DIR, f.n), at: new Date(f.t).toISOString(), count: files.length };
  } catch {
    return { ok: true, empty: true, message: '还没拍过。' };
  }
}

const TOOLS = [
  { name: 'camera_list', description: '有哪些摄像头（电脑 DirectShow + 手机是否连上）。', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'camera_snapshot',
    description: '拍一张。source=pc（默认，电脑摄像头）或 phone（手机，需 USB+adb）。默认要先征得同意，带 confirmed:true 才真拍。',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'pc | phone' },
        confirmed: { type: 'boolean', description: '已征得同意' },
        note: { type: 'string', description: '拍这个干什么（写进审计）' },
      },
    },
  },
  {
    name: 'camera_record',
    description: '电脑摄像头录一段 mp4（默认 10 秒，最多 15）。同样需要 confirmed:true。',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number' }, confirmed: { type: 'boolean' }, note: { type: 'string' } },
    },
  },
  {
    name: 'camera_phone_screen',
    description: '截一张手机屏幕（需 USB+adb）。',
    inputSchema: { type: 'object', properties: { confirmed: { type: 'boolean' }, note: { type: 'string' } } },
  },
  { name: 'camera_last', description: '最近拍的一张是什么。', inputSchema: { type: 'object', properties: {} } },
  { name: 'camera_policy', description: '看当前的同意/限额/保留策略，以及 ffmpeg/adb 探测结果。', inputSchema: { type: 'object', properties: {} } },
];

const HANDLERS = {
  async camera_list() {
    const devices = await pcDevices();
    const adbOk = await adbAvailable();
    let phone = { connected: false };
    if (adbOk) {
      const r = await adb(['devices'], 15_000);
      phone = { connected: /\tdevice/.test(r.out), raw: r.out.trim().split('\n').slice(1).join('; ') };
    }
    return { pcDevices: devices, adb: { available: adbOk, path: ADB }, phone, ffmpeg: FFMPEG };
  },
  async camera_snapshot(a) {
    if (String(a.source || 'pc') === 'phone') return capturePhone(a.confirmed, a.note);
    return capturePc(a.confirmed, a.note);
  },
  async camera_record(a) {
    return recordPc(a.confirmed, a.seconds, a.note);
  },
  async camera_phone_screen(a) {
    return phoneScreen(a.confirmed, a.note);
  },
  async camera_last() {
    return lastShot();
  },
  async camera_policy() {
    return { policy: readPolicy(), ffmpeg: FFMPEG, adb: ADB, dir: CAM_DIR, usedLastHour: countLastHour() };
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camera', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }

  if (method === 'tools/call') {
    const name = params?.name;
    const fn = HANDLERS[name];
    if (!fn) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具：${name}` } });
      return;
    }
    try {
      const result = await fn(params?.arguments || {});
      const text = JSON.stringify(result, null, 2);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text.slice(0, MAX_TEXT) }] } });
    } catch (e) {
      audit({ tool: name, result: 'error', error: String(e?.message || e).slice(0, 200) });
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ error: String(e?.message || e) }) }], isError: true },
      });
    }
    return;
  }
});
