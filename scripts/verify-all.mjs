#!/usr/bin/env node
/**
 * verify-all.mjs — QQ 桥接一键体检
 *
 * 用法：
 *   node scripts/verify-all.mjs          # 快速体检（约 10 秒，只看运行态）
 *   node scripts/verify-all.mjs --deep   # 额外跑全套门禁与模块测试（慢，几十秒）
 *
 * 设计原则：
 *   1. 只读。除了可选的门禁脚本以外不启动/停止任何东西，不改文件。
 *   2. 缺服务不算崩：某项不通就记 FAIL 继续往下查，最后一次性汇总。
 *   3. 脱敏。任何 token / 密码都不打印，只报"有/无"。
 *
 * 退出码：0 = 全通过（允许有 WARN），1 = 有 FAIL。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const DEEP = process.argv.includes('--deep');

let pass = 0;
let fail = 0;
let warn = 0;
const failures = [];

const ok = (label, extra = '') => {
  pass += 1;
  console.log(`  [OK]   ${label}${extra ? ` — ${extra}` : ''}`);
};
const bad = (label, detail = '') => {
  fail += 1;
  failures.push(label);
  console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
};
const soft = (label, detail = '') => {
  warn += 1;
  console.log(`  [WARN] ${label}${detail ? ` — ${detail}` : ''}`);
};
const head = (t) => console.log(`\n=== ${t} ===`);

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 端口探测：只连一下，不发数据。 */
function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function fetchJson(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: null, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

const cfg = readJson(path.join(ROOT, 'config.json'));
if (!cfg) {
  console.log('[FAIL] 读不到 config.json，先确认 cwd 是项目根目录');
  process.exit(1);
}

console.log('QQ 桥接体检' + (DEEP ? '（深度：含门禁与模块测试）' : '（快速）'));
console.log(`目录 ${ROOT}`);

// ────────────────────────────────────────────────────────────
// 1. 端口与进程
// ────────────────────────────────────────────────────────────
head('1. 端口');

const PORTS = [
  ['SnowLuma WebUI', 5099, true],
  ['OneBot HTTP', 3000, true],
  ['OneBot WS', 3001, true],
  ['桥接控制台', cfg.consolePort ?? 3100, true],
  ['DSH Desktop', Number(String(cfg.dsh?.baseUrl ?? '').replace(/\D+(\d+)$/, '$1')) || 43129, true],
];

const portState = {};
for (const [name, port, required] of PORTS) {
  const alive = await probePort(port);
  portState[port] = alive;
  if (alive) ok(`${name} :${port}`);
  else if (required) bad(`${name} :${port} 无监听`, '服务没起？用启动器「一键启动全套」');
}

// ────────────────────────────────────────────────────────────
// 2. QQ 通道（走 OneBot，不经桥接）
// ────────────────────────────────────────────────────────────
head('2. QQ 通道');

const onebotHttp = cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000';
const onebotToken = cfg.snowluma?.accessToken ?? '';
if (portState[3000]) {
  const login = await fetchJson(`${onebotHttp}/get_login_info`, {
    headers: onebotToken ? { authorization: `Bearer ${onebotToken}` } : {},
  });
  if (login.body?.retcode === 0 && login.body?.data) {
    ok('OneBot 已登录', `uin=${login.body.data.user_id} 昵称=${login.body.data.nickname}`);
  } else if (login.status === 0) {
    bad('OneBot HTTP 不通', login.error ?? '');
  } else {
    bad('OneBot 未登录或鉴权失败', `HTTP ${login.status} retcode=${login.body?.retcode ?? '?'}`);
  }
} else {
  bad('OneBot 未启动，跳过登录检查');
}

// ────────────────────────────────────────────────────────────
// 3. 桥接
// ────────────────────────────────────────────────────────────
head('3. 桥接');

const consolePort = cfg.consolePort ?? 3100;
const consoleBase = `http://127.0.0.1:${consolePort}`;
const tokenQ = cfg.consoleToken ? `?token=${encodeURIComponent(cfg.consoleToken)}` : '';

let bridgeStatus = null;
if (portState[consolePort]) {
  const st = await fetchJson(`${consoleBase}/api/status${tokenQ}`);
  if (st.status === 200 && st.body) {
    bridgeStatus = st.body;
    ok('控制台 /api/status', `mode=${st.body.mode} dshReady=${st.body.dshReady}`);
    if (st.body.dshReady) ok('DSH 连接就绪');
    else bad('DSH 未就绪', '看 state/bridge.log 里的握手日志');

    const busy = st.body.busyReasons ?? {};
    const busyKeys = Object.keys(busy);
    if (busyKeys.length === 0) ok('无会话卡在忙锁');
    else soft('有会话处于忙锁', busyKeys.slice(0, 3).join(', ') + (busyKeys.length > 3 ? ` 等 ${busyKeys.length} 个` : ''));
  } else if (st.status === 401) {
    bad('控制台鉴权失败', 'config.consoleToken 和运行时不一致（改过配置没重启？）');
  } else {
    bad('控制台 /api/status 异常', st.error ?? `HTTP ${st.status}`);
  }
} else {
  bad('桥接未启动，跳过状态检查');
}

// ────────────────────────────────────────────────────────────
// 4. 桥接日志（只看最后一次启动之后）
// ────────────────────────────────────────────────────────────
head('4. 启动日志');

const logFile = path.join(STATE_DIR, 'bridge.log');
if (!fs.existsSync(logFile)) {
  bad('找不到 state/bridge.log');
} else {
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
  let startAt = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/桥接已启动/.test(lines[i])) {
      startAt = i;
      break;
    }
  }
  const tail = lines.slice(startAt);
  const tailText = tail.join('\n');
  const startedAt = (lines[startAt]?.match(/^(\S+ \S+)/) ?? [])[1] ?? '?';
  console.log(`         （本次启动 ${startedAt}，之后 ${tail.length} 行）`);

  if (/DSH 已就绪/.test(tailText)) {
    ok('日志有「DSH 已就绪」', (tailText.match(/DSH 已就绪[^\n]*/) ?? [''])[0].trim().slice(0, 60));
  } else {
    bad('日志里没有「DSH 已就绪」', '桥接起来了但没握住 DSH');
  }

  if (/机器人昵称[:：]\s*\S+/.test(tailText)) {
    ok('已取到机器人昵称', (tailText.match(/机器人昵称[:：]\s*\S+/) ?? [''])[0]);
  } else {
    soft('日志里没有机器人昵称', '可能还没连上 OneBot');
  }

  // 错误关键字（排除已知无害的）
  const errLines = tail.filter((l) => /\[error\]|ReferenceError|TypeError|is not defined|ECONNREFUSED/.test(l));
  if (errLines.length === 0) ok('本次启动后无报错');
  else soft(`本次启动后有 ${errLines.length} 行疑似报错`, errLines[0].slice(0, 110));

  if (/agent-preset\/invalid/.test(tailText)) bad('预设装配失败', '还在报 agent-preset/invalid');
  else ok('预设装配正常');
}

