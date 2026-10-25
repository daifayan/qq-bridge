/**
 * TTS 工作线程：把 sherpa-onnx 的同步合成挡在主线程之外。
 *
 * 主线程只发 {type:'synth'}，这里回 Float32 采样；模型加载失败/原生崩溃
 * 都只影响这个线程，桥接本身不会跟着挂。
 */
import { parentPort } from 'node:worker_threads'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sherpa from 'sherpa-onnx-node'

let tts = null
let loadError = null
let loadMs = 0

function buildConfig(local) {
  const dir = String(local.modelDir || '')
  if (!existsSync(dir)) throw new Error(`模型目录不存在：${dir}`)
  const files = readdirSync(dir)
  const pick = (re) => files.find((f) => re.test(f))
  const onnx = local.modelFile && files.includes(local.modelFile) ? local.modelFile : pick(/\.onnx$/)
  if (!onnx) throw new Error(`模型目录里没有 .onnx：${dir}`)
  const tokens = pick(/^tokens\.txt$/)
  const isKokoro = files.includes('voices.bin')

  const model = isKokoro
    ? {
        kokoro: {
          model: join(dir, onnx),
          voices: join(dir, 'voices.bin'),
          tokens: join(dir, tokens),
          dataDir: join(dir, 'espeak-ng-data'),
          lexicon: [pick(/^lexicon-us-en\.txt$/), pick(/^lexicon-zh\.txt$/)]
            .filter(Boolean)
            .map((f) => join(dir, f))
            .join(','),
          lang: local.lang || 'zh'
        }
      }
    : {
        vits: {
          model: join(dir, onnx),
          tokens: join(dir, tokens),
          lexicon: pick(/^lexicon.*\.txt$/) ? join(dir, pick(/^lexicon.*\.txt$/)) : undefined,
          lengthScale: Number(local.lengthScale) || 1
        }
      }

  return {
    model: {
      ...model,
      numThreads: Number(local.numThreads) || 2,
      provider: local.provider || 'cpu',
      debug: 0
    },
    maxNumSentences: 1
  }
}

function ensure(local) {
  if (tts) return tts
  if (loadError) throw loadError
  const t0 = Date.now()
  try {
    tts = new sherpa.OfflineTts(buildConfig(local))
    loadMs = Date.now() - t0
  } catch (error) {
    loadError = error
    throw error
  }
  return tts
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'init') {
    try {
      const inst = ensure(msg.local || {})
      parentPort.postMessage({ type: 'ready', loadMs, sampleRate: inst.sampleRate, numSpeakers: inst.numSpeakers })
    } catch (error) {
      parentPort.postMessage({ type: 'fatal', id: msg.id, error: String(error?.message ?? error) })
    }
    return
  }
  if (msg.type === 'synth') {
    const t0 = Date.now()
    try {
      const inst = ensure(msg.local || {})
      const sid = Math.max(0, Math.min((inst.numSpeakers || 1) - 1, Number(msg.sid) || 0))
      const audio = inst.generate({ text: String(msg.text ?? ''), sid, speed: Number(msg.speed) || 1 })
      const samples = audio.samples instanceof Float32Array ? audio.samples : Float32Array.from(audio.samples)
      // 不放进 transfer list：原生侧给的 ArrayBuffer 可能是外部内存，转移会报
      // "Cannot transfer object of unsupported type"。几十万采样拷贝一次很便宜。
      parentPort.postMessage({ type: 'audio', id: msg.id, samples, sampleRate: audio.sampleRate, ms: Date.now() - t0 })
    } catch (error) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: String(error?.message ?? error) })
    }
  }
})
