/**
 * 一键切换 QQ 机器人的模型（2026-10-29 重写）
 * ============================================================
 * 为什么重写：老版本有两个致命问题，导致它其实一直没在干活 ——
 *
 *   1) 探测端口写死 3080，可项目早就改成 DSH 桌面端 43129 了。
 *      于是第一步就报「DSH 没在跑」直接退出。
 *
 *   2) 它改的是 config.json 的 dsh.provider / dsh.model。但
 *      `dsh.autoAdapt.enabled = true` 时，桥接只认 candidates 的**顺序**
 *      （见 src/api-adapt.js 的 doResolve），provider/model 仅在全部候选
 *      不可用时当兜底。所以就算端口对了，改了也不生效。
 *
 * 现在的做法：跟启动器共用 launcher/config-ops.mjs，切换 = 把目标候选
 * 挪到第一位，然后重启桥接。图形界面和命令行只有一套逻辑，不会打架。
 *
 * 用法：
 *   node scripts/switch-model.mjs            看候选列表，输入序号切换
 *   node scripts/switch-model.mjs status     只看状态，什么都不动
 *   node scripts/switch-model.mjs up         只拉起缺失的服务，不切模型
 *   node scripts/switch-model.mjs -y 1       直接切第 1 个（脚本/快捷方式用）
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

import { describeModel, setPrimaryModel, reloadBridge } from '../launcher/config-ops.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = path.join(ROOT, 'config.json');
const BAT_BRIDGE = path.join(ROOT, 'start.bat');
const BAT_SNOWLUMA = path.join(ROOT, 'start-snowluma.bat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

/** DSH 端口不再写死 —— 跟着 config.dsh.baseUrl 走（现在是 43129） */
function dshPort(cfg) {
  const url = String(cfg?.dsh?.baseUrl || 'http://127.0.0.1:43129');
  const m = url.match(/:(\d+)/);
  return m ? Number(m[1]) : 43129;
}

function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    const done = (ok) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function waitForPort(port, totalMs, step = 1500) {
  const deadline = Date.now() + totalMs;
  process.stdout.write(`  等待端口 ${port} …`);
  while (Date.now() < deadline) {
    if (await portOpen(port)) { process.stdout.write(' 通了\n'); return true; }
    await sleep(step);
    process.stdout.write('.');
  }
  process.stdout.write(' 超时\n');
  return false;
}

function readLockPid() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'bridge.lock'), 'utf8').trim(); } catch { return ''; }
}

/** 等桥接真正上线：端口开着【且】bridge.lock 里已经是新 pid。
 *  只等端口会读到自己马上要杀掉的旧进程（实修的坑：脚本曾因此报“成功”抢跑）。 */
async function waitForBridge(oldPid, totalMs = 35_000) {
  const deadline = Date.now() + totalMs;
  process.stdout.write('  等待桥接重新上线（以 bridge.lock 的 pid 变化为准）…');
  while (Date.now() < deadline) {
    const pid = readLockPid();
    if (pid && pid !== oldPid && (await portOpen(3100))) { process.stdout.write(` 新 pid=${pid}\n`); return true; }
    await sleep(1200);
    process.stdout.write('.');
  }
  process.stdout.write(' 超时\n');
  return false;
}