// ────────────────────────────────────────────────────────────
// 5. 角色卡
// ────────────────────────────────────────────────────────────
head('5. 角色卡');

const roleState = readJson(path.join(STATE_DIR, 'current-role.json'), {});
const roleName = roleState?.name ?? roleState?.role ?? null;
const rolesDir = path.join(ROOT, 'roles');
let roleFile = roleName ? path.join(rolesDir, `${roleName}.md`) : null;
if (!roleFile || !fs.existsSync(roleFile)) {
  // 兜底：只有一个角色卡时直接用它
  const candidates = fs.existsSync(rolesDir) ? fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md')) : [];
  roleFile = candidates.length === 1 ? path.join(rolesDir, candidates[0]) : null;
}

if (!roleFile || !fs.existsSync(roleFile)) {
  bad('找不到当前角色卡', roleName ? `roles/${roleName}.md 不存在` : 'state/current-role.json 里没有角色名');
} else {
  try {
    const { inspectRoleCard } = await import(new URL('../src/role-card-guard.js', import.meta.url).href);
    const text = fs.readFileSync(roleFile, 'utf8');
    const chk = inspectRoleCard(text);
    const label = `${path.basename(roleFile)} ${chk.chars} 字 / ${chk.sections.length} 节`;
    if (!chk.ok) bad('角色卡结构不合格', `${label}｜${chk.issues.join('；')}`);
    else if (chk.warnings.length) soft('角色卡有提醒', `${label}｜${chk.warnings.join('；')}`);
    else ok('角色卡结构正常', label);

    const bakCount = fs.readdirSync(rolesDir).filter((f) => f.startsWith(`${path.basename(roleFile, '.md')}.md.bak-`)).length;
    if (bakCount > 0) ok('角色卡有备份可回滚', `${bakCount} 份`);
    else soft('角色卡没有备份', '第一次改之前的原始版本没留');
  } catch (error) {
    soft('角色卡校验没跑起来', error.message);
  }
}

