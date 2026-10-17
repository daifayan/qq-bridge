/**
 * 验证联网搜索修复是否生效。
 *
 * 背景：桥接的 safe-fetch.js 原来用裸 'Mozilla/5.0' 当 UA，必应会把中文查询
 * 判为爬虫并返回「没有与此相关的结果」空页，导致群里问"张函瑞"这类中文名时
 * web_search 拿到 0 条。修复改用完整 Chrome UA 后同一 URL 能返回 8~10 条真实结果。
 *
 * 但 AI 用的 mcp__web-search-safe__* 是 DSH spawn 的独立子进程，Node 会缓存模块，
 * 所以「改完文件」必须「重启 DSH」才会生效。本脚本直接以子进程方式拉起该 MCP server
 * 并调用它的 web_search，因此它的结果就代表重启后 AI 会看到的结果。
 *
 * 用法：双击 验证搜索.bat
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const MCP = join(HERE, 'src', 'mcp-web-search-safe.js')
const SAFE_FETCH = join(HERE, 'src', 'safe-fetch.js')

// 用 \u 转义，避免脚本文件本身出现非 ASCII（cmd/编码问题）
const CASES = [
  { label: '\u5f20\u51fd\u745e', query: '\u5f20\u51fd\u745e' }, // 张函瑞
  { label: '\u5f20\u51fd\u745e\u662f\u8c01', query: '\u5f20\u51fd\u745e\u662f\u8c01' }, // 张函瑞是谁（历史上会退化成只匹配"张"）
  { label: '\u5f20\u51fd\u745e \u821e\u53f0', query: '\u5f20\u51fd\u745e \u821e\u53f0' }, // 张函瑞 舞台（同上）
  { label: '\u5218\u5fb7\u534e', query: '\u5218\u5fb7\u534e' }, // 刘德华
  { label: 'deepseek', query: 'deepseek' },
  { label: '\u5317\u4eac\u5927\u5b66', query: '\u5317\u4eac\u5927\u5b66' }, // 北京大学
]

function callMcp(name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    const timer = setTimeout(() => { child.kill(); resolve(new Error('超时')) }, 30000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.id === 1 && m.result) {
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
        } else if (m.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolve(m.result?.content?.[0]?.text ?? '')
        }
      }
    })
    child.on('error', (e) => { clearTimeout(timer); resolve(e) })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } })
  })
}

console.log('========================================================================')
console.log('  \u8054\u7f51\u641c\u7d22\u4fee\u590d \u2014 \u9a8c\u8bc1')
console.log('========================================================================')
console.log()

// 1) 检查修复是否在文件里
if (!existsSync(SAFE_FETCH)) {
  console.log('[X] 找不到 ' + SAFE_FETCH)
  process.exit(1)
}
const src = readFileSync(SAFE_FETCH, 'utf8')
const hasFix = src.includes('Chrome/131')
const bareUA = /'user-agent':\s*'Mozilla\/5\.0'/.test(src)
console.log('safe-fetch.js \u4fee\u6539\u65f6\u95f4 :', statSync(SAFE_FETCH).mtime.toLocaleString())
console.log('\u5305\u542b\u5b8c\u6574 Chrome UA \u4fee\u590d :', hasFix ? '\u2705 \u662f' : '\u274c \u5426')
console.log('\u4ecd\u5728\u4f7f\u7528\u88f8 Mozilla/5.0 :', bareUA ? '\u274c \u662f\uff08\u4fee\u590d\u672a\u751f\u6548\uff09' : '\u2705 \u5426')
console.log()
if (!hasFix) {
  console.log('[X] safe-fetch.js \u91cc\u6ca1\u6709\u4fee\u590d\u4ee3\u7801\uff0c\u540e\u7eed\u6d4b\u8bd5\u65e0\u610f\u4e49\u3002')
  process.exit(1)
}

// 2) 用 MCP 自己的 web_search 实测（等同重启 DSH 后 AI 看到的结果）
console.log('\u6b63\u5728\u8c03\u7528 MCP web_search\uff08\u6bcf\u6761\u6700\u591a\u7b49 30 \u79d2\uff09...')
console.log()
let allOk = true
for (const c of CASES) {
  const text = await callMcp('web_search', { query: c.query })
  if (text instanceof Error) {
    console.log(`  ${c.label.padEnd(10)} \u274c \u8c03\u7528\u5931\u8d25: ${text.message}`)
    allOk = false
    continue
  }
  let n = 0
  let sample = ''
  try {
    const d = JSON.parse(text)
    n = d.results?.length ?? 0
    sample = d.results?.[0]?.title?.slice(0, 46) ?? ''
  } catch {
    console.log(`  ${c.label.padEnd(10)} \u274c \u8fd4\u56de\u4e0d\u662f JSON: ${text.slice(0, 80)}`)
    allOk = false
    continue
  }
  const mark = n > 0 ? '\u2705' : '\u274c'
  if (n === 0) allOk = false
  console.log(`  ${c.label.padEnd(10)} ${mark} ${String(n).padStart(2)} \u6761   ${sample}`)
}

console.log()
console.log('========================================================================')
if (allOk) {
  console.log('  \u2705 \u4fee\u590d\u751f\u6548\uff1a\u4e2d\u6587\u548c\u82f1\u6587\u67e5\u8be2\u90fd\u80fd\u62ff\u5230\u771f\u5b9e\u7ed3\u679c\u3002')
  console.log()
  console.log('  \u8fd9\u4ee3\u8868\u91cd\u542f DSH \u540e\uff0c\u7fa4\u91cc\u95ee\u4e2d\u6587\u540d\u5b57 AI \u5c31\u80fd\u6b63\u5e38\u56de\u7b54\u4e86\u3002')
  console.log('  \u53ef\u4ee5\u53bb\u7fa4\u91cc\u8bd5\uff1a\u8ba9\u5b83\u518d\u67e5\u4e00\u6b21\u300c\u5f20\u51fd\u745e\u300d\u3002')
} else {
  console.log('  \u26a0 \u90e8\u5206\u67e5\u8be2\u4ecd\u4e3a 0 \u6761\u3002')
  console.log()
  console.log('  \u5982\u679c\u662f\u300c\u5f20\u51fd\u745e\u300d\u5355\u72ec\u4e3a 0\uff0c\u53ef\u80fd\u662f\u5fc5\u5e94\u5bf9\u8be5\u540d\u5b57\u786e\u5b9e\u6ca1\u7d22\u5f15\uff1b')
  console.log('  \u4f46\u5218\u5fb7\u534e / \u5317\u4eac\u5927\u5b66\u4e5f\u4e3a 0 \u5219\u8bf4\u660e\u4fee\u590d\u6ca1\u751f\u6548\u3002')
}
console.log('========================================================================')
console.log()
console.log('\u6309\u4efb\u610f\u952e\u5173\u95ed...')
process.stdin.resume()
process.stdin.once('data', () => process.exit(allOk ? 0 : 1))
