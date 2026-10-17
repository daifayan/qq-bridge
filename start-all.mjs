/**
 * 一键启动：DSH + SnowLuma + QQ 桥接。
 *
 * 为什么用 Node 而不是批处理：批处理按字节 + 系统代码页解析脚本，
 * 路径里只要出现中文（本例是 `启动DeepSeekHarness.bat`）就会把后续的
 * set/if 全部解析错位。Node 全程 UTF-8，稳定可靠。
 *
 * 行为：逐项探测端口，已在运行的服务直接跳过（避免单实例锁冲突与双份烧钱）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPaths, missingPaths, ROOT } from './scripts/paths.mjs'

// 所有路径都来自 paths.bat（唯一真源），换机器/换目录只改那一个文件。
// 以前这里写死了豆包聊天目录下的一个 .bat —— 那个目录随时可能被清理，换机必炸。
const P = loadPaths()
const DSH_BAT = P.dshLnk
// 不用 SnowLuma 自带的 launcher.bat：它调用裸 `node`，而本机 PATH 里没有 node，
// 于是第一行就失败、窗口停在 pause，SnowLuma 静默起不来。改用我们自己的包装脚本（绝对路径）。
const SNOW_BAT = join(ROOT, 'start-snowluma.bat')
const BRIDGE_BAT = join(ROOT, 'start.bat')
const NODE = P.node
const LOG_DIR = P.logDir
const LOG = join(LOG_DIR, 'start-all.log')

mkdirSync(LOG_DIR, { recursive: true })
const say = (line) => {
  process.stdout.write(line + '\n')
  try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8') } catch {}
}

/** 端口是否已在监听。 */
async function portAlive(port) {
  const net = await import('node:net')
  return await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 1200 })
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 以独立窗口启动一个 .bat（不阻塞本脚本）。 */
function launchBat(title, batPath, extraArgs = []) {
  const child = spawn('cmd.exe', ['/c', 'start', '', `/min`, title, `"${batPath}"`, ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: false,
  })
  child.unref()
}

/** 用独立可见窗口启动 DSH（它需要把 token URL 打印在窗口里）。 */
function launchDsh() {
  const child = spawn('cmd.exe', ['/c', 'start', 'DeepSeek Harness (dsh web)', `"${DSH_BAT}"`], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function main() {
  say('============================================================')
  say('   DeepSeek 全家桶 · 一键启动')
  say('   DSH(3080) + SnowLuma(5099/3000/3001) + QQ桥接(3100)')
  say('============================================================')
  say('')
  say('   前置：QQ 需已登录（SnowLuma 通过 Hook 挂载到 QQ 进程）')
  say('')

  // 配置体检：paths.bat 里有指向不存在的位置时先把话说清楚，
  // 否则后面每个服务只会报一句「找不到 X」，看不出其实是配置问题。
  const missing = missingPaths(P)
  if (missing.length) {
    say('   [配置] paths.bat 里有指向不存在的位置：')
    for (const m of missing) say('          ' + m)
    say('          改 paths.bat 即可，不用动任何启动脚本。')
    say('')
  }

  // ---- 1) DSH ----
  if (await portAlive(3080)) {
    say('[1/3] DSH Web        : 已在运行 (3080) — 跳过')
  } else if (existsSync(DSH_BAT)) {
    say('[1/3] DSH Web        : 启动中…（会弹出一个黑色控制台窗口，请勿关闭）')
    launchDsh()
  } else {
    say(`[1/3] DSH Web        : [错误] 找不到 ${DSH_BAT}`)
  }

  // ---- 2) SnowLuma ----
  if (await portAlive(5099)) {
    say('[2/3] SnowLuma       : 已在运行 (5099) — 跳过')
  } else if (existsSync(SNOW_BAT)) {
    say('[2/3] SnowLuma       : 启动中…')
    launchBat('SnowLuma', SNOW_BAT)
  } else {
    say(`[2/3] SnowLuma       : [错误] 找不到 ${SNOW_BAT}`)
  }

  // ---- 3) QQ 桥接 ----
  if (await portAlive(3100)) {
    say('[3/3] QQ 桥接        : 已在运行 (3100) — 跳过')
  } else if (existsSync(BRIDGE_BAT)) {
    say('[3/3] QQ 桥接        : 启动中…（守护模式，崩溃自动重启）')
    launchBat('qq-bridge', BRIDGE_BAT)
  } else {
    say(`[3/3] QQ 桥接        : [错误] 找不到 ${BRIDGE_BAT}`)
  }

  say('')
  say('   等待服务起来…')

  // 等三个服务的端口就绪（最多 ~60s），再开浏览器。
  // SnowLuma 也纳入等待：它挂载 QQ Hook 需要时间，而且它起不来时
  // 以前会被"5099 已在运行 -> 跳过"掩盖掉，直到 QQ 收不到消息才暴露。
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const [dsh, bridge, snow] = await Promise.all([portAlive(3080), portAlive(3100), portAlive(5099)])
    if (dsh && bridge && snow) break
    await new Promise((r) => setTimeout(r, 2000))
  }

  const [dshUp, bridgeUp, snowUp] = await Promise.all([portAlive(3080), portAlive(3100), portAlive(5099)])
  say('')
  say('============================================================')
  say(`   DSH 3080: ${dshUp ? '就绪' : '未就绪'}   SnowLuma 5099: ${snowUp ? '就绪' : '未就绪'}   桥接 3100: ${bridgeUp ? '就绪' : '未就绪'}`)
  say('============================================================')
  if (!snowUp) {
    say('')
    say('   [提示] SnowLuma 没能起来：看它的那个窗口里最后几行是什么报错（QQ 必须先登录）。')
    say('          SnowLuma 不起来，QQ 消息就进不来，机器人不会有任何反应。')
  }
  if (bridgeUp && !snowUp) {
    say('   [提示] 桥接已启动但连不上 SnowLuma；等 SnowLuma 起来后，重启一次桥接即可。')
  }
  say('')

  // 打开界面（不抢焦点由系统决定；失败不影响服务）
  const open = (url) => {
    const c = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
    c.unref()
  }
  if (dshUp) open('http://127.0.0.1:3080/')
  if (bridgeUp) open('http://127.0.0.1:3100/')

  say('   DSH 界面          http://127.0.0.1:3080/')
  say('   QQ 桥接控制台     http://127.0.0.1:3100/')
  say('')
  say('   本窗口可以关掉，三个服务会继续在各自窗口里运行。')
}

main().catch((error) => {
  say(`启动器异常：${error && error.message}`)
  process.exitCode = 1
})

// 让这个 Node 进程在 DSH 窗口未就绪时也能退出（spawn 的都是 detached）。
process.on('SIGINT', () => process.exit(0))
