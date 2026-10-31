/**
 * 语音"调音"：不换模型，只改输出波形。
 *
 * 三件事：
 *   1. 情绪分档 —— 用 voice-policy 的 emotionScore 把一句话归到 calm / normal / soft
 *   2. 半音变调 —— 关键技巧：让模型按 1/r 的语速念，再把音频按 r 重采样。
 *      时长不变、音高变 r 倍，共振峰跟着上移 —— 正好是"更幼更软"的效果，
 *      而且时间伸缩交给神经网络做，比 OLA/WSOLA 那套老 DSP 干净得多。
 *   3. 音量 —— 乘增益 + 软限幅，防止 QQ 那边爆音。
 *
 * 纯函数，不碰 IO，方便 scripts/test-voice-tone.mjs 直接测。
 */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** 情绪分档阈值（emotionScore 是 0..1） */
export const BAND_THRESHOLDS = { calm: 0.15, soft: 0.5 }

/** 默认调音参数：config.json 里没写、或者老配置升级上来时用这套 */
export const DEFAULT_TONE = {
  enabled: true,
  pitch: 0,
  gain: 1,
  emotion: {
    on: true,
    calm: { pitch: -0.6, speed: 0.97 },
    normal: { pitch: 0, speed: 1 },
    soft: { pitch: 1.2, speed: 1.02 }
  },
  clips: { on: false, chance: 0.25, gapMs: 90, list: ['诶嘿', '唔…', '嗯？', '啊这'] }
}

/**
 * 把外部传进来的 tone（控制台提交的、config 里的）洗成安全值。
 * 音调/倍速/音量全部夹在安全范围，语气词限长限数量 —— 面板传什么都不会把语音搞坏。
 */
export function sanitizeTone(input = {}) {
  const t = input || {}
  const band = (b, d) => {
    const out = {
      pitch: clamp(num(b?.pitch, d.pitch), -8, 8),
      speed: clamp(num(b?.speed, d.speed), 0.5, 2)
    }
    if (b && b.sid !== undefined && b.sid !== null && b.sid !== '') {
      out.sid = Math.max(0, Math.round(num(b.sid, 0)))
    }
    return out
  }
  const em = t.emotion || {}
  const clips = t.clips || {}
  return {
    enabled: t.enabled !== false,
    pitch: clamp(num(t.pitch, 0), -8, 8),
    gain: clamp(num(t.gain, 1), 0.3, 3),
    emotion: {
      on: em.on !== false,
      calm: band(em.calm, DEFAULT_TONE.emotion.calm),
      normal: band(em.normal, DEFAULT_TONE.emotion.normal),
      soft: band(em.soft, DEFAULT_TONE.emotion.soft)
    },
    clips: {
      on: clips.on === true,
      chance: clamp(num(clips.chance, DEFAULT_TONE.clips.chance), 0, 1),
      gapMs: clamp(Math.round(num(clips.gapMs, DEFAULT_TONE.clips.gapMs)), 0, 600),
      list: (Array.isArray(clips.list) ? clips.list : DEFAULT_TONE.clips.list)
        .map((s) => String(s ?? '').trim().slice(0, 8))
        .filter(Boolean)
        .slice(0, 12)
    }
  }
}

/** 情绪浓度 → 档位 */
export function bandOf(emotion) {
  const e = clamp(num(emotion, 0), 0, 1)
  if (e >= BAND_THRESHOLDS.soft) return 'soft'
  if (e < BAND_THRESHOLDS.calm) return 'calm'
  return 'normal'
}

/** 半音 → 频率倍率（+12 半音 = 2 倍） */
export function semitonesToRatio(semitones) {
  return Math.pow(2, num(semitones, 0) / 12)
}

/**
 * 把「基础设置 + 情绪档位」合成这一句真正要用的参数。
 *
 * @param {object} p
 * @param {object} [p.tone]       config.voice.tone
 * @param {number} [p.emotion]    emotionScore(text)，0..1
 * @param {number} [p.baseSpeed]  config.voice.local.speed
 * @param {number} [p.baseSid]    config.voice.local.sid
 * @returns {{enabled:boolean, band:string, pitch:number, speed:number, gain:number, sid:number, ratio:number}}
 */
