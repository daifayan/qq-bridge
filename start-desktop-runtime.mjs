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
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const LOG = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'logs', 'harness.log')
const DSH_HOME = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'harness')
// 与桌面壳内嵌 runtime 同版本（0.2.0-rc.2）的 bin.js；换机时改这里。
const DSH_BIN = 'C:\\Users\\hzm10\\AppData\\Local\\Doubao\\User Data\\sandbox_runtime\\bases\\c98c5042338ed152c6f10ecd8591889f\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const NODE = 'C:\\Users\\hzm10\\AppData\\Local\\Doubao\\User Data\\sandbox_runtime\\bases\\c98c5042338ed152c6f10ecd8591889f\\node\\node.exe'

mkdirSync(dirname(LOG), { recursive: true })

// DSH 的 agent preset 用相对路径 ./qq-tool-restrict.mjs，加载时却按 profile 根目录解析。
// 该文件缺失时 DSH 能启动，但 QQ 会话会以 “never started” 拒绝创建，表现为机器人已读不回。
// 启动前从已安装 preset 补一份，幂等且不覆盖已有内容。
const PRESET_PLUGIN = join(DSH_HOME, '.agent-presets', 'qq-chat-v2', 'qq-tool-restrict.mjs')
const PROFILE_PLUGIN = join(DSH_HOME, 'profiles', 'web', 'qq-tool-restrict.mjs')
if (!existsSync(PROFILE_PLUGIN) && existsSync(PRESET_PLUGIN)) {
  mkdirSync(dirname(PROFILE_PLUGIN), { recursive: true })
  copyFileSync(PRESET_PLUGIN, PROFILE_PLUGIN)
  appendFileSync(LOG, `[startup] restored missing profile plugin: ${PROFILE_PLUGIN}\n`)
}

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
