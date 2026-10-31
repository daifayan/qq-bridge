/**
 * 语音合成客户端：把"文字 → WAV"这一步和具体引擎解耦。
 *
 * 引擎：
 *   local —— sherpa-onnx（离线、CPU，Kokoro / VITS / Piper 模型都能喂）
 *   http  —— 任意本地 TTS 服务（GPT-SoVITS api_v2、Qwen3-TTS 之类）
 *
 * local 走独立 worker 线程：合成是同步阻塞的，放主线程会把 QQ 收发和控制台一起卡住。
 */
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { resample, applyGain, concatSamples, decodeWav, semitonesToRatio } from './voice-tone.js'

const CACHE_LIMIT = 120
const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** Float32 采样 → 16bit PCM WAV */
export function encodeWav(samples, sampleRate) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = samples[i]
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v || 0) * 32767))), 44 + i * 2)
  }
  return buf
}

/** 音频字节 → 采样率（只认 WAV/MP3 头部，够了） */
export function sniffAudio(buf) {
  if (!buf || buf.length < 12) return { format: 'unknown', sampleRate: 0 }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return { format: 'wav', sampleRate: buf.readUInt32LE(24) }
  }
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    return { format: 'mp3', sampleRate: 0 }
  }
  return { format: 'unknown', sampleRate: 0 }
}

/** 几段 WAV 拼成一条（语气词 + 正文），段之间留一小段静音 */
export function concatWav(buffers, { gapMs = 90 } = {}) {
  const decoded = (buffers || []).map((b) => decodeWav(b)).filter(Boolean)
  if (!decoded.length) throw new Error('concatWav：没有可用的 WAV')
  const sampleRate = decoded[0].sampleRate
  // 采样率不一致就不拼了 —— 硬拼会变调，宁可只念正文
  if (decoded.some((d) => d.sampleRate !== sampleRate)) throw new Error('concatWav：采样率不一致')
  const merged = concatSamples(decoded.map((d) => d.samples), { gapMs, sampleRate })
  return encodeWav(merged, sampleRate)
}

