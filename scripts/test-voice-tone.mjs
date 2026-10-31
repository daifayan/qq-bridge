// 语音调音的单元测试：纯 DSP + 参数合成，不加载模型、不发 QQ。
//   node scripts/test-voice-tone.mjs
import assert from 'node:assert/strict'
import { bandOf, semitonesToRatio, resolveTone, resample, applyGain, concatSamples, decodeWav } from '../src/voice-tone.js'
import { encodeWav } from '../src/tts.js'

let pass = 0
const ok = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const sine = (freq, ms, sampleRate = 22050) => {
  const n = Math.round((ms / 1000) * sampleRate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

/** 数过零点估频率 */
const estimateHz = (samples, sampleRate) => {
  let cross = 0
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) cross++
  }
  return (cross / 2) / (samples.length / sampleRate)
}

console.log('情绪分档')
ok('平静 → calm', () => assert.equal(bandOf(0), 'calm'))
ok('普通 → normal', () => assert.equal(bandOf(0.3), 'normal'))
ok('浓 → soft', () => assert.equal(bandOf(0.9), 'soft'))
ok('越界值被夹住', () => {
  assert.equal(bandOf(-5), 'calm')
  assert.equal(bandOf(9), 'soft')
})

console.log('半音换算')
ok('+12 半音 = 2 倍', () => assert.ok(Math.abs(semitonesToRatio(12) - 2) < 1e-9))
ok('-12 半音 = 0.5 倍', () => assert.ok(Math.abs(semitonesToRatio(-12) - 0.5) < 1e-9))
ok('0 半音 = 原样', () => assert.equal(semitonesToRatio(0), 1))

console.log('参数合成')
ok('关掉调音 = 原参数', () => {
  const t = resolveTone({ tone: { enabled: false, pitch: 4 }, emotion: 1, baseSpeed: 1.1, baseSid: 3 })
  assert.equal(t.pitch, 0)
  assert.equal(t.speed, 1.1)
  assert.equal(t.gain, 1)
  assert.equal(t.sid, 3)
  assert.equal(t.enabled, false)
})
ok('基础值 + 情绪档叠加', () => {
  const tone = {
    pitch: 1,
    gain: 1.2,
    emotion: { on: true, soft: { pitch: 2, speed: 1.1 }, calm: { pitch: -1, speed: 0.9 } }
  }
  const soft = resolveTone({ tone, emotion: 0.9, baseSpeed: 1 })
  assert.equal(soft.band, 'soft')
  assert.equal(soft.pitch, 3)
  assert.ok(Math.abs(soft.speed - 1.1) < 1e-9)
  assert.equal(soft.gain, 1.2)
  const calm = resolveTone({ tone, emotion: 0, baseSpeed: 1 })
  assert.equal(calm.pitch, 0)
  assert.ok(Math.abs(calm.speed - 0.9) < 1e-9)
})
ok('情绪映射关掉 = 只吃基础值', () => {
  const t = resolveTone({ tone: { pitch: 2, emotion: { on: false, soft: { pitch: 5 } } }, emotion: 0.9 })
  assert.equal(t.pitch, 2)
})
ok('半音和倍速被夹在安全范围', () => {
  const t = resolveTone({ tone: { pitch: 99, gain: 99, emotion: { soft: { speed: 9 } } }, emotion: 1 })
  assert.equal(t.pitch, 8)
  assert.equal(t.gain, 3)
  assert.equal(t.speed, 2)
})
ok('档位里配了 sid 才覆盖（0 也合法）', () => {
  const t = resolveTone({ tone: { emotion: { soft: { sid: 0 } } }, emotion: 1, baseSid: 7 })
  assert.equal(t.sid, 0)
  const keep = resolveTone({ tone: { emotion: { soft: {} } }, emotion: 1, baseSid: 7 })
  assert.equal(keep.sid, 7)
})

console.log('重采样（变调核心）')
ok('时长按 1/r 缩，音高按 r 升', () => {
  const src = sine(440, 500)
  const r = semitonesToRatio(2) // +2 半音
  const out = resample(src, r)
  assert.ok(Math.abs(out.length - src.length / r) <= 2, `长度 ${out.length} vs ${(src.length / r).toFixed(0)}`)
  const hz = estimateHz(out, 22050)
  assert.ok(Math.abs(hz - 440 * r) < 12, `频率 ${hz.toFixed(1)} vs ${(440 * r).toFixed(1)}`)
})
ok('r=1 原样返回（不复制）', () => {
  const src = sine(440, 100)
  assert.equal(resample(src, 1), src)
})
ok('降调也一样准', () => {
  const r = semitonesToRatio(-3)
  const out = resample(sine(300, 400), r)
  const hz = estimateHz(out, 22050)
  assert.ok(Math.abs(hz - 300 * r) < 10, `频率 ${hz.toFixed(1)} vs ${(300 * r).toFixed(1)}`)
})
ok('空输入不炸', () => {
  assert.equal(resample(new Float32Array(0), 1.2).length, 0)
  assert.equal(resample(null, 1.2).length, 0)
})
ok('变调后不削顶（振幅仍在 1 以内）', () => {
  const out = resample(sine(440, 300), 1.122)
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  assert.ok(peak <= 1.001, `peak=${peak}`)
})

console.log('音量')
ok('乘增益', () => {
  const out = applyGain(Float32Array.from([0.5, -0.5]), 2)
  assert.ok(Math.abs(out[0] - 1) < 0.05)
  assert.ok(out[1] <= -0.95 && out[1] >= -1.001)
})
ok('增益 1 原样返回', () => {
  const src = Float32Array.from([0.1, 0.2])
  assert.equal(applyGain(src, 1), src)
})

console.log('拼接 / WAV')
ok('拼接长度含间隔', () => {
  const out = concatSamples([new Float32Array(100), new Float32Array(100)], { gapMs: 100, sampleRate: 1000 })
  assert.equal(out.length, 300)
})
ok('WAV 编码→解码 能还原', () => {
  const src = Float32Array.from([0, 0.5, -0.5, 1, -1])
  const decoded = decodeWav(encodeWav(src, 16000))
  assert.equal(decoded.sampleRate, 16000)
  assert.equal(decoded.channels, 1)
  assert.equal(decoded.samples.length, src.length)
  for (let i = 0; i < src.length; i++) assert.ok(Math.abs(decoded.samples[i] - src[i]) < 1e-3)
})
ok('非 WAV 返回 null', () => assert.equal(decodeWav(Buffer.from('ID3xxxxxxx')), null))

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`)
