/**
 * pc-hands MCP —— "看屏幕 + 动鼠标键盘"
 *
 * 来源：2026-11-01 移植自阿深的便携包（原版注释见下），按本仓库结构做了适配：
 *   - 产物目录改为 state/media/screens/（不再依赖 ashome）
 *   - 加审计（state/pc-hands-audit.log）与每小时限频
 *   - pc_type 用完恢复原剪贴板（原版会覆盖掉用户剪贴板）
 *
 * 底层全部走 pc-hands.ps1（PowerShell + Win32），不引入任何 npm 依赖。
 *
 * 安全边界（重要）：
 *   - 只由 owner 私聊（closed-agent / standard）可见；群聊 preset 的 qq-tool-restrict
 *     白名单里没有 mcp__pc-hands__*，调用会被执行期拒绝。
 *   - 截图只写 state/media/screens/，只保留最近 30 张。
 *   - 不做进程/删文件/改注册表这类事（那是 pwsh 的事，不在这里开口子）。
 *   - state/pc-hands-policy.json 可开 requireConfirmForInput=true：点击/输入/按键前
 *     必须带 confirmed:true，否则只回一句"先确认"。
 *
 * 工具：
 *   pc_info          屏幕尺寸 + 当前前台窗口
 *   pc_screenshot    截图（可裁剪区域），存文件返回路径，再用 read_image 看
 *   pc_click         点一下（1=左 2=右）
 *   pc_double_click  双击
 *   pc_move          移动鼠标
 *   pc_drag          拖拽
 *   pc_scroll        滚轮
 *   pc_type          输入文本（走剪贴板，支持中文；用完恢复原剪贴板）
 *   pc_key           按键（enter/tab/esc/f1..f12…）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PS1 = path.join(__dirname, 'pc-hands.ps1');
const STATE = path.join(ROOT, 'state');
const SHOTS = path.join(STATE, 'media', 'screens');
const AUDIT = path.join(STATE, 'pc-hands-audit.log');
const POLICY_FILE = path.join(STATE, 'pc-hands-policy.json');
const KEEP_SHOTS = 30;
const MAX_PER_HOUR = 120;
const MAX_TEXT = 2000;

const POLICY_DEFAULT = { requireConfirmForInput: false, maxPerHour: MAX_PER_HOUR, keepShots: KEEP_SHOTS };

function readPolicy() {
  try { return { ...POLICY_DEFAULT, ...JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) }; }
  catch { return { ...POLICY_DEFAULT }; }
}

function ensureShots() {
  fs.mkdirSync(SHOTS, { recursive: true });
}

function audit(entry) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 审计写不了不挡操作 */ }
}

