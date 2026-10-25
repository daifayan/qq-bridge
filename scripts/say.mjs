// 让鲸鲸用语音说一句话 —— 试听 / 验收用，不经过 AI，不依赖 DSH。
//
// 用法：
//   node scripts/say.mjs "你好呀，我是鲸鲸"            发给 config.json 里的 ownerQQ
//   node scripts/say.mjs "你好呀" 123456               发给指定 QQ
//   node scripts/say.mjs --dry "你好呀"                只合成到 state/say.wav，不发 QQ
//
// 读的是 config.json 里的 voice 段，所以调好的音色/语速跟线上一致。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTts } from '../src/tts.js'
import { toSpeakable } from '../src/tts-text.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const voiceCfg = cfg.voice || {}

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const rest = args.filter((a) => a !== '--dry')
const text = rest[0] || '你好呀，我是鲸鲸。'
const target = Number(rest[1] || cfg.ownerQQ)

const speakable = toSpeakable(text, { maxChars: 0 })
if (!speakable) {
  console.error('清洗后没有可念的内容：', JSON.stringify(text))
  process.exit(1)
}

const tts = createTts(voiceCfg, { log: (m) => console.log('[tts]', m), rootDir: ROOT })
const t0 = Date.now()
const audio = await tts.synthesize(speakable, { timeoutMs: Number(voiceCfg.timeoutMs) || 25000 })
const dur = audio.format === 'wav' ? (audio.wav.length - 44) / 2 / (audio.sampleRate || 22050) : 0
console.log(`合成 ${Date.now() - t0}ms / 音频 ${dur.toFixed(2)}s / ${audio.wav.length} 字节`)
console.log(`念的是：${speakable}`)

if (dry) {
  const out = path.join(ROOT, 'state', 'say.wav')
  fs.writeFileSync(out, audio.wav)
  console.log('已写出', out)
} else {
  const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const res = await fetch(`${httpUrl}/send_private_msg`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
    },
    body: JSON.stringify({ user_id: target, message: [{ type: 'record', data: { file: 'base64://' + audio.wav.toString('base64') } }] }),
    signal: AbortSignal.timeout(30000)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    console.error('发送失败：', res.status, JSON.stringify(body))
    tts.close()
    process.exit(1)
  }
  console.log(`已发给 ${target}（message_id ${body.data?.message_id}）`)
}

tts.close()