export function createTts(cfg = {}, { log = () => {}, rootDir = process.cwd() } = {}) {
  const engine = String(cfg.engine || 'local').toLowerCase()
  const cache = new Map()
  let worker = null
  let ready = null
  let lastInfo = null
  let warnedHttpPitch = false
  let seq = 0
  const waiting = new Map()

  function resolveDir(dir) {
    const s = String(dir || '')
    if (!s) return ''
    return /^[a-zA-Z]:[\\/]|^\//.test(s) ? s : `${rootDir.replace(/[\\/]+$/, '')}/${s.replace(/^[\\/]+/, '')}`
  }

  function localConfig() {
    const local = cfg.local || {}
    return {
      modelDir: resolveDir(local.modelDir || 'models/vits-piper-zh_CN-xiao_ya-medium-int8'),
      modelFile: local.modelFile || '',
      sid: Number(local.sid) || 0,
      speed: Number(local.speed) || 1,
      numThreads: Number(local.numThreads) || 2,
      provider: local.provider || 'cpu',
      lang: local.lang || 'zh',
      lengthScale: Number(local.lengthScale) || 1
    }
  }

  function failAll(error) {
    for (const [, entry] of waiting) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    waiting.clear()
  }

  function ensureWorker() {
    if (worker) return worker
    const w = new Worker(new URL('./tts-worker.js', import.meta.url))
    w.on('message', (msg) => {
      if (msg?.type === 'ready') {
        lastInfo = { sampleRate: msg.sampleRate || 0, numSpeakers: msg.numSpeakers || 1, loadMs: msg.loadMs || 0 }
        log(`TTS 就绪（${msg.loadMs}ms，采样率 ${msg.sampleRate}，${msg.numSpeakers || 1} 个音色）`)
        return
      }
      if (msg?.type === 'fatal') {
        failAll(new Error(`TTS 初始化失败：${msg.error}`))
        killWorker('初始化失败')
        return
      }
      const entry = waiting.get(msg?.id)
      if (!entry) return
      waiting.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.type === 'audio') {
        entry.resolve({ samples: msg.samples, sampleRate: msg.sampleRate, ms: msg.ms, engine: 'local' })
      } else {
        entry.reject(new Error(msg.error || 'TTS 合成失败'))
      }
    })
    w.on('error', (error) => {
      failAll(new Error(`TTS 线程错误：${error?.message ?? error}`))
      killWorker('线程错误')
    })
    w.on('exit', (code) => {
      if (worker === w) {
        worker = null
        ready = null
      }
      if (code !== 0) failAll(new Error(`TTS 线程退出（code=${code}）`))
    })
    worker = w
    ready = null
    return w
  }

  function killWorker(reason) {
    if (!worker) return
    const w = worker
    worker = null
    ready = null
    try {
      w.terminate()
    } catch {}
    log(`TTS 线程已回收（${reason}）`)
  }

  function synthLocal(text, { timeoutMs = 20000, speed, sid } = {}) {
    const w = ensureWorker()
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`TTS 合成超时（${timeoutMs}ms）`))
        killWorker('合成超时')
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      const local = localConfig()
      w.postMessage({ type: 'synth', id, text, sid: sid ?? local.sid, speed: speed ?? local.speed, local })
    })
  }

  async function synthHttp(text, timeoutMs) {
    const http = cfg.http || {}
    const url = String(http.url || '')
    if (!url) throw new Error('voice.http.url 未配置')
    const headers = { ...(http.headers || {}) }
    let res
    if (String(http.method || 'POST').toUpperCase() === 'GET') {
      const q = String(http.queryTemplate || 'text={text}').replace(/\{text\}/g, encodeURIComponent(text))
      res = await fetch(`${url}${url.includes('?') ? '&' : '?'}${q}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ text, ...(http.extraBody || {}) }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    }
    if (!res.ok) throw new Error(`TTS 服务返回 ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 128) throw new Error('TTS 服务返回的音频为空')
    const { format } = sniffAudio(buffer)
    return { wav: buffer, format: format === 'wav' ? 'wav' : format, ms: 0, engine: 'http' }
  }

  /**
   * 合成一段文字。
   *
   * opts 里的 speed / sid / pitch / gain 是「这一句」的覆盖值（不传就用 config 里的），
   * 所以调音台改完参数不用重启桥接 —— 下一句就按新参数念。
   *
   * pitch 单位是半音：内部让模型按 1/r 的语速念，再把波形按 r 重采样，
   * 时长不变、音高变（原理见 voice-tone.js）。
   *
   * @returns {Promise<{wav: Buffer, format: string, sampleRate: number, ms: number, engine: string}>}
   */
  async function synthesize(text, { timeoutMs = 20000, speed, sid, pitch, gain } = {}) {
    const input = String(text ?? '').trim()
    if (!input) throw new Error('TTS 输入为空')
    if (engine === 'off') throw new Error('语音引擎已关闭')

    const local = localConfig()
    const semitones = clamp(num(pitch, 0), -8, 8)
    const ratio = semitonesToRatio(semitones)
    const finalSpeed = clamp(num(speed, local.speed), 0.5, 2)
    const finalSid = Math.max(0, Math.round(num(sid, local.sid)))
    const finalGain = clamp(num(gain, 1), 0.3, 3)
    // 变调 = 先按 1/r 的语速念 + 再按 r 重采样 → 时长回到原样，音高 ×r
    const modelSpeed = clamp(finalSpeed / ratio, 0.4, 2.5)

    const key = createHash('sha1')
      .update(`${engine}|${JSON.stringify(cfg.local || {})}|${finalSpeed}|${finalSid}|${ratio}|${finalGain}|${input}`)
      .digest('hex')
    if (cache.has(key)) return { ...cache.get(key), cached: true }

    let result
    if (engine === 'http') {
      result = await synthHttp(input, timeoutMs)
      const { format, sampleRate } = sniffAudio(result.wav)
      result.sampleRate = result.sampleRate || sampleRate
      // HTTP 引擎给的若是 16bit PCM WAV，也能变调；mp3 就得交给上游自己处理
      if (format === 'wav' && (Math.abs(ratio - 1) > 1e-6 || Math.abs(finalGain - 1) > 1e-3)) {
        const decoded = decodeWav(result.wav)
        if (decoded) {
          let samples = decoded.samples
          if (Math.abs(ratio - 1) > 1e-6) samples = resample(samples, ratio)
          if (Math.abs(finalGain - 1) > 1e-3) samples = applyGain(samples, finalGain)
          result.wav = encodeWav(samples, decoded.sampleRate)
          result.sampleRate = decoded.sampleRate
        }
      } else if (format !== 'wav' && Math.abs(ratio - 1) > 1e-6 && !warnedHttpPitch) {
        warnedHttpPitch = true
        log('⚠️ HTTP 引擎返回的不是 WAV，变调被忽略（要变调请让上游输出 wav）')
      }
    } else if (engine === 'local') {
      const out = await synthLocal(input, { timeoutMs, speed: modelSpeed, sid: finalSid })
      let samples = out.samples
      if (Math.abs(ratio - 1) > 1e-6) samples = resample(samples, ratio)
      if (Math.abs(finalGain - 1) > 1e-3) samples = applyGain(samples, finalGain)
      const wav = encodeWav(samples, out.sampleRate)
      result = { wav, format: 'wav', sampleRate: out.sampleRate, ms: out.ms, engine: 'local' }
    } else {
      throw new Error(`未知的语音引擎：${engine}`)
    }
    result.pitch = semitones
    result.speed = finalSpeed
    result.gain = finalGain
    result.sid = finalSid

    if (cache.size >= CACHE_LIMIT) {
      const first = cache.keys().next().value
      if (first) cache.delete(first)
    }
    cache.set(key, result)
    return result
  }

  return {
    engine,
    synthesize,
    /** 模型加载后的实况（音色数 / 采样率）；还没加载过就是 null */
    get info() {
      return lastInfo
    },
    /** 提前把模型加载好，免得第一句语音多等几秒 */
    warmup() {
      if (engine !== 'local') return
      try {
        ensureWorker().postMessage({ type: 'init', local: localConfig() })
      } catch (error) {
        log(`TTS 预热失败：${error?.message ?? error}`)
      }
    },
    close() {
      killWorker('关闭')
      cache.clear()
    },
    get running() {
      return Boolean(worker)
    }
  }
}