// ────────────────────────────────────────────────────────────
// 6. preset
// ────────────────────────────────────────────────────────────
head('6. preset');

const presetRoot = path.join(
  process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'dsh-desktop',
  'harness',
  '.agent-presets',
);
for (const name of ['qq-chat', 'qq-chat-v2']) {
  const dir = path.join(presetRoot, name);
  if (!fs.existsSync(dir)) {
    bad(`preset ${name} 缺失`, dir);
    continue;
  }
  const files = fs.readdirSync(dir);
  if (files.length === 0) bad(`preset ${name} 是空目录`, dir);
  else ok(`preset ${name}`, `${files.length} 个文件`);
}

// ────────────────────────────────────────────────────────────
// 7. MCP 注册（pc-hands / camera 等）
// ────────────────────────────────────────────────────────────
head('7. MCP 注册');

const cordisCandidates = [
  path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness', 'profiles', 'web', 'cordis.patch.yml'),
  path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness', 'cordis.patch.yml'),
].filter(Boolean);
const cordisFile = cordisCandidates.find((f) => fs.existsSync(f));
if (!cordisFile) {
  soft('找不到 cordis.patch.yml', 'DSH 配置目录变了？');
} else {
  const yml = fs.readFileSync(cordisFile, 'utf8');
  const wanted = [
    ['snowluma', /serverName:\s*snowluma\b/],
    ['snowluma-host', /serverName:\s*snowluma-host\b/],
    ['web-search-safe', /serverName:\s*web-search-safe\b/],
    ['pc-hands', /serverName:\s*pc-hands\b/],
    ['camera', /serverName:\s*camera\b/],
  ];
  for (const [name, re] of wanted) {
    if (re.test(yml)) ok(`MCP ${name} 已注册`);
    else bad(`MCP ${name} 没注册`, '跑 scripts/setup-dsh.mjs 或手工加进 cordis.patch.yml');
  }
  const scriptPaths = [...yml.matchAll(/^\s*-\s*'([^']*src[\\/]mcp-[^']*)'/gm)].map((m) => m[1]);
  const missingScripts = scriptPaths.filter((p) => !fs.existsSync(p));
  if (missingScripts.length === 0) ok('MCP 脚本文件都在', `${scriptPaths.length} 个`);
  else bad('有 MCP 脚本路径不存在', missingScripts[0]);
}

// ────────────────────────────────────────────────────────────
// 8. 成本账本
// ────────────────────────────────────────────────────────────
head('8. 成本账本');

