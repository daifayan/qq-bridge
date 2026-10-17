/**
 * 验证"网关不可达"时，MCP 工具返回给模型的是可照做的指令，而不是 undici 的 `fetch failed`。
 *
 * 两条路径都要测（2026-09-26 那次两条都炸了）：
 *   1. agentApi  → 桥接控制台 3100（qq_get_unread_messages / qq_wait_for_messages 等）
 *   2. onebot    → SnowLuma OneBot HTTP 3000（qq_status / snowluma_status 等）
 *
 * 做法：用环境变量把两者都指向没人监听的端口 —— 不碰 config.json、不动任何真实服务。
 *
 * 背景：管理员私聊中网关中途挂掉，AI 把每个 QQ 工具挨个重试，每次重试都是一次
 * 完整模型调用，白烧了一整轮 token；原文案 `fetch failed` 对模型毫无信息量。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const child = spawn(process.execPath, [join(ROOT, 'src', 'mcp-snowluma-safe.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    QQ_BRIDGE_CONSOLE_PORT: '3999',                  // 桥接路径：死端口
    QQ_SNOWLUMA_HTTP_URL: 'http://127.0.0.1:3998',   // SnowLuma 路径：死端口
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const resolve = pending.get(msg.id)
    if (resolve) { pending.delete(msg.id); resolve(msg) }
  }
})
child.stderr.on('data', (d) => process.stderr.write('[mcp stderr] ' + d))

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
const call = (id, method, params) =>
  new Promise((resolve) => { pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }) })

const guard = setTimeout(() => {
  console.log('FAIL 超时：MCP 没有在 25s 内回应')
  child.kill()
  process.exit(1)
}, 25000)

let failures = 0
function check(label, text) {
  console.log(`\n--- ${label} ---`)
  console.log(text)
  const okDirective = text.includes('重试不会有不同结果')
  const okExemption = text.includes('收尾要求自动豁免')
  console.log(okDirective ? '  PASS 明确要求停止重试' : '  FAIL 没有停止重试的指令')
  console.log(okExemption ? '  PASS 说明了收尾豁免' : '  FAIL 没有收尾豁免说明')
  if (!okDirective || !okExemption) failures++
}

try {
  await call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gateway-down-test', version: '1' },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // 1) 桥接路径（agentApi）
  const r1 = await call(2, 'tools/call', {
    name: 'qq_get_unread_messages',
    arguments: { key: 'private:2433147136', token: 'dummy-token-for-network-test' },
  })
  check('qq_get_unread_messages（桥接 3100 不可达）', r1?.result?.content?.[0]?.text ?? '')

  // 2) SnowLuma 路径（onebot）
  const r2 = await call(3, 'tools/call', { name: 'qq_status', arguments: {} })
  check('qq_status（SnowLuma 3000 不可达）', r2?.result?.content?.[0]?.text ?? '')

  console.log('')
  console.log(failures === 0 ? 'ALL PASS' : `FAILED (${failures})`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  clearTimeout(guard)
  child.kill()
}
