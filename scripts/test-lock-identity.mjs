// 单实例锁的「身份复核」回归测试（只读源码 + 临时目录，绝不碰真实 state/bridge.lock）。
//
// 背景：2026-10-01 事故 —— state/bridge.lock 里存的是上一次桥接的 PID(10792)，Windows 把这个号复用给了
// D:\QQNT\QQ.exe，于是 bridge.js 的 `process.kill(pid,0)` 成功 → 判「已有实例在运行」→ exit 2 →
// start.bat 遇 exit 2 会 pause 停住 → 桥接永远起不来（机器人「进不去」）。
//
// 本测试直接从 src/bridge.js 里**抽取真实的锁代码文本**（LOCK_FILE 常量的定义 → acquireLock 结束），
// 注入假的 STATE_DIR / console / process 后逐条验证分支，所以测的是"文件里那份代码"，不是复制品。
//
// 用法：node scripts/test-lock-identity.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '..', 'src', 'bridge.js');
const REAL_LOCK = path.resolve(HERE, '..', 'state', 'bridge.lock');

// ── 抽取真实源码文本 ────────────────────────────────────────────────────────
const source = fs.readFileSync(BRIDGE, 'utf8');
const from = source.indexOf('const LOCK_FILE = path.join(STATE_DIR');
const to = source.indexOf('function releaseLock');
if (from < 0 || to < 0 || to <= from) {
  console.error('❌ 抽取失败：在 src/bridge.js 里找不到锁代码段（LOCK_FILE … releaseLock）');
  process.exit(1);
}
const lockSource = source.slice(from, to);

// ── 测试脚手架 ──────────────────────────────────────────────────────────────
const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-test-'));
const TEST_LOCK = path.join(TEST_STATE, 'bridge.lock');
const realProcess = process;
const exits = [];                 // 记录每次 process.exit(code)：真身会当场结束进程，测试里只能"抛"来模拟，
let errors = [];                  // 而抛出会被源码自己的 catch 二次捕获 → 一律以"第一次 exit"为准判定。
const fakeProcess = {
  pid: 424242,
  kill: (...args) => realProcess.kill(...args),
  exit: (code) => { exits.push(code); throw new Error(`__EXIT_${code}__`); },
};
const fakeConsole = { error: (...a) => errors.push(a.join(' ')), log: () => {} };
const build = new Function(
  'fs', 'path', 'spawnSync', 'STATE_DIR', 'console', 'process',
  `${lockSource}\nreturn { acquireLock, lockPidImage, lockPidHoldsPort, LOCK_FILE };`,
);
const mod = build(fs, path, spawnSync, TEST_STATE, fakeConsole, fakeProcess);
const cleanErrors = () => errors.filter((e) => !e.includes('__EXIT') && !e.includes('无法读取'));

function reset() { exits.length = 0; errors = []; try { fs.unlinkSync(TEST_LOCK); } catch {} }
function lockWith(content, ageMs = 0) {
  fs.writeFileSync(TEST_LOCK, content);
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(TEST_LOCK, t, t);
  }
}
function run(port) {
  try { mod.acquireLock(port ?? 3100); } catch (e) { if (!String(e.message).startsWith('__EXIT_')) throw e; }
}

// ── 找几个真实进程当素材 ────────────────────────────────────────────────────
function imageOf(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const m = String(r.stdout || '').trim().match(/^"([^"]*)"/);
  return m ? m[1] : '';
}
function listeners() {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  const out = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] !== 'TCP') continue;
    const m = cols[1].match(/:(\d+)$/);
    if (!m) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) out.push({ port: Number(m[1]), pid });
  }
  return out;
}
const live = listeners();
const nodeListener = live.find((x) => /^node(\.exe)?$/i.test(imageOf(x.pid)));
// 素材必须"当前用户能给它发信号"（process.kill(pid,0) 不抛）：
// SYSTEM 进程会抛 EPERM，会先撞上源码里"查不到身份就保守不接管"的老分支，测不到本次新增的判据。
function signalable(pid) { try { realProcess.kill(pid, 0); return true; } catch { return false; } }
function allProcesses() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const out = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m) out.push({ image: m[1], pid: Number(m[2]) });
  }
  return out;
}
const procs = allProcesses();
const foreignListener = live
  .filter((x) => x.pid !== realProcess.pid && signalable(x.pid) && imageOf(x.pid) && !/^node(\.exe)?$/i.test(imageOf(x.pid)))
  .sort((a, b) => (imageOf(b.pid).toLowerCase() === 'qq.exe') - (imageOf(a.pid).toLowerCase() === 'qq.exe'))[0]
  ?? procs.filter((p) => /^qq(\.exe)?$/i.test(p.image) && signalable(p.pid))[0];

