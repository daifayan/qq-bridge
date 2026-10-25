/**
 * 鲸鲸本机控制面板：DSH 桌面端（43129）+ SnowLuma + QQ 桥接（3100）。
 *
 * 中文界面放在 UTF-8 的 Node 脚本里，批处理只负责定位 node 和启动本文件，
 * 避免 cmd 按系统代码页解析中文 .bat 导致乱码、菜单错位。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(ROOT, '..', 'tools')
const COMSPEC = process.env.ComSpec || 'cmd.exe'

// 等首轮端口探测完再接管 stdin；否则管道输入可能在 question 注册前就 EOF。
let rl

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: false, ...options })
    child.once('error', (error) => {
      console.error(`\n启动失败：${error.message}`)
      resolveRun(1)
    })
    child.once('exit', (code) => resolveRun(code ?? 0))
  })
}

function runNode(script, args = [], env = {}) {
  if (!existsSync(script)) {
    console.error(`\n缺少脚本：${script}`)
    return Promise.resolve(1)
  }
  return run(process.execPath, [script, ...args], { env: { ...process.env, ...env } })
}

function runBat(file, args = []) {
  if (!existsSync(file)) {
    console.error(`\n缺少启动脚本：${file}`)
    return Promise.resolve(1)
  }
  return run(COMSPEC, ['/d', '/c', 'call', file, ...args], { cwd: dirname(file) })
}

function portAlive(port) {
  return new Promise((resolvePort) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 500 })
    const done = (value) => { socket.destroy(); resolvePort(value) }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function showMenu() {
  const [dsh, snow, onebot, bridge] = await Promise.all([43129, 5099, 3000, 3100].map(portAlive))
  const mark = (up) => up ? '运行中' : '未运行'
  console.clear()
  console.log('============================================================')
  console.log('  鲸鲸控制台  |  DSH 桌面端 + QQ 机器人')
  console.log('============================================================')
  console.log(`  DSH 桌面端 43129 [${mark(dsh)}]  SnowLuma 5099 [${mark(snow)}]`)
  console.log(`  OneBot 3000 [${mark(onebot)}]  QQ 机器人 3100 [${mark(bridge)}]`)
  console.log('------------------------------------------------------------')
  console.log('  [1] 一键启动 / 补齐全部服务（已运行的自动跳过）')
  console.log('  [2] 检查完整链路（DSH、令牌、QQ 在线、桥接）')
  console.log('')
  console.log('  [3] 打开 QQ 机器人控制台（自动带令牌）')
  console.log('  [4] 打开 DSH 桌面端页面（自动带令牌）')
  console.log('  [5] 管理聊天白名单')
  console.log('  [6] 切换机器人模型')
  console.log('  [7] 清理 QQ 未读消息')
  console.log('')
  console.log('  [8] QQ 空间：切换评论模式')
  console.log('  [9] QQ 空间：自动化设置')
  console.log('  [S] 切换值守模式（手机遥控）')
  console.log('')
  console.log('  [Q] 只关闭 QQ 机器人（DSH 保持运行）')
  console.log('  [R] 重启 QQ 机器人（DSH 保持运行）')
  console.log('  [D] 重启 DSH 桌面端（进行中的对话会中断）')
  console.log('  [A] 关闭全部（含 DSH 桌面端，对话会中断）')
  console.log('  [L] 查看运行日志')
  console.log('  [0] 退出面板')
  console.log('------------------------------------------------------------')
}

async function confirmStop() {
  const answer = await rl.question('确定关闭 SnowLuma + QQ 桥接吗？输入 y 确认：')
  return answer.trim().toLowerCase() === 'y'
}

async function dispatch(choice) {
  switch (choice) {
    case '1':
      console.log('\n准备启动桌面端套件；请确保 QQ 已登录。\n')
      return await runBat(join(ROOT, '启动桌面端套件.bat'))
    case '2':
      return await runNode(join(TOOLS, 'check-bot.mjs'))
    case '3':
      return await runNode(join(TOOLS, 'bridge-open.mjs'))
    case '4':
      return await runNode(join(TOOLS, 'dsh-open.mjs'), [], { DSH_PORT: '43129' })
    case '5':
      return await runBat(join(ROOT, '白名单.bat'))
    case '6':
      return await runBat(join(ROOT, '切换模型.bat'))
    case '7':
      return await runBat(join(TOOLS, '清未读.bat'))
    case '8':
      return await runBat(join(TOOLS, '切换空间评论模式.bat'))
    case '9':
      return await runBat(join(TOOLS, '切换空间自动化.bat'))
    case 'S':
      return await runBat(join(TOOLS, '切换值守模式.bat'))
    case 'Q':
      return await confirmStop() ? await runBat(join(ROOT, '快速关闭.bat')) : 0
    case 'R':
      console.log('\n先关掉 SnowLuma + QQ 桥接，再原样拉起来（DSH 不动）…\n')
      await runNode(join(ROOT, 'stop-bot.mjs'))
      console.log('\n正在重新启动机器人服务…\n')
      return await runBat(join(ROOT, '启动桌面端套件.bat'))
    case 'D':
      console.log('\n即将重启 DSH 桌面端：进行中的 Agent 对话会中断，')
      console.log('SnowLuma + QQ 机器人不动（桥接约 5 秒后自动重连）。\n')
      return await runBat(join(ROOT, '重启DSH.bat'))
    case 'A':
      console.log('\n即将停止全部服务（含 DSH 桌面端），下一步还会再确认一次。\n')
      return await runBat(join(ROOT, '停止全部.bat'))
    case 'L':
      return await runNode(join(TOOLS, 'log-tail.mjs'))
    default:
      console.log('\n没有这个选项，重新选一个。')
      return 0
  }
}

await showMenu()
rl = readline.createInterface({ input: process.stdin, output: process.stdout })
while (true) {
  const answer = (await rl.question('请选择：')).trim().toUpperCase()
  if (answer === '0') break
  const code = await dispatch(answer)
  if (code !== 0) console.log(`\n操作未成功（退出码 ${code}），请往上查看具体原因。`)
  await rl.question('\n按回车返回主菜单...')
  await showMenu()
}

rl.close()
