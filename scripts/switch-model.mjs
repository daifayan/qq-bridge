/**
 * 一键切换 QQ 机器人的模型：智谱 GLM（套餐额度） <-> DeepSeek（按量计费）。
 *
 * 做三件事：
 *   1. 改 config.json 的 dsh.provider / dsh.model（写前自动备份 config.before-toggle.json）
 *   2. 确保链路在线：DSH 3080 / SnowLuma 3001 / 桥接 3100（缺哪个拉哪个，拉不起来会明说）
 *   3. 安全重启桥接（3100 活着走 /api/restart；死了走 start.bat 守护窗口）
 *
 * 用法：
 *   node scripts/switch-model.mjs          交互式切换（回车确认，n 取消）
 *   node scripts/switch-model.mjs -y       跳过确认直接切
 *   node scripts/switch-model.mjs status   只看当前状态，不动任何东西
 *   node scripts/switch-model.mjs up       只拉起缺失的服务，不切换模型
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = path.join(ROOT, 'config.json');
const BAT_BRIDGE = path.join(ROOT, 'start.bat');
const BAT_SNOWLUMA = path.join(ROOT, 'start-snowluma.bat');

const PRESETS = {
  glm: {
    label: '智谱 GLM（套餐额度，边际≈¥0；注意：看图能力未开启）',
    provider: 'zai-coding-cn',
    model: 'glm-5.3-flash',
  },
  ds: {
    label: 'DeepSeek（按量计费，约 ¥2~4/天；看图正常）',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function startBatDetached(bat, label, _title) {
  // 两个实修过的坑：
  // 1) `start` 只把【带引号】的首参当窗口标题，不带引号就当成要运行的程序名
  //    （会弹“Windows 找不到文件 'SnowLuma'”）。
  // 2) node spawn 会自作主张改写参数引号，把嵌套引号吃掉。所以用
  //    windowsVerbatimArguments 让整行命令【原样】传给 cmd：
  //    cmd /d /s /c  start "" /min "F:\...\xxx.bat"
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

/** 确保 DSH / SnowLuma / 桥接 在线；返回 { dsh, snowluma, bridge, bridgeStatus } */
async function ensureServices(cfg, { fix = true } = {}) {
  const st = { dsh: await portOpen(3080), snowluma: await portOpen(3001), bridge: await portOpen(3100) };
  console.log(`链路体检：DSH(3080) ${st.dsh ? '✅' : '❌'}  SnowLuma(3001) ${st.snowluma ? '✅' : '❌'}  桥接(3100) ${st.bridge ? '✅' : '❌'}`);

  if (fix && !st.dsh) {
    console.log('  ❌ DSH 没在跑，桥接连不上它。请双击桌面【DeepSeek Harness】先启动 DSH，然后重跑本脚本。');
    return { ...st, fatal: true };
  }
  if (fix && !st.snowluma) {
    if (!fs.existsSync(BAT_SNOWLUMA)) {
      console.log(`  ❌ 找不到 ${BAT_SNOWLUMA}，无法自动拉起 SnowLuma。`);
      return { ...st, fatal: true };
    }
    console.log('  SnowLuma 没在跑，自动拉起（需要 QQ 已登录）…');
    startBatDetached(BAT_SNOWLUMA, 'SnowLuma', 'SnowLuma');
    st.snowluma = await waitForPort(3001, 45_000);
    if (!st.snowluma) {
      console.log('  ❌ SnowLuma 45 秒内没起来。检查：QQ 是否已登录？或打开桌面「面板」选 1 手动来一遍。');
      return { ...st, fatal: true };
    }
  }
  if (fix && !st.bridge) {
    if (!fs.existsSync(BAT_BRIDGE)) {
      console.log(`  ❌ 找不到 ${BAT_BRIDGE}，无法自动拉起桥接。`);
      return { ...st, fatal: true };
    }
    console.log('  桥接没在跑，自动拉起守护窗口 …');
    startBatDetached(BAT_BRIDGE, 'qq-bridge', 'qq-bridge');
    st.bridge = await waitForBridge(readLockPid());
    if (!st.bridge) {
      console.log('  ❌ 桥接 30 秒内没起来。看最后几行：F:\\ai\\bridge-logs\\bridge.err.log 和 state\\bridge.log');
      return { ...st, fatal: true };
    }
  }

  st.bridgeStatus = st.bridge ? await bridgeStatus(cfg.consoleToken) : null;
  return st;
}

