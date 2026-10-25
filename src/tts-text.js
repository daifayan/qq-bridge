/**
 * 把 AI 的回复正文洗成"能念出来"的文本。
 *
 * 目标：语音里不要出现 Markdown 记号、代码、链接、表情符号；
 * 阿拉伯数字改成中文读法（本地 TTS 的词典不会念数字）。
 */

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const SMALL_UNITS = ['', '十', '百', '千']
const BIG_UNITS = ['', '万', '亿', '万亿']

/** 0..9999 → 中文 */
function fourDigitsToChinese(str) {
  const s = str.replace(/^0+/, '')
  if (!s) return ''
  let out = ''
  let zero = false
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i])
    const pos = s.length - 1 - i
    if (d === 0) {
      zero = true
      continue
    }
    if (zero && out) out += '零'
    zero = false
    out += DIGITS[d] + SMALL_UNITS[pos]
  }
  return out
}

/** 整数字符串 → 中文（支持到万亿级） */
function intToChinese(digits) {
  let s = String(digits).replace(/^0+/, '')
  if (!s) return '零'
  if (s.length > 16) return s
  const groups = []
  while (s.length > 4) {
    groups.unshift(s.slice(-4))
    s = s.slice(0, -4)
  }
  groups.unshift(s)

  let out = ''
  let pendingZero = false
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const bigIdx = groups.length - 1 - i
    const part = fourDigitsToChinese(g)
    if (!part) {
      if (out) pendingZero = true
      continue
    }
    if (out && (pendingZero || g.padStart(4, '0')[0] === '0')) out += '零'
    pendingZero = false
    out += part + BIG_UNITS[bigIdx] || ''
  }
  // "一十二" → "十二"
  out = out.replace(/^一十/, '十')
  return out
}

function numberTokenToChinese(token, nextChar = '') {
  // 四位数 + 年 → 逐位念（2026年 → 二零二六年）
  if (/^\d{4}$/.test(token) && nextChar === '年') {
    return token.split('').map((d) => DIGITS[Number(d)]).join('')
  }
  const [intPart, fracPart] = token.split('.')
  let out = intToChinese(intPart)
  if (fracPart) out += '点' + fracPart.split('').map((d) => DIGITS[Number(d)]).join('')
  return out
}

/** 数字（含小数、百分比）→ 中文读法 */
export function normalizeNumbers(text) {
  let s = String(text ?? '')
  // 百分比
  s = s.replace(/(\d+(?:\.\d+)?)\s*[%％]/g, (_, n) => '百分之' + numberTokenToChinese(n))
  // 普通数字
  s = s.replace(/(\d+(?:\.\d+)?)/g, (m, _n, offset) => {
    const rest = s.slice(offset + m.length)
    const next = (rest.match(/^\s*(.)/) || [])[1] ?? ''
    return numberTokenToChinese(m, next)
  })
  return s
}

/**
 * 清洗成可朗读文本。
 * @param {string} input AI 回复原文
 * @param {{maxChars?: number}} [opts]
 * @returns {string}
 */
export function toSpeakable(input, opts = {}) {
  const GAP = '\u0001' // 占位：这里删掉了东西，最后统一换成一个停顿
  let s = String(input ?? '')

  // 代码块 / 行内代码 / 链接：删掉，留一个停顿（直接删会把两边的字粘成一个怪词）
  s = s.replace(/```[\s\S]*?```/g, GAP)
  s = s.replace(/`[^`]*`/g, GAP)
  s = s.replace(/https?:\/\/\S+/g, '链接')
  // Markdown 记号（不产生停顿）
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/[*_~#>|]+/g, '')
  s = s.replace(/^\s*[-+]\s+/gm, '')
  // 括号里的动作/内心戏（（小声）、(笑)）不念
  s = s.replace(/[（(][^）)]{0,12}[）)]/g, GAP)
  // emoji / 符号（不产生停顿）
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
  s = s.replace(/[【】\[\]{}<>]/g, GAP)
  // 占位 → 停顿；紧挨标点时让位给原标点
  s = s.replace(/[\s\u0001]*\u0001[\s\u0001]*/g, '，')
  s = s.replace(/，([。！？…，、；：])/g, '$1')
  s = s.replace(/^，+|，+$/g, '')
  // 连续标点收成一个
  s = s.replace(/[、，,]{2,}/g, '，')
  s = s.replace(/\s+/g, ' ')
  // 中文标点前后不留空格，中文字之间也不留（"3 个点" → "三个点"）
  s = s.replace(/\s+([，。！？、；：…～])/g, '$1')
  s = s.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
  s = s.trim()

  s = normalizeNumbers(s)

  const max = Number.isFinite(opts.maxChars) ? opts.maxChars : 0
  if (max > 0 && s.length > max) return s.slice(0, max)
  return s
}

/** 是否有可念的内容（全是标点/空白就不念） */
export function hasSpeakableContent(text) {
  return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(String(text ?? ''))
}
