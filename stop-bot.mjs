/**
 * 安全停止 QQ 机器人相关服务（SnowLuma + QQ 桥接）。默认不动 DSH。
 *
 * ⚠️ 历史事故：本脚本第一版用 /qq-bridge|bridge\.js/ 判定桥接进程，结果把
 * DSH 自己的进程也匹配进来 —— 因为 DSH 的 MCP 子进程命令行是
 *     node.exe F:\ai\qq-bridge\src\mcp-web-search-safe.js
 * 目录名里就含 "qq-bridge"！于是脚本杀掉 MCP 并连带弄死宿主，
 * 连运行脚本的 Agent 会话都被带走了。因此现在改成**严格白名单**：
 * 只有命令行精确匹配桥接本体或 SnowLuma 运行时才算目标，且显式排除
 * MCP server、DSH 包装器、DSH 宿主、以及本脚本自身。
 *
 * 用法：双击 快速关闭.bat
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

const PORTS = [3100, 3001, 3000, 5099] // 从最下游开始停
const PORT_LABEL = {
  3100: 'QQ 桥接',
  3001: 'SnowLuma OneBot WS',
  3000: 'SnowLuma OneBot HTTP',
  5099: 'SnowLuma WebUI',
}

/**
 * 问桥接：现在有没有会话正在回合中（唤醒已投递、还没 turn/end）。
 *
 * 为什么要问：如果 AI 正被唤醒着，此时把 SnowLuma/桥接关掉，它的工具会开始
 * 报 `fetch failed`，然后**每个工具挨个重试**——每次重试都是一次完整模型调用。
 * 2026-09-26 管理员私聊里就这么白烧了一整轮。所以关之前先等它这一轮结束。
 *
 * @returns {Promise<string[]|null>} 会话 key 列表；读不到返回 null（桥接没跑）。
 */
async function fetchBusyKeys() {
  let token = ''
  try {
    token = String(JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).consoleToken ?? '')
  } catch {}
  if (!token) {
    try { token = readFileSync(join(ROOT, 'state', 'console-token'), 'utf8').trim() } catch {}
  }
  try {
    const res = await fetch(`http://127.0.0.1:3100/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(3000),
    })
    const json = await res.json()
    return Array.isArray(json?.busyKeys) ? json.busyKeys.map(String) : []
  } catch {
    return null
  }
}

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

function tryJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function listProcesses() {
  const raw = ps(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe'" | ` +
    `Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
  )
  const parsed = tryJson(raw)
  if (!parsed) return []
  return Array.isArray(parsed) ? parsed : [parsed]
}

function listenersOn(port) {
  const raw = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`)
  return [...new Set(String(raw).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))].map(Number)
}

/**
 * 判定一个进程是否是本脚本可以停的目标。
 * 返回 'QQ 桥接' | 'SnowLuma' | 'DSH' | null。
 * 只有精确匹配才算，任何不确定的都返回 null（宁可不杀）。
 *
 * @param includeDsh --all 模式下才允许把 DSH 也算作目标（默认绝不碰 DSH）
 */
function classifyProcess(cmd, includeDsh = false) {
  const line = String(cmd ?? '')
  if (!line) return null

  // ── 显式排除：绝对不能碰的 ──
  if (/stop-bot\.mjs/i.test(line)) return null // 本脚本自身
  if (/[\\/]mcp-[\w.-]*\.js/i.test(line)) return null // 三个 MCP server（不是桥接本体！）
  if (/[\\/]dsh-subprocess-local[\\/]/i.test(line)) return null // shell runner（临时子进程）

  // DSH 相关：只有在 --all 模式才作为目标，否则一律跳过
  const isDshHost = /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(line)
  const isDshWrapper = /start-dsh\.mjs/i.test(line)
  if (isDshHost || isDshWrapper) return includeDsh ? 'DSH' : null
  // 其它 DSH 依赖目录里的进程也不要
  if (/@deepseek-ai[\\/]dsh[\\/]/i.test(line)) return null

  // ── 白名单：只认这两种形态 ──
  // 桥接本体：命令行以 (src/)bridge.js 结尾。
  // ⚠️ 不能假设是绝对路径 —— 用 Start-Process -ArgumentList 'src/bridge.js'
  // 启动时命令行里就是相对路径："node.exe" src/bridge.js（无 qq-bridge 前缀）。
  // 同时上面已排除 mcp-*.js，所以这里不会误伤 MCP server。
  if (/[\\/]?bridge\.js"?\s*$/i.test(line)) return 'QQ 桥接'
  // SnowLuma 运行时：命令行里出现 SnowLuma\node.exe
  if (/[\\/]SnowLuma[\\/]node\.exe/i.test(line)) return 'SnowLuma'
  return null
}

function kill(pid, label, dryRun) {
  if (dryRun) {
    console.log(`     [试运行] 会停止 ${label} (PID ${pid})`)
    return true
  }
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    console.log(`     已停止 ${label} (PID ${pid})`)
    return true
  } catch {
    console.log(`     ${label} (PID ${pid}) 已不在或无法停止`)
    return false
  }
}