function startBatDetached(bat, label) {
  // 两个实修过的坑：
  // 1) `start` 只把【带引号】的首参当窗口标题，不带引号就当成要运行的程序名
  // 2) node spawn 会自作主张改写参数引号，把嵌套引号吃掉。所以用
  //    windowsVerbatimArguments 让整行命令【原样】传给 cmd
  const line = `start "" /min "${bat}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', line], { cwd: ROOT, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.unref();
  console.log(`  已拉起 ${label}（最小化窗口）：${path.basename(bat)}`);
}

async function bridgeStatus(token) {
  try {
    const r = await fetch(`http://127.0.0.1:3100/api/status?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** 确保 DSH / SnowLuma / 桥接 在线 */
async function ensureServices(cfg, { fix = true } = {}) {
  const port = dshPort(cfg);
  const st = { dsh: await portOpen(port), snowluma: await portOpen(3001), bridge: await portOpen(3100) };
  console.log(`链路体检：DSH(${port}) ${st.dsh ? '✅' : '❌'}  SnowLuma(3001) ${st.snowluma ? '✅' : '❌'}  桥接(3100) ${st.bridge ? '✅' : '❌'}`);

  if (fix && !st.dsh) {
    console.log(`  ❌ DSH 桌面端（${port}）没在跑，桥接连不上它。`);
    console.log('     双击桌面「面板」→ 点「一键启动全套」，或直接开 DSH Desktop，然后重跑本脚本。');
    return { ...st, fatal: true };
  }
  if (fix && !st.snowluma) {
    if (!fs.existsSync(BAT_SNOWLUMA)) {
      console.log(`  ❌ 找不到 ${BAT_SNOWLUMA}，无法自动拉起 SnowLuma。`);
      return { ...st, fatal: true };
    }
    console.log('  SnowLuma 没在跑，自动拉起（需要 QQ 已登录）…');
    startBatDetached(BAT_SNOWLUMA, 'SnowLuma');
    st.snowluma = await waitForPort(3001, 45_000);
    if (!st.snowluma) {
      console.log('  ❌ SnowLuma 45 秒内没起来。检查：QQ 是否已登录？或打开桌面「面板」点「一键启动全套」。');
      return { ...st, fatal: true };
    }
  }
  if (fix && !st.bridge) {
    if (!fs.existsSync(BAT_BRIDGE)) {
      console.log(`  ❌ 找不到 ${BAT_BRIDGE}，无法自动拉起桥接。`);
      return { ...st, fatal: true };
    }
    console.log('  桥接没在跑，自动拉起守护窗口 …');
    startBatDetached(BAT_BRIDGE, 'qq-bridge');
    st.bridge = await waitForBridge(readLockPid());
    if (!st.bridge) {
      console.log('  ❌ 桥接 30 秒内没起来。看最后几行：F:\\ai\\bridge-logs\\bridge.err.log 和 state\\bridge.log');
      return { ...st, fatal: true };
    }
  }

  st.bridgeStatus = st.bridge ? await bridgeStatus(cfg.consoleToken) : null;
  return st;
}

function printTable(model) {
  console.log('');
  console.log('  序号  模型                     状态      说明');
  console.log('  ' + '─'.repeat(72));
  model.candidates.forEach((c, i) => {
    const live = i === model.activeIndex;
    const flag = live ? '正在使用' : (c.ok ? '可用    ' : '不可用  ');
    const note = c.ok ? `${c.provider}${c.baseURL ? ' · ' + c.baseURL.replace(/^https?:\/\//, '') : ''}` : `${c.provider} · ${c.error}`;
    console.log(`   [${i}]  ${c.model.padEnd(24)} ${flag}  ${note}`);
  });
  console.log('  ' + '─'.repeat(72));
  if (model.autoAdapt) {
    console.log('  自动适配：开 —— 桥接按上面的顺序挑第一个能用的，挂了自动往下掉。');
    console.log('  所以「切模型」= 把它挪到第一位。');
  } else {
    console.log(`  自动适配：关 —— 桥接固定用 ${model.fixed.provider}/${model.fixed.model}。`);
  }
  const active = model.active
    ? `${model.active.provider} / ${model.active.model}`
    : `无可用候选，走兜底 ${model.fixed.provider}/${model.fixed.model}`;
  console.log(`  当前实际生效：${active}`);
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || '').toLowerCase();
  const cfg = loadConfig();

  if (cmd === 'status') {
    printTable(await describeModel({ force: true }));
    await ensureServices(cfg, { fix: false });
    return;
  }

  if (cmd === 'up') {
    const st = await ensureServices(cfg, { fix: true });
    if (st.fatal) process.exit(1);
    console.log('完成：链路已在线，模型未改动。');
    return;
  }

  // ── 切换 ──
  const model = await describeModel({ force: true });
  printTable(model);

  let index = null;
  if (cmd === '-y') {
    index = Number(args[1]);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question('  输入要用的序号（直接回车=取消）：')).trim();
    rl.close();
    if (!ans) { console.log('  已取消，什么都没改。'); return; }
    index = Number(ans);
  }

  if (!Number.isInteger(index) || index < 0 || index >= model.candidates.length) {
    console.log(`  ❌ 序号不对：${index}（有效范围 0 - ${model.candidates.length - 1}）`);
    process.exit(1);
  }

  const pick = model.candidates[index];
  console.log(`  目标：${pick.provider}/${pick.model}${pick.ok ? '' : '（注意：这个候选现在探不通）'}`);

  const st = await ensureServices(cfg, { fix: true });
  if (st.fatal) {
    console.log('  ⚠ 链路没打通，但模型配置可以先改好，下次启动生效。');
  }

  setPrimaryModel(index, (line) => console.log('  ' + line));

  if (st.bridge) {
    console.log('  重启桥接让新配置生效 …');
    try {
      await reloadBridge({ log: (line) => console.log('  ' + line) });
    } catch {
      process.exit(1);
    }
    const s = await bridgeStatus(cfg.consoleToken);
    if (s) console.log(`  ✅ 桥接已回来：mode=${s.mode} dshReady=${s.dshReady} role=${s.role}`);
  } else {
    console.log('  桥接没在跑 —— 配置已存好，下次启动自动生效。');
  }

  console.log('');
  console.log(`✅ 完成：现在首选 ${pick.provider}/${pick.model}`);
  if (!pick.ok) console.log('   提醒：它现在探不通，桥接会按顺序自动降级到下一个能用的候选。');
}

main().catch((e) => { console.log('❌ 出错：' + (e?.message ?? e)); process.exit(1); });