if (bridgeStatus) {
  const usage = await fetchJson(`${consoleBase}/api/usage${tokenQ ? `${tokenQ}&` : '?'}days=7`, {}, 15000);
  if (usage.status === 200 && usage.body) {
    const u = usage.body;
    const today = u.today ?? {};
    ok('账本可读', `今日 ${today.tokens ?? 0} tokens / ¥${Number(today.cost ?? 0).toFixed(3)}｜跟踪 ${u.trackedSessions ?? 0} 个会话`);
    if (u.priceVersion) ok('价目表版本', String(u.priceVersion));
    if (u.estimated) soft('有会话用了未知模型', '金额按默认价估算，可能偏高');
    if (fs.existsSync(path.join(STATE_DIR, 'token-usage.json'))) ok('账本状态已落盘', 'state/token-usage.json');
  } else {
    soft('账本接口没读到', `HTTP ${usage.status}`);
  }
} else {
  soft('桥接没起，跳过账本检查');
}

// ────────────────────────────────────────────────────────────
// 9. 数据文件完整性
// ────────────────────────────────────────────────────────────
head('9. 数据文件');

// 注意：社交/唤醒状态不是 social-state.json，而是 social-v2.json，
// 且多角色时按角色拆成 social-v2.<角色名>.json —— 两种都算存在。
const socialFiles = fs.existsSync(STATE_DIR)
  ? fs.readdirSync(STATE_DIR).filter((f) => /^social-v2(\..+)?\.json$/.test(f))
  : [];
const dataFiles = [
  ['会话表', 'sessions.json'],
  ['空间已见表', 'qzone-seen.json'],
  ['表情库', 'stickers.json'],
  ['黑话库', 'slang.json'],
];
if (socialFiles.length > 0) ok('社交/唤醒状态', `${socialFiles.length} 个文件（${socialFiles.slice(0, 2).join(', ')}${socialFiles.length > 2 ? ' …' : ''}）`);
else soft('社交/唤醒状态不存在', 'state/social-v2.json（首次运行时是正常的）');
for (const [label, name] of dataFiles) {
  const file = path.join(STATE_DIR, name);
  if (!fs.existsSync(file)) {
    soft(`${label} 不存在`, `state/${name}（首次运行时是正常的）`);
    continue;
  }
  const size = fs.statSync(file).size;
  if (name.endsWith('.json')) {
    if (readJson(file) === null) bad(`${label} 不是合法 JSON`, `state/${name} 可能写坏了`);
    else ok(`${label} 可解析`, `${(size / 1024).toFixed(1)} KB`);
  } else {
    ok(label, `${(size / 1024).toFixed(1)} KB`);
  }
}

// ────────────────────────────────────────────────────────────
// 10. 门禁（只在 --deep）
// ────────────────────────────────────────────────────────────
if (DEEP) {
  head('10. 门禁与模块测试');

  const gates = [
    ['语法检查', 'check-syntax.mjs', []],
    ['密钥扫描', 'secret-scan.mjs', []],
    ['启动器审计', 'audit-launchers.mjs', []],
    ['结构审计', 'test-audit.mjs', []],
    ['空间模块', 'test-qzone-module.mjs', []],
    ['发送模块', 'test-qq-send-module.mjs', []],
    ['控制台零碎域', 'test-console-misc-module.mjs', []],
    ['表情服务', 'test-sticker-v2-module.mjs', []],
    ['账本', 'test-token-usage.mjs', []],
    ['刷屏守卫', 'test-loop-guard.mjs', []],
    ['角色卡守卫', 'test-role-card-guard.mjs', []],
  ];

  for (const [label, script, args] of gates) {
    const file = path.join(__dirname, script);
    if (!fs.existsSync(file)) {
      soft(`${label} 脚本不存在`, script);
      continue;
    }
    try {
      const { stdout } = await execFileAsync(process.execPath, [file, ...args], {
        cwd: ROOT,
        timeout: 240000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const tailLine = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      ok(label, tailLine.slice(0, 90));
    } catch (error) {
      const out = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      const reasonLine = out.split(/\r?\n/).find((l) => /FAIL|Error|失败|不通过/.test(l)) ?? error.message;
      bad(label, String(reasonLine).slice(0, 140));
    }
  }
}

// ────────────────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(56)}`);
console.log(`结果：${pass} 通过 / ${warn} 提醒 / ${fail} 失败`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'='.repeat(56)}\n`);

process.exit(fail === 0 ? 0 : 1);