// --dry-run：只报告会停哪些进程，不真的动手。用于验证安全判定是否正确。
const DRY_RUN = process.argv.includes('--dry-run')
// --all：连 DSH 一起停（默认绝不碰 DSH）
const STOP_ALL = process.argv.includes('--all')
// --yes：跳过交互确认（供 .bat 在确认后调用）
const ASSUME_YES = process.argv.includes('--yes')

console.log('========================================================================')
console.log(STOP_ALL ? '  停止全部 —— DSH + SnowLuma + QQ 桥接' : '  快速关闭 —— SnowLuma + QQ 桥接')
console.log(STOP_ALL ? '  （含 DSH：本对话会中断）' : '  （DSH 不受影响）')
if (DRY_RUN) console.log('  *** 试运行模式：只报告，不会真的停止任何进程 ***')
console.log('========================================================================')
console.log()

// --all 且未 --yes 时，要求人工确认，避免误触
if (STOP_ALL && !ASSUME_YES && !DRY_RUN) {
  console.log('  ⚠ 你选择了“停止全部”，这会把 DSH 也关掉。')
  console.log('     如果正在和 Agent 对话，该对话会立即中断。')
  console.log('     机器人服务（SnowLuma / QQ 桥接）随时可用“DeepSeek 全家桶”重启。')
  console.log()
  process.stdout.write('  确认要全部停止吗？输入 y 回车继续，其他任意键取消：')
  const answer = await new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl >= 0) { process.stdin.pause(); resolve(buf.slice(0, nl).trim().toLowerCase()) }
    })
    // 非交互环境（没有 stdin）时不要永久挂住
    setTimeout(() => { try { process.stdin.pause() } catch {} ; resolve('') }, 60000)
  })
  if (answer !== 'y' && answer !== 'yes') {
    console.log(`\n  已取消（收到 "${answer}"），没有停止任何东西。`)
    process.exit(0)
  }
  console.log('\n  确认，开始停止全部…\n')
}

let stopped = 0
let skipped = 0

// ── 0) 关之前先确认没有会话正在回合中 ──
// 若有，等它把这一轮走完（最多 12 秒）：否则 SnowLuma/桥接一消失，AI 的工具
// 会开始报 fetch failed，然后每个工具挨个重试 —— 每次重试都是一次完整模型调用。
const busyBefore = await fetchBusyKeys()
if (busyBefore === null) {
  console.log('· 回合状态：读不到桥接（可能本来就没在跑）')
} else if (busyBefore.length === 0) {
  console.log('· 回合状态：空闲，可以直接关')
} else {
  console.log(`· 回合状态：${busyBefore.join(', ')} 正在回复中`)
  if (DRY_RUN) {
    console.log('     [试运行] 真跑的话会先等这一轮结束（最多 12 秒）再关')
  } else {
    console.log('     等这一轮结束再关，避免它反复重试失败的工具调用、白烧 token…')
    let stillBusy = busyBefore
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const now = await fetchBusyKeys()
      if (now !== null && now.length === 0) { stillBusy = []; break }
    }
    console.log(stillBusy.length === 0 ? '     这一轮已结束，继续关闭。' : '     等待超时（12s），仍然先关掉。')
  }
}

// ── 1) 先停守护窗口，否则 start.bat 会在 5 秒后把桥接重新拉起 ──
console.log('· 停止守护/包装窗口（防自动重启、防残留 pause 窗口）')
let procs = listProcesses()
const daemons = procs.filter(
  (p) => p.Name === 'cmd.exe' && /qq-bridge[\\/]start\.bat/i.test(String(p.CommandLine ?? '')),
)
if (daemons.length === 0) {
  console.log('     没有发现桥接守护窗口')
} else {
  for (const d of daemons) if (kill(d.ProcessId, '桥接守护窗口', DRY_RUN)) stopped++
}

// SnowLuma 的包装窗口自身不会自动重启，但它停下来时会停在 `pause` 上，
// 并且仍然占着启动时重定向的日志文件句柄 —— 下一次启动若往同一个文件写，
// 重定向会失败，SnowLuma 就静默起不来（2026-09-25 实测踩过这个坑）。
const snowWrappers = procs.filter(
  (p) => p.Name === 'cmd.exe' && /start-snowluma\.bat/i.test(String(p.CommandLine ?? '')),
)
for (const w of snowWrappers) {
  if (kill(w.ProcessId, 'SnowLuma 包装窗口', DRY_RUN)) stopped++
}

