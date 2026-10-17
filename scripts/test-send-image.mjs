// qq_send_image 的「路径安全边界」回归测试（只读源码 + 临时目录，绝不碰真实 assets）。
//
// 背景：2026-10-03 给机器人加了「发图片」能力（qq_send_image）。它能读磁盘文件并发到 QQ，
// 所以边界必须由桥接硬校验：只能发 assets/ 目录里的**图片**，realpath 之后也不许跳出目录
// （防符号链接/junction 把 .credentials.yaml 之类的东西当"图片"发出去）。
//
// 与 test-lock-identity.mjs 同一套路：从 src/bridge.js **抽取真实的
// resolveImageFileUnderRoot 源码文本**再执行，测的是文件里那份代码，不是复制品。
//
// 用法：node scripts/test-send-image.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '..', 'src', 'bridge.js');

const source = fs.readFileSync(BRIDGE, 'utf8');
const from = source.indexOf('const IMAGE_EXT_WHITELIST');
const to = source.indexOf('// ── 配置 ──');
if (from < 0 || to < 0 || to <= from) {
  console.error('❌ 抽取失败：在 src/bridge.js 里找不到 resolveImageFileUnderRoot 代码段');
  process.exit(1);
}
const code = source.slice(from, to);
const build = new Function('fs', 'path', `${code}\nreturn { resolveImageFileUnderRoot, IMAGE_EXT_WHITELIST };`);
const mod = build(fs, path);

// ── 临时环境 ────────────────────────────────────────────────────────────────
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-image-test-'));
const root = path.join(base, 'assets');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(root, 'outbox'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const write = (rel, buf) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
};
write('face.png', PNG_1x1);
write('outbox/pic.PNG', PNG_1x1);          // 大写扩展名也要认
write('secret.yaml', 'api_key: hunter2');  // 非图片：必须拒
write('empty.png', Buffer.alloc(0));
write('big.png', Buffer.alloc(4096, 1));
write('dir.png/inside.png', PNG_1x1);      // 目录名带 .png 后缀的干扰项
fs.writeFileSync(path.join(outside, 'evil.png'), PNG_1x1);

let symlinkOk = false;
try {
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  symlinkOk = true;
} catch {}

// ── 断言 ────────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function ok(desc, fn) {
  try {
    fn();
    console.log(`  ✅ ${desc}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${desc}\n       ${e?.message ?? e}`);
    fail++;
  }
}
function rejects(desc, relPath, opts, expectRe) {
  ok(desc, () => {
    let threw = null;
    try {
      mod.resolveImageFileUnderRoot(root, relPath, opts);
    } catch (e) {
      threw = e;
    }
    if (!threw) throw new Error('本应拒绝，却通过了');
    if (expectRe && !expectRe.test(String(threw.message))) {
      throw new Error(`拒绝原因不符：${threw.message}`);
    }
  });
}

console.log('源文件：' + BRIDGE);
console.log('临时 assets：' + root + '\n');

ok('普通 png（贴根目录）可发', () => {
  const r = mod.resolveImageFileUnderRoot(root, 'face.png');
  if (r.relPath !== 'face.png') throw new Error('relPath 不对：' + r.relPath);
  if (r.size !== PNG_1x1.length) throw new Error('size 不对：' + r.size);
});

ok('子目录 + 大写扩展名 .PNG 可发', () => {
  const r = mod.resolveImageFileUnderRoot(root, 'outbox/pic.PNG');
  if (r.ext !== '.png') throw new Error('ext 未归一化：' + r.ext);
  if (!r.relPath.replace(/\\/g, '/').startsWith('outbox/')) throw new Error('relPath 不对：' + r.relPath);
});

ok('带 .png 后缀的目录里的文件可发', () => {
  mod.resolveImageFileUnderRoot(root, 'dir.png/inside.png');
});

rejects('相对路径越界 ../outside/evil.png 被拒', '../outside/evil.png', {}, /只允许发送 assets 目录里的图片/);
rejects('绝对路径越界被拒', path.join(outside, 'evil.png'), {}, /只允许发送 assets 目录里的图片/);
rejects('非图片扩展名（.yaml）被拒', 'secret.yaml', {}, /只允许发送图片文件/);
rejects('无扩展名被拒', 'outbox', {}, /只允许发送图片文件/);
rejects('空路径被拒', '   ', {}, /路径不能为空/);
rejects('含 NUL 的路径被拒', 'face\u0000.png', {}, /路径不合法/);
rejects('不存在的文件被拒', 'nope.png', {}, /找不到图片文件/);
rejects('空文件被拒', 'empty.png', {}, /空文件/);
rejects('超过 maxBytes 被拒', 'big.png', { maxBytes: 1024 }, /图片太大/);
ok('同样这个文件，上限放宽后可发', () => {
  mod.resolveImageFileUnderRoot(root, 'big.png', { maxBytes: 8192 });
});

if (symlinkOk) {
  rejects('符号链接跳出 assets 被拒', 'link/evil.png', {}, /跳出了 assets 目录|只允许发送 assets 目录里的图片/);
} else {
  console.log('  ⚠️  跳过符号链接用例：本机无法创建 junction/symlink');
}

ok('扩展名白名单内容正确', () => {
  const want = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  for (const e of want) if (!mod.IMAGE_EXT_WHITELIST.has(e)) throw new Error('缺少 ' + e);
  if (mod.IMAGE_EXT_WHITELIST.has('.yaml')) throw new Error('白名单混入了 .yaml');
});

try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {}

console.log(`\n结果：${pass}/${pass + fail} 通过${fail ? `，${fail} 失败` : ''}`);
process.exit(fail ? 1 : 0);
