// 视频分镜自检：给一个本地视频，跑完整链路（探测 → 切点 → 宫格 → 清单）。
// 用法：
//   node scripts/test-video-storyboard.mjs <视频路径> [--cells 9]
//   node scripts/test-video-storyboard.mjs            # 不传路径时只做「能不能用」的静态检查
//
// 检查项：
//   1. config.video 段存在且 enabled 不是 false
//   2. 能找到 dsh-video-storyboard 的 CLI（找不到说明插件没装）
//   3. ffmpeg/ffprobe 能被插件解析到（走 ~/.dsh/tools/ffmpeg/bin 或 PATH）
//   4. 真跑一遍：产出 PNG + 带时间码的清单
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVideoStoryboard, resolveStoryboardBin } from '../src/video-storyboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const argv = process.argv.slice(2);
const videoPath = argv.find((a) => !a.startsWith('--'));
const cellsIdx = argv.indexOf('--cells');
const cells = cellsIdx >= 0 ? Number(argv[cellsIdx + 1]) || 9 : 9;

const config = readJson(path.join(ROOT, 'config.json'));
console.log('视频分镜自检');

check('config.video 存在', Boolean(config.video), config.video ? `enabled=${config.video.enabled}` : '缺失');
check('config.video.enabled 未关闭', config.video?.enabled !== false);

const bin = resolveStoryboardBin(config.video?.storyboardBin);
check('找到 storyboard CLI', Boolean(bin), bin || '请先 dsh plugin --profile web add dsh-video-storyboard');

const ffmpeg = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
check('ffmpeg 就位', fs.existsSync(ffmpeg), fs.existsSync(ffmpeg) ? ffmpeg : '未在 ~/.dsh/tools/ffmpeg/bin 找到');

if (!videoPath) {
  console.log('\n（没传视频路径，跳过实跑。用法：node scripts/test-video-storyboard.mjs <视频>）');
} else {
  check('测试视频存在', fs.existsSync(videoPath), videoPath);
  if (fs.existsSync(videoPath) && bin) {
    const storyboard = createVideoStoryboard({ cfg: config, log: (line) => console.log(`    ${line}`), stateDir: path.join(ROOT, 'state') });
    const started = Date.now();
    try {
      const result = await storyboard.run({ filePath: videoPath, tag: 'selftest' });
      check('产出 PNG', result.pngBuffer.length > 10_000, `${Math.round(result.pngBuffer.length / 1024)}KB`);
      check('清单含时间码', /\d\d:\d\d/.test(result.text), result.text.split('\n')[0]?.slice(0, 80) || '(空)');
      check('耗时在时限内', Date.now() - started < (config.video?.timeoutMs ?? 150_000), `${Date.now() - started}ms`);
      console.log(`\n产物：${result.pngPath}`);
    } catch (error) {
      check('实跑成功', false, error?.message ?? String(error));
    }
  }
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