// ── 2) 按严格白名单清理桥接本体 ──
// 守护窗口被 /T 结束时会顺带带走桥接；但桥接若是直接 node 起的（无守护），
// 它仍会占着 3100 —— 这里再精确确认一次。
console.log()
console.log('· 清理 QQ 桥接本体（严格匹配 src/bridge.js）')
procs = listProcesses()
const bridgeProcs = procs.filter((p) => p.Name === 'node.exe' && classifyProcess(p.CommandLine) === 'QQ 桥接')
if (bridgeProcs.length === 0) {
  console.log('     没有残留的桥接进程')
} else {
  for (const b of bridgeProcs) if (kill(b.ProcessId, 'QQ 桥接', DRY_RUN)) stopped++
}

// ── 3) 按端口处理剩余服务，逐个校验身份 ──
console.log()
console.log('· 按端口停止剩余服务（逐个校验进程身份）')
for (const port of PORTS) {
  const pids = listenersOn(port)
  if (pids.length === 0) {
    console.log(`     ${String(port).padEnd(5)} ${PORT_LABEL[port]} — 未在运行`)
    continue
  }
  procs = listProcesses()
  for (const pid of pids) {
    const proc = procs.find((p) => Number(p.ProcessId) === pid)
    const cmd = String(proc?.CommandLine ?? '')
    const kind = classifyProcess(cmd)
    if (kind === null) {
      console.log(`     ${String(port).padEnd(5)} PID ${pid} 不是可停目标，跳过`)
      console.log(`           ${cmd.slice(0, 88)}`)
      skipped++
      continue
    }
    if (kill(pid, `${kind} @${port}`, DRY_RUN)) stopped++
  }
}

// ── 4) 复核 ──
console.log()
console.log('· 复核端口')
await new Promise((r) => setTimeout(r, 2500))
const stillOpen = []
for (const port of [...PORTS].reverse()) {
  const pids = listenersOn(port)
  if (pids.length === 0) {
    console.log(`     ${String(port).padEnd(5)} ${PORT_LABEL[port]} — 已关闭 ✅`)
  } else {
    console.log(`     ${String(port).padEnd(5)} ${PORT_LABEL[port]} — 仍在监听 ❌ (PID ${pids.join(',')})`)
    stillOpen.push(port)
  }
}

// ── 5) --all 时最后停 DSH（先包装器，后宿主；宿主一停，本脚本所在会话即中断）──
if (STOP_ALL) {
  console.log()
  console.log('· 停止 DSH（先包装器，后宿主）')
  procs = listProcesses()
  const wrapper = procs.filter((p) => classifyProcess(p.CommandLine, true) === 'DSH' && /start-dsh\.mjs/i.test(String(p.CommandLine ?? '')))
  const hosts = procs.filter((p) => classifyProcess(p.CommandLine, true) === 'DSH' && /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(String(p.CommandLine ?? '')))
  for (const w of wrapper) {
    console.log('     停止 DSH 包装器…')
    kill(w.ProcessId, 'DSH 包装器', DRY_RUN)
  }
  for (const h of hosts) {
    console.log('     停止 DSH 宿主…（本脚本发出后连接会中断，属正常）')
    kill(h.ProcessId, 'DSH 宿主', DRY_RUN)
  }
  if (wrapper.length === 0 && hosts.length === 0) console.log('     没有发现 DSH 进程')
}

// DSH 状态报告
const dshPids = listenersOn(3080)
console.log()
if (STOP_ALL) {
  console.log(`     DSH (3080) — ${dshPids.length ? `仍在运行 (PID ${dshPids.join(',')})，可能需要再运行一次` : '已关闭 ✅'}`)
} else {
  console.log(`     DSH (3080) — ${dshPids.length ? `保持运行 (PID ${dshPids.join(',')})` : '未在运行'}`)
}

console.log()
console.log('========================================================================')
if (DRY_RUN) {
  console.log(`  ℹ 试运行结束：识别到 ${stopped} 个可停进程（未真的停止）。`)
  if (skipped > 0) console.log(`     另有 ${skipped} 个身份不符的进程被安全跳过。`)
  console.log('     要真正关闭，请双击桌面“快速关闭机器人”。')
} else if (stillOpen.length === 0) {
  console.log(`  ✅ 完成：停止 ${stopped} 个进程，机器人服务已全部关闭。`)
  console.log('     重新开启：双击桌面“DeepSeek 全家桶”')
} else {
  console.log(`  ⚠ 停止 ${stopped} 个，但有端口仍被占用：${stillOpen.join(', ')}`)
  console.log('     可能被守护进程重新拉起，请再运行一次本脚本。')
}
if (skipped > 0) console.log(`  （为安全跳过了 ${skipped} 个身份不符的进程）`)
console.log('========================================================================')

// 不等待按键（非交互环境下 stdin 不可靠），由外层 .bat 的 pause 负责
process.exit(stillOpen.length === 0 ? 0 : 1)