/** 安全重启桥接：活着走 /api/restart（守护窗口 5 秒拉起），死了直接 start.bat */
async function restartBridge(cfg) {
  const oldPid = readLockPid();
  const alive = await portOpen(3100);
  if (alive) {
    console.log(`  桥接活着（pid=${oldPid || '?'}），走控制台 /api/restart（干净重启，锁会正常释放）…`);
    try {
      await fetch(`http://127.0.0.1:3100/api/restart?token=${encodeURIComponent(cfg.consoleToken)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000),
      });
    } catch { /* 重启瞬间连接被掐断是预期行为 */ }
  } else {
    console.log('  桥接没在跑，直接拉起守护窗口 …');
    startBatDetached(BAT_BRIDGE, 'qq-bridge', 'qq-bridge');
  }
  const ok = await waitForBridge(oldPid);
  if (!ok) { console.log('  ❌ 重启后桥接没回来。'); return false; }
  const s = await bridgeStatus(cfg.consoleToken);
  if (!s) { console.log('  ❌ 3100 通了但 /api/status 不正常。'); return false; }
  console.log(`  ✅ 桥接已回来：mode=${s.mode} dshReady=${s.dshReady} role=${s.role} paused=${s.socialV2Paused}`);
  if (s.socialV2Paused === true) console.log('  ⚠️ 二代 AI 处于暂停状态（不会回话）。去控制台点“恢复”，或告诉我帮你恢复。');
  return true;
}

function currentPreset(cfg) {
  if (cfg.dsh?.provider === PRESETS.glm.provider) return 'glm';
  if (cfg.dsh?.provider === PRESETS.ds.provider) return 'ds';
  return null;
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

function saveConfig(cfg) {
  const backup = path.join(ROOT, 'config.before-toggle.json');
  fs.copyFileSync(CONFIG, backup);
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`  已写入 config.json（原文件备份到 ${path.basename(backup)}）`);
}

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const cfg = loadConfig();
  const cur = currentPreset(cfg);
  const curLabel = cur ? `${PRESETS[cur].provider}/${PRESETS[cur].model}` : `${cfg.dsh?.provider}/${cfg.dsh?.model}（不在预设里）`;

  if (arg === 'status') {
    console.log(`当前模型：${curLabel}`);
    console.log(`effort：${cfg.dsh?.reasoningEffort ?? '(默认)'}`);
    await ensureServices(cfg, { fix: false });
    return;
  }

  if (arg === 'up') {
    const st = await ensureServices(cfg, { fix: true });
    if (st.fatal) process.exit(1);
    console.log('完成：链路已在线，模型未改动。');
    return;
  }

  // ── 切换 ──
  if (!cur) {
    console.log(`❌ 当前 dsh.provider=${cfg.dsh?.provider} 不在预设里，不猜。请手工改 ${CONFIG} 后重启桥接。`);
    process.exit(1);
  }
  const target = cur === 'glm' ? 'ds' : 'glm';
  console.log(`当前：${curLabel}`);
  console.log(`目标：${PRESETS[target].provider}/${PRESETS[target].model} —— ${PRESETS[target].label}`);
  if (arg !== '-y' && arg !== 'switch') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question('确认切换？回车=确认，输入 n=取消：')).trim().toLowerCase();
    rl.close();
    if (ans === 'n' || ans === 'no') { console.log('已取消，什么都没改。'); return; }
  }

  cfg.dsh.provider = PRESETS[target].provider;
  cfg.dsh.model = PRESETS[target].model;
  saveConfig(cfg);

  console.log('重启桥接让新配置生效 …');
  const st = await ensureServices(cfg, { fix: true });
  if (st.fatal) process.exit(1);
  const ok = await restartBridge(cfg);
  if (!ok) process.exit(1);

  console.log('');
  console.log(`✅ 切换完成：机器人现在用 ${PRESETS[target].provider}/${PRESETS[target].model}`);
  if (target === 'glm') {
    console.log('   提醒：GLM 在 DSH 里注册为纯文本——发照片/表情图它看不见。想验证就发张图，难受就再跑一次本脚本切回 DeepSeek。');
  } else {
    console.log('   提醒：DeepSeek 按量计费，看图正常。');
  }
  console.log('   下一次机器人被唤醒时，state\\bridge.log 会写：已设置会话模型 … -> ' + PRESETS[target].provider + '/' + PRESETS[target].model);
}

main().catch((e) => { console.log('❌ 出错：' + (e?.message ?? e)); process.exit(1); });
