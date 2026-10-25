/**
 * 发不发语音：纯策略，好测。
 *
 * 原则（跟真人一样）：
 *   · 短句、情绪浓的才发语音；长段落老老实实打字
 *   · 同一会话别连着发，有冷却；一天有总量上限
 *   · 拿不准就不发 —— 宁可少发，不要刷屏
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const EMO_CHARS = ['！', '？', '!', '?', '…', '~', '～']
const EMO_WORDS = ['呀', '啦', '嘛', '诶', '欸', '哦', '喔', '嗯', '哼', '嗷', '唔', '哈', '哇', '唉', '嘿']

/** 情绪浓度 0..1 */
export function emotionScore(text) {
  const s = String(text ?? '')
  if (!s) return 0
  let hits = 0
  for (const ch of s) {
    if (EMO_CHARS.includes(ch)) hits += 1
    else if (EMO_WORDS.includes(ch)) hits += 0.6
  }
  const density = hits / Math.max(6, s.length)
  return Math.min(1, density * 2.2)
}

/** 明显不该念的内容 */
export function looksUnspeakable(text) {
  const s = String(text ?? '').trim()
  if (!s) return '空文本'
  if (s.startsWith('⚠️') || s.startsWith('⚠')) return '系统提示'
  if (s.includes('```')) return '含代码块'
  if (/https?:\/\//.test(s)) return '含链接'
  if (s.includes('指令 ')) return '指令回执'
  if (s.length > 400) return '太长'
  return ''
}

function hourInRange(hour, start, end) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/**
 * 判断这一条要不要发语音。
 * @param {object} p
 * @param {string} p.key           会话 key（private:123 / group:456）
 * @param {string} p.text          AI 回复原文
 * @param {object} p.cfg           voice 配置
 * @param {object} p.memory        持久化计数（见 createVoiceMemory）
 * @param {number} [p.now]
 * @param {() => number} [p.rand]
 * @param {string} [p.ownerKey]    owner 私聊的 key，scope=owner 时用
 */
export function decide({ key, text, cfg = {}, memory, now = Date.now(), rand = Math.random, ownerKey = '' }) {
  if (!cfg.enabled) return { speak: false, reason: '未启用' }

  const scope = String(cfg.scope || 'private')
  const kind = String(key).split(':')[0]
  if (scope === 'off') return { speak: false, reason: 'scope=off' }
  if (scope === 'owner' && key !== ownerKey) return { speak: false, reason: '只对主人说' }
  if (scope === 'private' && kind !== 'private') return { speak: false, reason: '群聊不发语音' }

  const why = looksUnspeakable(text)
  if (why) return { speak: false, reason: why }

  const maxChars = Number(cfg.maxChars) || 60
  const plain = String(text ?? '').trim()
  if (plain.length > maxChars) return { speak: false, reason: `超过 ${maxChars} 字` }
  if (plain.length < (Number(cfg.minChars) || 2)) return { speak: false, reason: '太短' }

  const quiet = cfg.quietHours
  if (Array.isArray(quiet) && quiet.length === 2) {
    const hour = new Date(now).getHours()
    if (hourInRange(hour, Number(quiet[0]), Number(quiet[1]))) return { speak: false, reason: '静音时段' }
  }

  const mem = memory || {}
  const today = new Date(now).toISOString().slice(0, 10)
  if (mem.day !== today) {
    mem.day = today
    mem.countToday = 0
  }
  const dailyCap = Number(cfg.dailyCap) || 40
  if ((mem.countToday || 0) >= dailyCap) return { speak: false, reason: `今日已达 ${dailyCap} 条上限` }

  const conv = (mem.conv ||= {})[key] || {}
  const cooldown = Number(cfg.cooldownMs) || 120000
  if (conv.lastAt && now - conv.lastAt < cooldown) return { speak: false, reason: '冷却中' }

  const hourWindow = 3600000
  const hourCount = conv.hourStart && now - conv.hourStart < hourWindow ? conv.hourCount || 0 : 0
  const hourlyCap = Number(cfg.hourlyCapPerConv) || 4
  if (hourCount >= hourlyCap) return { speak: false, reason: '本会话本小时已够' }

  const base = Number.isFinite(cfg.probability) ? cfg.probability : 0.35
  const p = Math.min(1, Math.max(0, base + emotionScore(plain) * (Number(cfg.emotionBoost) || 0.35)))
  const roll = rand()
  if (roll > p) return { speak: false, reason: `掷骰未中（${roll.toFixed(2)} > ${p.toFixed(2)}）`, probability: p }

  return { speak: true, reason: 'ok', probability: p, text: plain }
}

/** 记一次真的发出去了 */
export function recordSpoken(memory, key, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10)
  if (memory.day !== today) {
    memory.day = today
    memory.countToday = 0
  }
  memory.countToday = (memory.countToday || 0) + 1
  const conv = (memory.conv ||= {})[key] || {}
  const hourWindow = 3600000
  if (!conv.hourStart || now - conv.hourStart >= hourWindow) {
    conv.hourStart = now
    conv.hourCount = 0
  }
  conv.hourCount = (conv.hourCount || 0) + 1
  conv.lastAt = now
  memory.conv[key] = conv
  return memory
}

/** 计数落盘（原子写，读失败就当空） */
export function createVoiceMemory(file) {
  let data = {}
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) || {}
  } catch {
    data = {}
  }
  let timer = null
  const save = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(data, null, 2))
        writeFileSync(file, readFileSync(tmp))
      } catch {}
    }, 500)
    timer.unref?.()
  }
  return {
    data,
    save,
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(data, null, 2))
      } catch {}
    }
  }
}
