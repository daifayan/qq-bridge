// start-desktop-runtime.mjs — 用命令行拉起桌面端 DSH runtime（端口 43129）
// 并把 stdout/stderr tee 到 %APPDATA%/dsh-desktop/logs/harness.log
// （桥接的 discoverDshLaunchToken 按端口 43129 从这里读 launch token，
//  和桌面壳自己的落盘位置一致，壳以后好了两边无缝切换）。
//
// 为什么需要它：DSH Desktop 的 Electron 壳双击会卡在起不来 harness（2026-10-24 实测），
// 但 runtime 本身（同一个 bin.js、同一份 DSH_HOME）命令行拉完全正常。
//
// 用法：node start-desktop-runtime.mjs   （或双击 start-desktop-runtime.bat）
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const LOG = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'logs', 'harness.log')
const DSH_HOME = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'harness')
// 与桌面壳内嵌 runtime 同版本（0.2.0-rc.2）的 bin.js；换机时改这里。
const DSH_BIN = 'C:\\Users\\hzm10\\AppData\\Local\\Doubao\\User Data\\sandbox_runtime\\bases\\c98c5042338ed152c6f10ecd8591889f\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const NODE = 'C:\\Users\\hzm10\\AppData\\Local\\Doubao\\User Data\\sandbox_runtime\\bases\\c98c5042338ed152c6f10ecd8591889f\\node\\node.exe'

mkdirSync(dirname(LOG), { recursive: true })

const child = spawn(NODE, [DSH_BIN, 'web', '--port', '43129', '--no-open'], {
  env: { ...process.env, DSH_HOME },
  windowsHide: false,
})

const tee = (chunk) => {
  process.stdout.write(chunk)
  try { appendFileSync(LOG, chunk) } catch {}
}
child.stdout.on('data', tee)
child.stderr.on('data', tee)
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => { console.error(err); process.exit(1) })
