/**
 * 只启动 SnowLuma，不碰 DSH 和桥接。
 *
 * 存在的理由：从 PowerShell 直接 `cmd /c start "" ...` 时，引号会被 shell 吞掉，
 * 窗口根本起不来（实测）。用 Node 的数组式 spawn 传参最精确，和 start-all.mjs 同一套做法。
 */
import { spawn } from 'node:child_process'

const BAT = 'F:\\ai\\qq-bridge\\start-snowluma.bat'
const child = spawn('cmd.exe', ['/c', 'start', '', '/min', 'SnowLuma', `"${BAT}"`], {
  detached: true,
  stdio: 'ignore',
})
child.unref()
process.stdout.write('SnowLuma launching via ' + BAT + '\n')