function pruneShots() {
  try {
    const files = fs.readdirSync(SHOTS)
      .filter((n) => n.toLowerCase().endsWith('.png'))
      .map((n) => ({ n, t: fs.statSync(path.join(SHOTS, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const keep = Math.max(5, Number(readPolicy().keepShots) || KEEP_SHOTS);
    for (const f of files.slice(keep)) {
      try { fs.rmSync(path.join(SHOTS, f.n)); } catch { /* 删不掉就算了 */ }
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

/** 输入类动作的确认闸门（默认关，policy 可开）。 */
function inputGate(tool, args) {
  const policy = readPolicy();
  if (!policy.requireConfirmForInput) return undefined;
  if (args?.confirmed === true) return undefined;
  audit({ tool, result: 'needs-consent' });
  return {
    needsConfirm: true,
    message: '这是会动鼠标/键盘的操作：先说清要点哪里/打什么，等你明确同意后再带 confirmed:true 调一次。这次没有执行。',
  };
}

/** 调一次 PowerShell 脚本，返回它输出的 JSON。 */
function runPs(args) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PS1, ...args,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.stderr.on('data', (d) => { err += d.toString('utf8'); });
    ps.on('error', reject);
    ps.on('exit', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `powershell exited ${code}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch { reject(new Error(`无法解析输出：${out.slice(0, 200)}`)); }
    });
  });
}

const TOOLS = [
  {
    name: 'pc_info',
    description: '看屏幕有多大、现在最前面是哪个窗口（拿到坐标基准再截图/点击）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_screenshot',
    description: '截屏。默认整屏；也可以只截一块（x/y/width/height）。存成 PNG 返回路径，之后用 read_image 看那张图。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '左上角 X，默认 0' },
        y: { type: 'number', description: '左上角 Y，默认 0' },
        width: { type: 'number', description: '宽，默认整屏' },
        height: { type: 'number', description: '高，默认整屏' },
        label: { type: 'string', description: '文件名前缀，方便分辨' },
      },
    },
  },
  {
    name: 'pc_click',
    description: '在屏幕坐标 (x,y) 点一下。button: 1=左键（默认），2=右键。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'number', description: '1=左 2=右' },
        confirmed: { type: 'boolean', description: '政策要求确认时才需要' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pc_double_click',
    description: '在 (x,y) 双击。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, confirmed: { type: 'boolean' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pc_move',
    description: '把鼠标移到 (x,y)，不点。',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
  },
  {
    name: 'pc_drag',
    description: '从 (x,y) 拖到 (x2,y2)。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, confirmed: { type: 'boolean' } },
      required: ['x', 'y', 'x2', 'y2'],
    },
  },
  {
    name: 'pc_scroll',
    description: '在 (x,y) 处滚轮。amount 正数向下滚、负数向上滚，1 ≈ 一格。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, amount: { type: 'number' } },
      required: ['x', 'y', 'amount'],
    },
  },
  {
    name: 'pc_type',
    description: '往当前焦点里输入文本（走剪贴板粘贴，中文也能打）。先点一下输入框再调这个。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['text'],
    },
  },
  {
    name: 'pc_key',
    description: '按一个键：enter/tab/esc/space/backspace/delete/up/down/left/right/home/end/pageup/pagedown/f1~f12/单个字母数字。',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['key'],
    },
  },
];

const HANDLERS = {
  async pc_info() {
    return runPs(['-Action', 'info']);
  },

  async pc_screenshot(a) {
    ensureShots();
    pruneShots();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const safeLabel = String(a.label || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30);
    const file = path.join(SHOTS, `${safeLabel ? safeLabel + '-' : ''}${stamp}.png`);
    const args = ['-Action', 'screenshot', '-Out', file];
    if (a.x != null) args.push('-X', String(Math.round(a.x)));
    if (a.y != null) args.push('-Y', String(Math.round(a.y)));
    if (a.width != null) args.push('-W', String(Math.round(a.width)));
    if (a.height != null) args.push('-H', String(Math.round(a.height)));
    const r = await runPs(args);
    return { ...r, hint: '用 read_image 打开这个 path 就能看见屏幕内容' };
  },

  async pc_click(a) {
    const gate = inputGate('pc_click', a);
    if (gate) return gate;
    return runPs(['-Action', 'click', '-X', String(Math.round(a.x)), '-Y', String(Math.round(a.y)), '-Button', String(a.button || 1)]);
  },
  async pc_double_click(a) {
    const gate = inputGate('pc_double_click', a);
    if (gate) return gate;
    return runPs(['-Action', 'doubleclick', '-X', String(Math.round(a.x)), '-Y', String(Math.round(a.y))]);
  },
  async pc_move(a) {
    return runPs(['-Action', 'move', '-X', String(Math.round(a.x)), '-Y', String(Math.round(a.y))]);
  },
  async pc_drag(a) {
    const gate = inputGate('pc_drag', a);
    if (gate) return gate;
    return runPs(['-Action', 'drag', '-X', String(Math.round(a.x)), '-Y', String(Math.round(a.y)), '-X2', String(Math.round(a.x2)), '-Y2', String(Math.round(a.y2))]);
  },
  async pc_scroll(a) {
    return runPs(['-Action', 'scroll', '-X', String(Math.round(a.x)), '-Y', String(Math.round(a.y)), '-Amount', String(Math.round(a.amount))]);
  },
  async pc_type(a) {
    const gate = inputGate('pc_type', a);
    if (gate) return gate;
    return runPs(['-Action', 'type', '-Text', String(a.text ?? '')]);
  },
  async pc_key(a) {
    const gate = inputGate('pc_key', a);
    if (gate) return gate;
    return runPs(['-Action', 'key', '-Key', String(a.key ?? '')]);
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
        serverInfo: { name: 'pc-hands', version: '1.0.0' },
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
    const startedAt = Date.now();
    try {
      const policy = readPolicy();
      if (countLastHour() >= Number(policy.maxPerHour || MAX_PER_HOUR)) {
        audit({ tool: name, result: 'rate-limited' });
        const msg = `这一小时已经用了 ${countLastHour()} 次（上限 ${policy.maxPerHour}），先歇会儿。`;
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true } });
        return;
      }
      const result = await fn(params?.arguments || {});
      // 只记动作，不记输入内容（text 可能是隐私）
      audit({ tool: name, result: result?.error ? 'failed' : (result?.needsConfirm ? 'needs-consent' : 'ok'), ms: Date.now() - startedAt });
      const text = JSON.stringify(result, null, 2);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text.slice(0, MAX_TEXT) }] } });
    } catch (e) {
      audit({ tool: name, result: 'error', error: String(e?.message || e).slice(0, 200), ms: Date.now() - startedAt });
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ error: String(e?.message || e) }) }], isError: true },
      });
    }
    return;
  }
});
