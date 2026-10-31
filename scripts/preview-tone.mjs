// 调音台同款引擎的命令行版：一句话 → 一个 wav 文件，方便 A/B 对比。
//
// 用法：
//   node scripts/preview-tone.mjs "你好呀，我是鲸鲸"
//   node scripts/preview-tone.mjs "你好呀" --pitch 2 --speed 1.05 --gain 1.1
//   node scripts/preview-tone.mjs "你好呀" --emotion 0.8       按情绪自动选档
//   node scripts/preview-tone.mjs --batch                       一次生成一组对比样本
//
// 读 config.json 的 voice 段，所以参数跟线上一致；--out 默认 state/tone-preview.wav。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTts } from '../src/tts.js'
import { toSpeakable } from '../src/tts-text.js'
import { emotionScore } from '../src/voice-policy.js'
import { resolveTone } from '../src/voice-tone.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const voiceCfg = cfg.voice || {}
const local = voiceCfg.local || {}

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const text = String(flag('text', positional[0] || '你好呀，我是鲸鲸。'))

const tts = createTts(voiceCfg, { log: (m) => console.log('[tts]', m), rootDir: ROOT })
const timeoutMs = Number(voiceCfg.timeoutMs) || 25000

async function render(label, input, opts, outFile) {
  const t0 = Date.now()
  const audio = await tts.synthesize(input, { timeoutMs, ...opts })
  const dur = (audio.wav.length - 44) / 2 / (audio.sampleRate || 22050)
  fs.writeFileSync(outFile, audio.wav)
  console.log(
    `${label.padEnd(12)} pitch=${String(audio.pitch).padStart(5)} speed=${audio.speed.toFixed(2)} ` +
      `gain=${audio.gain.toFixed(2)} → ${dur.toFixed(2)}s / 合成 ${Date.now() - t0}ms → ${path.relative(ROOT, outFile)}`
  )
  return dur
}

const speakable = toSpeakable(text, { maxChars: 0 })
if (!speakable) {
  console.error('清洗后没有可念的内容：', JSON.stringify(text))
  process.exit(1)
}
const outDir = path.join(ROOT, 'state', 'tone-preview')
fs.mkdirSync(outDir, { recursive: true })

if (flag('batch', false)) {
  console.log(`样本：${speakable}\n`)
  const base = { speed: Number(local.speed) || 1, sid: Number(local.sid) || 0, gain: 1 }
  const rows = [
    ['原声', 0],
    ['+1 半音', 1],
    ['+2 半音', 2],
    ['+3 半音', 3],
    ['-2 半音', -2]
  ]
  const durs = []
  for (const [label, pitch] of rows) {
    durs.push(await render(label, speakable, { ...base, pitch }, path.join(outDir, `pitch-${pitch}.wav`)))
  }
  const spread = Math.max(...durs) - Math.min(...durs)
  console.log(`\n时长差 ${spread.toFixed(3)}s（越小说明变调没改时长，理想 < 0.15s）`)
} else {
  const emotion = flag('emotion', null)
  const tone = resolveTone({
    tone: voiceCfg.tone || {},
    emotion: emotion === null ? emotionScore(speakable) : Number(emotion),
    baseSpeed: Number(local.speed) || 1,
    baseSid: Number(local.sid) || 0
  })
  // --speed 是「这一句」的最终倍速，不再乘一遍情绪档
  const speed = flag('speed', null)
  const pitch = flag('pitch', null)
  const gain = flag('gain', null)
  const opts = {
    speed: speed === null ? tone.speed : Number(speed),
    sid: tone.sid,
    pitch: pitch === null ? tone.pitch : Number(pitch),
    gain: gain === null ? tone.gain : Number(gain)
  }
  console.log(`情绪档=${tone.band}（emotionScore ${emotionScore(speakable).toFixed(2)}）`)
  await render('单句', speakable, opts, path.resolve(ROOT, String(flag('out', 'state/tone-preview.wav'))))
}

tts.close()
