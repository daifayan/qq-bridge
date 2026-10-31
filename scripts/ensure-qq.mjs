#!/usr/bin/env node
/**
 * ensure-qq.mjs — 把 QQ 客户端拉起来（如果它没在跑）
 * ============================================================
 * 为什么需要这一步：SnowLuma 只能挂到**已经登录**的 QQ 上。
 * QQ 没开的时候点「一键启动全套」，只会得到一串「3000 端口不通」的报错，
 * 而真正的原因藏在最前面 —— QQ 根本没开。以前这一步靠人记得先双击 QQ。
 *
 * 用法：
 *   node scripts/ensure-qq.mjs              检测，没跑就拉起来
 *   node scripts/ensure-qq.mjs --check      只检测，不拉起（退出码 1 = 没在跑）
 *   node scripts/ensure-qq.mjs --wait 60    拉起后最多等 60 秒让进程出现（默认 30）
 *
 * 退出码：
 *   0  QQ 已经在跑，或已经拉起来
 *   1  拉不起来（找不到路径 / 进程一直没出现）—— 会打印具体原因，不静默
 *   0  没配 QQEXE 时也返回 0（当作「不启用自动拉起」，不算失败）
 *
 * 注意：登录仍然要人来（扫码 / 自动登录）。本脚本只负责把窗口叫出来。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadPaths } from './paths.mjs'

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const waitIdx = argv.indexOf('--wait')
const waitSec = waitIdx >= 0 ? Math.max(5, Number(argv[waitIdx + 1]) || 30) : 30

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** QQ 主进程在不在。tasklist 的输出是 GBK，但 QQ.exe 是 ASCII，正则匹配不受影响。 */
function qqRunning() {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq QQ.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    )
    return /QQ\.exe/i.test(out)
  } catch {
    return false
  }
}

if (process.platform !== 'win32') {
  console.log('非 Windows 平台，跳过 QQ 拉起。')
  process.exit(0)
}

if (qqRunning()) {
  console.log('✔ QQ 已经在跑')
  process.exit(0)
}

const paths = loadPaths({ refresh: true })
const exe = String(paths.qqExe ?? '').trim()

if (!exe) {
  console.log('⚠ paths.bat 里没配 QQEXE —— 跳过自动拉起，QQ 得自己先打开。')
  process.exit(0)
}

if (!existsSync(exe)) {
  console.error(`✖ QQEXE 指向的文件不存在：${exe}`)
  console.error('  去 paths.bat 改成真实的 QQ.exe 路径，或留空关掉自动拉起。')
  process.exit(1)
}

if (checkOnly) {
  console.log(`QQ 没在跑（可以拉起：${exe}）`)
  process.exit(1)
}

console.log(`QQ 没在跑，拉起：${exe}`)
try {
  // detached + unref：QQ 是独立 GUI 程序，不该跟着这个脚本一起退
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
  child.on('error', () => { /* 下面靠轮询进程判断，这里不重复报错 */ })
  child.unref()
} catch (error) {
  console.error(`✖ 拉起失败：${error.message}`)
  process.exit(1)
}

const startedAt = Date.now()
const deadline = startedAt + waitSec * 1000
let up = false
while (Date.now() < deadline) {
  if (qqRunning()) { up = true; break }
  await sleep(600)
}

if (!up) {
  console.error(`✖ 等了 ${waitSec} 秒，QQ 进程还是没出现。`)
  console.error('  可能是启动被拦（UAC / 安全软件），或者 QQEXE 指向的不是主程序。')
  process.exit(1)
}

const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`✔ QQ 已拉起（${secs}s）`)
console.log('  如果还要扫码登录，扫一下 —— 登录后雪露才能挂上去。')
