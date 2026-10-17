/**
 * 算清"钱花在哪"：分析 state/tool-calls.jsonl。
 *
 * 为什么需要它：每次工具调用之后，模型都要再推理一次才知道下一步 ——
 * 所以**工具调用次数 ≈ 模型调用次数**，这是比"模型单价"重要得多的成本变量。
 * AI 在群里蹲回复时反复 qq_wait_for_messages，每一次都是一次完整模型调用。
 *
 * 用法：node scripts/analyze-tool-cost.mjs [天数，默认全部]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FILE = join(ROOT, 'state', 'tool-calls.jsonl')
const days = Number(process.argv[2]) || 0

let rows = []
try {
  rows = readFileSync(FILE, 'utf8')
    .trim()
    .split('\n')
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
} catch (error) {
  console.error('读不到 ' + FILE + '：' + (error?.message ?? error))
  process.exit(1)
}

if (days > 0) {
  const since = Date.now() - days * 86400_000
  rows = rows.filter((r) => Date.parse(r.time) >= since)
}

const calls = rows.filter((r) => r.type === 'call')
const results = rows.filter((r) => r.type === 'result')
if (!calls.length) { console.log('没有工具调用记录'); process.exit(0) }

const short = (t) => String(t).replace('mcp__snowluma__', '').replace('mcp__web-search-safe__', 'web:').replace('mcp__snowluma-host__', 'host:')

console.log(`记录范围：${calls[0].time} → ${calls[calls.length - 1].time}`)
console.log(`工具调用 ${calls.length} 次（≈ ${calls.length} 次模型推理），失败 ${results.filter((r) => r.ok === false).length} 次`)
console.log('')

const byTool = {}
for (const c of calls) byTool[c.tool] = (byTool[c.tool] || 0) + 1
console.log('按工具（每次调用 = 一次模型推理）：')
for (const [k, v] of Object.entries(byTool).sort((a, b) => b[1] - a[1])) {
  const pct = ((v / calls.length) * 100).toFixed(1).padStart(5)
  console.log(`  ${String(v).padStart(4)}  ${pct}%  ${short(k)}`)
}

// 按天
const byDay = {}
for (const c of calls) {
  const d = String(c.time).slice(0, 10)
  byDay[d] = (byDay[d] || 0) + 1
}
console.log('')
console.log('按天：')
for (const [k, v] of Object.entries(byDay).sort()) console.log(`  ${k}  ${String(v).padStart(4)} 次调用`)

// 切"轮"：同一会话、间隔 < 5 分钟算同一轮（一轮 ≈ 一次唤醒后的连续动作）
const sorted = [...calls].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
const GAP = 5 * 60_000
const rounds = []
let cur = null
for (const c of sorted) {
  const ts = Date.parse(c.time)
  if (!cur || c.sessionId !== cur.sid || ts - cur.last > GAP) {
    if (cur) rounds.push(cur)
    cur = { sid: c.sessionId, key: c.key, n: 0, last: ts, first: c.time }
  }
  cur.n += 1
  cur.last = ts
}
if (cur) rounds.push(cur)

console.log('')
const avg = rounds.reduce((s, r) => s + r.n, 0) / rounds.length
const waits = byTool['mcp__snowluma__qq_wait_for_messages'] || 0
console.log(`切出 ${rounds.length} 轮（同会话 + 5 分钟内连续）`)
console.log(`平均每轮 ${avg.toFixed(1)} 次工具调用 → 约 ${avg.toFixed(1)} 次模型推理`)
console.log(`其中 waiting 类占 ${waits} 次（${((waits / calls.length) * 100).toFixed(0)}%），是最大单项`)
console.log('')
console.log('成本换算（deepseek-flash 空闲价：输出 ¥4/M、缓存命中输入 ¥0.02/M）')
console.log('  ⚠️ 单位是"每次推理"，不是每轮 —— 一轮有 5 次推理。')
console.log(`  ${calls.length} 次推理 × 约 1200 输出 token(含思考) ≈ ¥${(calls.length * 0.0048).toFixed(2)}`)
console.log(`  换思考强度会直接改这个数：effort=high 的思考链按输出计费，low 会显著缩短。`)
