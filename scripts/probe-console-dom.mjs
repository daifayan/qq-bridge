/**
 * probe-console-dom.mjs — 控制台面板自检（CDP）
 * ============================================================
 * 为什么不用截图验收：控制台开着 SSE（/api/events），headless Edge 的
 * --screenshot 会在长连接上挂住，截出来的是「加载中…」的半成品，
 * 看起来像 bug，其实只是没渲染完（2026-10-30 实测踩过）。
 * 走 CDP 读 DOM 不受这个影响，还能顺便截一张可靠的全页图。
 *
 * 用法：
 *   node scripts/probe-console-dom.mjs "http://127.0.0.1:3100/?token=xxx"
 *   node scripts/probe-console-dom.mjs "http://127.0.0.1:3100/?token=xxx" out.png
 *
 * 输出：语音 / 视频分镜 / QQ 指令 三个面板的当前值 + 分区编号 + 导航项数量。
 * 退出码非 0 表示页面里抛了异常。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const URL_TO_OPEN = process.argv[2]
if (!URL_TO_OPEN) { console.error('缺少 URL'); process.exit(1) }

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))
if (!EDGE) { console.error('找不到 Edge'); process.exit(1) }

const PORT = 9333
const profile = mkdtempSync(join(tmpdir(), 'cdp-'))

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore', detached: false })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('DevTools 端口没起来')
}

function cdp(ws) {
  let seq = 0
  const pending = new Map()
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    seq += 1
    pending.set(seq, { resolve, reject })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
}

const REPORT = `(() => {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : '<缺失>'; };
  const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : '<缺失>'; };
  const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : '<缺失>'; };
  return JSON.stringify({
    voice: {
      enabled: chk('vcEnabled'), scope: val('vcScope'), replace: chk('vcReplace'),
      prob: val('vcProb'), probVal: txt('vcProbVal'),
      emo: val('vcEmo'), emoVal: txt('vcEmoVal'),
      maxChars: val('vcMaxChars'), cooldown: val('vcCooldown'),
      hourly: val('vcHourly'), daily: val('vcDaily'), speed: val('vcSpeed'),
      quiet: chk('vcQuiet'), quietStart: val('vcQuietStart'), quietEnd: val('vcQuietEnd'),
      msg: txt('vcMsg'),
    },
    video: {
      enabled: chk('vdEnabled'), cells: val('vdCells'), transcript: val('vdTranscript'),
      maxMB: val('vdMaxMB'), timeout: val('vdTimeout'), keep: val('vdKeep'),
      chars: val('vdChars'), msg: txt('vdMsg'),
    },
    pcjobs: {
      enabled: chk('pjEnabled'), prefix: val('pjPrefix'),
      hint: txt('pjHint'), info: txt('pjInfo').slice(0, 80), msg: txt('pjMsg'),
    },
    sections: [...document.querySelectorAll('.sec-no')].map(e => e.textContent).join(','),
    navCount: document.querySelectorAll('#sidebar a').length,
  });
})()`

try {
  await waitForDevtools()

  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('没有 page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const send = cdp(ws)

  await send('Page.enable')
  await send('Runtime.enable')
  // 先把视口撑开，否则全页截图会按默认 800 宽排版，细长得没法看
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  })
  await send('Page.navigate', { url: URL_TO_OPEN })
  await sleep(5000)   // 给 SSE / 轮询留够时间

  const result = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true })
  if (result.exceptionDetails) {
    console.error('页面里抛异常：', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
    process.exitCode = 1
  } else {
    const data = JSON.parse(result.result.value)
    console.log(JSON.stringify(data, null, 2))
  }

  // 顺手截一张全页图（CDP 截图不受 SSE 干扰）
  const shotPath = process.argv[3]
  if (shotPath) {
    const metrics = await send('Page.getLayoutMetrics')
    const width = Math.ceil(metrics.cssContentSize.width)
    const height = Math.ceil(metrics.cssContentSize.height)
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`\n截图：${shotPath}（${width}x${height}）`)
  }

  ws.close()
} catch (error) {
  console.error('自检失败：', error.message)
  process.exitCode = 1
} finally {
  try { child.kill() } catch { /* 已经退了 */ }
  await sleep(500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 占用中就留给系统 */ }
}