export function resolveTone({ tone = {}, emotion = 0, baseSpeed = 1, baseSid = 0 } = {}) {
  const t = tone || {}
  const band = bandOf(emotion)
  const speed0 = clamp(num(baseSpeed, 1), 0.5, 2)
  const sid0 = Math.max(0, Math.round(num(baseSid, 0)))

  if (t.enabled === false) {
    return { enabled: false, band, pitch: 0, speed: speed0, gain: 1, sid: sid0, ratio: 1 }
  }

  let pitch = num(t.pitch, 0)
  let speed = speed0
  let gain = num(t.gain, 1)
  let sid = sid0

  const em = t.emotion || {}
  if (em.on !== false) {
    const b = em[band] || {}
    pitch += num(b.pitch, 0)
    speed *= num(b.speed, 1)
    // 只有明确配了 sid 才覆盖（0 是合法音色号，不能用真假判断）
    if (b.sid !== undefined && b.sid !== null && b.sid !== '') {
      sid = Math.max(0, Math.round(num(b.sid, sid)))
    }
  }

  pitch = clamp(pitch, -8, 8)
  speed = clamp(speed, 0.5, 2)
  gain = clamp(gain, 0.3, 3)
  return { enabled: true, band, pitch, speed, gain, sid, ratio: semitonesToRatio(pitch) }
}

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))

/**
 * 重采样（Lanczos-3）。ratio > 1 = 音高变高、时长变短。
 * 降采样时把截止频率压到 1/ratio，避免混叠（不然变调会有"沙沙"的毛刺）。
 */
export function resample(input, ratio, { taps = 3 } = {}) {
  const samples = input instanceof Float32Array ? input : Float32Array.from(input || [])
  const n = samples.length
  const r = num(ratio, 1)
  if (!n || Math.abs(r - 1) < 1e-6) return samples

  const outLen = Math.max(1, Math.round(n / r))
  const out = new Float32Array(outLen)
  const a = Math.max(1, Math.round(num(taps, 3)))
  const cutoff = Math.min(1, 1 / r)

  for (let i = 0; i < outLen; i++) {
    const center = i * r
    const lo = Math.ceil(center - a)
    const hi = Math.floor(center + a)
    let acc = 0
    let wsum = 0
    for (let j = lo; j <= hi; j++) {
      if (j < 0 || j >= n) continue
      const x = center - j
      const w = cutoff * sinc(cutoff * x) * sinc(x / a)
      acc += samples[j] * w
      wsum += w
    }
    // Lanczos 在满幅信号上会振铃出 1.001 这种值，顺手夹回去（16bit 那边也会夹，但别留脏数据）
    out[i] = wsum > 1e-9 ? clamp(acc / wsum, -1, 1) : 0
  }
  return out
}

/** 音量 + 软限幅（超过 0.98 的地方压回去，不削顶） */
export function applyGain(input, gain) {
  const samples = input instanceof Float32Array ? input : Float32Array.from(input || [])
  const g = num(gain, 1)
  if (!samples.length || Math.abs(g - 1) < 1e-3) return samples
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i] * g
    if (v > 0.98) v = 0.98 + Math.tanh((v - 0.98) * 3) * 0.02
    else if (v < -0.98) v = -0.98 - Math.tanh((-v - 0.98) * 3) * 0.02
    out[i] = v
  }
  return out
}

/** 几段采样拼起来，段之间留静音（给语气词当间隔用） */
export function concatSamples(parts, { gapMs = 90, sampleRate = 22050 } = {}) {
  const list = (parts || []).filter((p) => p && p.length)
  if (!list.length) return new Float32Array(0)
  const gap = Math.max(0, Math.round((num(gapMs, 90) / 1000) * num(sampleRate, 22050)))
  const total = list.reduce((n, p) => n + p.length, 0) + gap * (list.length - 1)
  const out = new Float32Array(total)
  let at = 0
  list.forEach((p, i) => {
    out.set(p, at)
    at += p.length
    if (i < list.length - 1) at += gap
  })
  return out
}

/** WAV（16bit PCM，单/双声道）→ 单声道 Float32。解不了就返回 null。 */
export function decodeWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (b.length < 44) return null
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null

  let fmt = null
  let data = null
  let at = 12
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4)
    const size = b.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ' && body + 16 <= b.length) {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, b.length - body) }
      break
    }
    at = body + size + (size % 2)
  }
  if (!fmt || !data) return null
  if (fmt.format !== 1 || fmt.bits !== 16) return null

  const channels = Math.max(1, fmt.channels)
  const frames = Math.floor(data.size / (2 * channels))
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      sum += b.readInt16LE(data.start + (i * channels + c) * 2)
    }
    out[i] = sum / channels / 32768
  }
  return { samples: out, sampleRate: fmt.sampleRate, channels }
}