// ── 用例 ────────────────────────────────────────────────────────────────────
let pass = 0; let fail = 0; const skipped = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n       期望/实际：${detail}`); }
}
function tookOver() { return exits.length === 0 && fs.existsSync(TEST_LOCK) && fs.readFileSync(TEST_LOCK, 'utf8').trim() === '424242'; }
function refused() { return exits[0] === 2; }
function exitText() { return `exit=${exits.join('/') || '（未退出）'}`; }

console.log(`源码：${BRIDGE}`);
console.log(`测试用 STATE_DIR：${TEST_STATE}（真实锁 ${REAL_LOCK} 不会被碰）`);
const realLockBefore = fs.existsSync(REAL_LOCK) ? fs.readFileSync(REAL_LOCK, 'utf8').trim() : null;

console.log('\n[1] 锁文件不存在 → 正常建锁');
run(); check('建锁成功且内容是自己的 PID', tookOver(), `${exitText()} content=${fs.existsSync(TEST_LOCK) ? fs.readFileSync(TEST_LOCK, 'utf8') : '(无)'}`);

console.log('\n[2] 锁里是"已死"的 PID → 判过期锁并接管');
reset(); lockWith('999999', 60_000); run();
check('接管（内容是自己的 PID）', tookOver(), exitText());
check('日志说明是过期锁', cleanErrors().some((e) => e.includes('过期锁文件')), cleanErrors().join(' | '));

console.log('\n[3] 锁内容为空 / 非数字 → 判过期锁并接管');
reset(); lockWith('', 60_000); run();
check('空内容 → 接管', tookOver(), exitText());
reset(); lockWith('abc', 60_000); run();
check('非数字 → 接管', tookOver(), exitText());

console.log('\n[4] ★ PID 被复用给别的程序（QQ.exe）→ 判过期锁并接管（本次事故场景）');
if (!foreignListener) { skipped.push('[4] 没找到"当前用户能发信号的非 node 进程"当素材'); console.log('  ⚠️ 跳过：没找到素材'); }
else {
  reset(); lockWith(String(foreignListener.pid), 60_000); run();
  check(`接管（锁里 ${foreignListener.pid} = ${imageOf(foreignListener.pid)}，不是 node）`, tookOver(), `${exitText()} err=${cleanErrors().join(' | ')}`);
  check('日志点名"被系统复用给 …"', cleanErrors().some((e) => e.includes('已被系统复用给')), cleanErrors().join(' | '));
}

console.log('\n[5] 锁里是活的 node 进程，但**没有**占着控制台端口，且锁已存在很久 → 判过期锁并接管');
reset(); lockWith(String(realProcess.pid), 60_000); run(3100);
check('接管', tookOver(), `${exitText()} err=${cleanErrors().join(' | ')}`);
check('日志说明"没有占着控制台端口"', cleanErrors().some((e) => e.includes('没有占着控制台端口')), cleanErrors().join(' | '));

console.log('\n[6] 锁里是活的 node 进程 + 锁很新（<15s，可能是刚启动的兄弟进程）→ 保守拒绝');
reset(); lockWith(String(realProcess.pid), 0); run(3100);
check('拒绝（exit 2）', refused(), exitText());
check('锁文件未被改动', fs.readFileSync(TEST_LOCK, 'utf8').trim() === String(realProcess.pid), fs.readFileSync(TEST_LOCK, 'utf8'));
check('日志提示"已有实例在运行"', cleanErrors().some((e) => e.includes('已有实例在运行')), cleanErrors().join(' | '));

console.log('\n[7] 锁里是活的 node 进程 + 它**真的**占着那个端口 → 拒绝（真·另一个桥接在跑）');
if (!nodeListener) { skipped.push('[7] 没找到"node 在监听某端口"当素材'); console.log('  ⚠️ 跳过：没找到素材'); }
else {
  reset(); lockWith(String(nodeListener.pid), 60_000); run(nodeListener.port);
  check(`拒绝（exit 2；${nodeListener.pid} 确实占着 ${nodeListener.port}）`, refused(), `${exitText()} err=${cleanErrors().join(' | ')}`);
  check('锁文件未被动', fs.readFileSync(TEST_LOCK, 'utf8').trim() === String(nodeListener.pid), '内容被改了');
}

console.log('\n[8] 辅助函数直测');
reset();
const selfImg = mod.lockPidImage(realProcess.pid);
check(`lockPidImage(自己) = ${selfImg.image}`, selfImg.ok && /^node(\.exe)?$/i.test(selfImg.image), JSON.stringify(selfImg));
check('lockPidImage(不存在的 PID) → ok 且 image 为空', (() => { const r = mod.lockPidImage(999999); return r.ok && r.image === ''; })(), JSON.stringify(mod.lockPidImage(999999)));
const holdsSelf = mod.lockPidHoldsPort(3100, realProcess.pid);
check('lockPidHoldsPort(3100, 自己) = false（测试进程没监听 3100）', holdsSelf === false, String(holdsSelf));

// ── 收尾 ────────────────────────────────────────────────────────────────────
const realLockAfter = fs.existsSync(REAL_LOCK) ? fs.readFileSync(REAL_LOCK, 'utf8').trim() : null;
console.log('\n[9] 安全检查：真实锁文件未被触碰');
check(`真实锁前后一致（${realLockBefore} → ${realLockAfter}）`, realLockBefore === realLockAfter, `${realLockBefore} → ${realLockAfter}`);

try { fs.rmSync(TEST_STATE, { recursive: true, force: true }); } catch {}
if (skipped.length) console.log(`\n跳过 ${skipped.length} 项：\n  - ${skipped.join('\n  - ')}`);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
