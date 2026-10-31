/**
 * 鲸鲸启动器 · 后端（零依赖）
 * ============================================================
 * 为什么要有它：panel.mjs 是敲数字的终端菜单，F:\ai\tools\机器人控制台.hta
 * 是 mshta(IE) 做的按钮版 —— 样式旧、没有服务状态、还有几个按钮指向已经
 * 不存在的脚本。这个启动器把「按钮 + 实时状态 + 真实回执」一次给齐：
 *
 *   - 127.0.0.1:3120 本地小服务，只监听回环，不对外
 *   - 前端是 launcher/ui.html，用 Edge 的 --app 模式开成无边框窗口
 *   - 每个动作都真跑真抓输出，结果推到页面底部抽屉里，不静默失败
 *   - 窗口关掉 → 页面不再心跳 → 服务自己退出，不留僵尸进程
 *
 * 启动方式：双击桌面「面板」→ F:\ai\tools\launcher.vbs → 本文件
 * 单实例：3120 已在监听时，只把窗口拉起来，不起第二个服务。
 */

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  describeModel, setPrimaryModel, describeVoice, patchVoice,
  describeVideo, patchVideo, describePcJobs, patchPcJobs,
  reloadBridge, peekModel, invalidateModelCache,
  describeWhitelist, applyWhitelist, setAutoAdapt, readConfig,
} from './config-ops.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')          // F:\ai\qq-bridge
const TOOLS = resolve(ROOT, '..', 'tools') // F:\ai\tools
const UI = join(HERE, 'ui.html')

const PORT = Number(process.env.LAUNCHER_PORT) || 3120
const HOST = '127.0.0.1'
const NODE = process.execPath
const COMSPEC = process.env.ComSpec || 'cmd.exe'
const TASK_TIMEOUT = 180_000
const IDLE_EXIT = 120_000   // 页面 2s 心跳一次；窗口关了 2 分钟没动静就退出

// ---------------------------------------------------------------- 状态探测
const SERVICES = [
  { key: 'dsh', name: 'DSH 桌面端', port: 43129 },
  { key: 'snow', name: '雪露 SnowLuma', port: 5099 },
  { key: 'onebot', name: 'OneBot', port: 3000 },
  { key: 'bridge', name: 'QQ 桥接', port: 3100 },
]

function portAlive(port, timeout = 600) {
  return new Promise((done) => {
    const socket = net.connect({ host: HOST, port, timeout })
    const finish = (value) => { socket.destroy(); done(value) }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function probeAll() {
  const results = await Promise.all(SERVICES.map((s) => portAlive(s.port)))
  return SERVICES.map((s, i) => ({ ...s, up: results[i] }))
}

// ---------------------------------------------------------------- 动作定义
// 前端只负责渲染，加按钮改这里一处即可。
// plan() 返回若干步，串行执行，输出合并显示。

const bat = (name, dir = ROOT) => ({
  exe: COMSPEC,
  // ⚠ verbatim 是必须的（2026-10-29 实修，踩过一次）：
  //    node spawn 会给含空格的参数加引号并转义内部引号，把 `call "path"`
  //    改写成 `"call \"path\""`，cmd 收到后 call 就没了，报
  //    「'"F:\...bat"' 不是内部或外部命令」。整行原样传才不会变形。
  //
  // ⚠ 这里**不加 chcp 65001**：cmd 在 65001 下读 bat 文件是按字节跳行的，
  //    文件里只要有非 ASCII 字符就会错位（实测 echo 会变成 cho）。
  //    输出编码改由 decodeChunk() 按内容自动判断。
  args: ['/d', '/s', '/c', `call "${join(dir, name)}"`],
  cwd: dir,
  label: name,
  batPath: join(dir, name),
  verbatim: true,
})

const mjs = (path, args = [], cwd = ROOT) => ({
  exe: NODE,
  args: [path, ...args],
  cwd,
  label: basename(path),
})

const ACTIONS = [
  {
    id: 'start-all', group: 'boot', icon: '🚀',
    name: '一键启动全套', desc: 'DSH + 雪露 + QQ 桥接（已跑的自动跳过）',
    accent: true, mode: 'task',
    plan: () => [bat('启动桌面端套件.bat')],
  },

  {
    id: 'check', group: 'service', icon: '🩺',
    name: '链路体检', desc: '端口 · 令牌 · QQ 在线',
    mode: 'task',
    plan: () => [mjs(join(TOOLS, 'check-bot.mjs'))],
  },
  {
    // 雪露只能挂到已登录的 QQ 上；QQ 没开时一键启动会卡在 3000 端口
    id: 'launch-qq', group: 'service', icon: '🐧',
    name: '拉起 QQ', desc: 'QQ 没开就打开它（登录还得你扫）',
    mode: 'task',
    plan: () => [mjs(join(ROOT, 'scripts', 'ensure-qq.mjs'), ['--wait', '40'])],
  },
  {
    id: 'open-console', group: 'service', icon: '🤖',
    name: '机器人控制台', desc: '带令牌直达 3100',
    mode: 'task',
    plan: () => [mjs(join(TOOLS, 'bridge-open.mjs'))],
  },
  {
    // 副页面：完整控制台嵌在面板里，不用另开浏览器（2026-10-30）
    id: 'console-embed', group: 'service', icon: '🖥️',
    name: '控制台（内嵌）', desc: '16 个分区全在这儿，不跳浏览器',
    mode: 'embed',
  },
  {
    id: 'open-dsh', group: 'service', icon: '🌐',
    name: 'DSH 页面', desc: '带令牌直达 43129',
    mode: 'task',
    plan: () => [mjs(join(TOOLS, 'dsh-open.mjs'), [], TOOLS)],
  },
  {
    id: 'restart-bot', group: 'service', icon: '🔄',
    name: '重启机器人', desc: '先停再起，DSH 不动',
    mode: 'task',
    plan: () => [
      mjs(join(ROOT, 'stop-bot.mjs')),
      bat('启动桌面端套件.bat'),
    ],
  },
  {
    id: 'restart-dsh', group: 'service', icon: '♻️',
    name: '重启 DSH', desc: '对话会中断',
    mode: 'task', danger: true,
    plan: () => [bat('重启DSH.bat')],
  },
  {
    id: 'stop-bot', group: 'service', icon: '🔌',
    name: '关闭机器人', desc: '雪露 + 桥接，DSH 不动',
    mode: 'task', danger: true,
    plan: () => [bat('快速关闭.bat')],
  },
  {
    id: 'stop-all', group: 'service', icon: '🛑',
    name: '停止全部', desc: '含 DSH，对话会中断',
    mode: 'task', danger: true,
    plan: () => [bat('停止全部.bat')],
  },

  {
    id: 'whitelist', group: 'bot', icon: '📋',
    name: '白名单管理', desc: '谁能跟机器人说话，直接增删',
    mode: 'panel', panel: 'whitelist',
  },
  {
    id: 'model', group: 'bot', icon: '🧠',
    name: '模型切换', desc: '选聊天大脑，带可用性探测',
    mode: 'panel', panel: 'model',
  },
  {
    id: 'voice', group: 'bot', icon: '🎙️',
    name: '语音设置', desc: '开关 · 频率 · 静音时段 · 语速',
    mode: 'panel', panel: 'voice',
  },
  {
    id: 'video', group: 'bot', icon: '🎬',
    name: '视频分镜', desc: '机器人看懂 QQ 视频：宫格 + 台词',
    mode: 'panel', panel: 'video',
  },
  {
    id: 'pcjobs', group: 'bot', icon: '💻',
    name: 'QQ 指令', desc: '私聊发「指令 …」让本机干活',
    mode: 'panel', panel: 'pcjobs',
  },
  {
    id: 'clear-unread', group: 'bot', icon: '🧹',
    name: '清理未读', desc: '别让机器人翻旧账',
    mode: 'task',
    plan: () => [mjs(join(ROOT, 'scripts', 'clear-unread.mjs'))],
  },

  {
    id: 'qzone-comment', group: 'qzone', icon: '💬',
    name: '空间评论模式', desc: '自动评论开关',
    mode: 'window',
    plan: () => [bat('切换空间评论模式.bat', TOOLS)],
  },
  {
    id: 'qzone-auto', group: 'qzone', icon: '⚙️',
    name: '空间自动化', desc: '日常任务总开关',
    mode: 'window',
    plan: () => [bat('切换空间自动化.bat', TOOLS)],
  },
  {
    id: 'duty', group: 'qzone', icon: '📱',
    name: '值守模式', desc: '手机遥控开关',
    mode: 'window',
    plan: () => [bat('切换值守模式.bat', TOOLS)],
  },

  {
    id: 'log', group: 'tool', icon: '📜',
    name: '查看日志', desc: '桥接 · QQ · DSH 尾部',
    mode: 'task',
    plan: () => [mjs(join(TOOLS, 'log-tail.mjs'), ['60'], TOOLS)],
  },
]

const ACTION_MAP = new Map(ACTIONS.map((a) => [a.id, a]))

// ---------------------------------------------------------------- 任务执行
const runs = new Map()   // id -> { id, actionId, name, lines, code, running, startedAt }
const RUN_LIMIT = 24

function trimRuns() {
  while (runs.size > RUN_LIMIT) {
    const oldest = runs.keys().next().value
    runs.delete(oldest)
  }
}

// cmd 的内建命令按系统代码页(GBK)输出，node 脚本按 UTF-8 输出，
// 同一个抽屉里两种都有。先按 UTF-8 解，出现替换字符就说明其实是 GBK。
const gbkDecoder = new TextDecoder('gbk')

function decodeChunk(buf) {
  const asUtf8 = buf.toString('utf8')
  if (!asUtf8.includes('\uFFFD')) return asUtf8
  try { return gbkDecoder.decode(buf) } catch { return asUtf8 }
}

function pushLine(run, chunk) {
  const text = decodeChunk(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (const line of text.split('\n')) {
    if (line.length === 0 && run.lines.at(-1) === '') continue
    run.lines.push(line)
  }
  if (run.lines.length > 4000) run.lines.splice(0, run.lines.length - 4000)
}

function spawnStep(step, run, onDone) {
  let child
  try {
    child = spawn(step.exe, step.args, {
      cwd: existsSync(step.cwd) ? step.cwd : ROOT,
      windowsHide: true,
      // verbatim 时 Node 只把 args 用空格拼起来、不做任何转义/加引号，
      // 引号必须由我们自己写进参数里（bat() 已经带了）
      windowsVerbatimArguments: !!step.verbatim,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    })
  } catch (error) {
    run.lines.push(`启动失败：${error.message}`)
    onDone(1)
    return
  }

  const timer = setTimeout(() => {
    run.lines.push(`—— 超过 ${TASK_TIMEOUT / 1000}s 未结束，已终止 ——`)
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }, TASK_TIMEOUT)

  child.stdout?.on('data', (c) => pushLine(run, c))
  child.stderr?.on('data', (c) => pushLine(run, c))
  child.once('error', (error) => {
    clearTimeout(timer)
    run.lines.push(`启动失败：${error.message}`)
    onDone(1)
  })
  child.once('exit', (code) => {
    clearTimeout(timer)
    onDone(code ?? 0)
  })
}

function runTask(action) {
  const run = {
    id: randomUUID(),
    actionId: action.id,
    name: action.name,
    lines: [`▶ ${action.name} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`],
    code: null,
    running: true,
    startedAt: Date.now(),
  }
  runs.set(run.id, run)
  trimRuns()

  let steps
  try {
    steps = action.plan()
  } catch (error) {
    run.lines.push(`动作配置有误：${error.message}`)
    run.running = false
    run.code = 1
    return run
  }

  let index = 0
  const next = () => {
    if (index >= steps.length) {
      run.running = false
      run.lines.push(run.code === 0 ? '✔ 完成' : `✖ 结束（退出码 ${run.code}）`)
      return
    }
    const step = steps[index++]
    run.lines.push(`$ ${step.label}`)
    spawnStep(step, run, (code) => {
      if (code !== 0) {
        run.code = code
        run.running = false
        run.lines.push(`✖ ${step.label} 退出码 ${code}`)
        return
      }
      next()
    })
  }
  run.code = 0
  next()
  return run
}

/** 自定义异步任务：给改配置这类「不是跑 bat」的动作用 */
function startCustomRun(name, worker) {
  const run = {
    id: randomUUID(),
    actionId: null,
    name,
    lines: [`▶ ${name} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`],
    code: 0,
    running: true,
    startedAt: Date.now(),
  }
  runs.set(run.id, run)
  trimRuns()

  ;(async () => {
    try {
      await worker((line) => run.lines.push(String(line)))
      run.lines.push('✔ 完成')
    } catch (error) {
      run.code = 1
      run.lines.push(`✖ ${error?.message ?? error}`)
    } finally {
      run.running = false
    }
  })()

  return run
}

function openWindowAction(action) {
  const step = action.plan()[0]
  if (!step?.batPath || !existsSync(step.batPath)) {
    return { opened: false, error: `找不到脚本：${step?.batPath ?? '?'}` }
  }
  // start "" "<bat>" —— 空标题 + 带引号的脚本路径，开一个独立可见控制台窗口。
  // 同样用 verbatim 自己控引号，免得 node 把参数改写坏。
  try {
    const child = spawn(COMSPEC, ['/d', '/c', 'start', '""', `"${step.batPath}"`], {
      cwd: existsSync(step.cwd) ? step.cwd : ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    })
    child.unref()
    return { opened: true }
  } catch (error) {
    return { opened: false, error: error.message }
  }
}

// ---------------------------------------------------------------- Edge 窗口
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

function edgePath() {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null
}

const PROFILE = join(TOOLS, '.launcher-profile')

/**
 * 拉起 Edge 的 --app 窗口。
 *
 * ⚠ 必须经过 `cmd /c start ""` 这一层（2026-10-29 实修）：
 * launcher.vbs 是用 `shell.Run(..., 0, ...)`（隐藏窗口）起 node 的，
 * 这个 SW_HIDE 会通过 STARTUPINFO 继承给 spawn 出来的 Edge —— 进程在跑、
 * 窗口也建了，但**是隐藏的**，用户看到的就是"双击没反应/打不开"。
 * `start` 会显式把窗口设成 SW_SHOWNORMAL，绕开继承。
 */
function openWindow() {
  if (process.env.LAUNCHER_NO_WINDOW === '1') return null   // 自测用：只起服务不开窗
  const edge = edgePath()
  const url = `http://${HOST}:${PORT}/`
  const q = (s) => `"${s}"`

  const parts = edge
    ? ['start', '""', q(edge),
        q(`--app=${url}`),
        q(`--user-data-dir=${PROFILE}`),
        q('--window-size=1080,800'),
        q('--no-first-run'),
        q('--no-default-browser-check'),
        q('--disable-features=Translate,MediaRouter'),
      ]
    // 没有 Edge 就退回默认浏览器，功能一样，只是多了地址栏
    : ['start', '""', q(url)]

  try {
    spawn(COMSPEC, ['/d', '/c', parts.join(' ')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    }).unref()
  } catch (error) {
    console.error(`开窗口失败：${error.message}`)
  }
  return null
}

// ---------------------------------------------------------------- HTTP
let lastSeen = Date.now()
let sawClient = false

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((done, fail) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024) { fail(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { done({}) }
    })
    req.on('error', fail)
  })
}

const server = http.createServer(async (req, res) => {
  // 只认本机回环 Host，挡掉 DNS rebinding
  const host = (req.headers.host ?? '').toLowerCase()
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) {
    return json(res, 403, { error: 'forbidden host' })
  }

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  const path = url.pathname

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    let html
    try { html = readFileSync(UI) }
    catch { return json(res, 500, { error: 'ui.html 缺失' }) }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': html.length,
    })
    return res.end(html)
  }

  if (req.method === 'GET' && path === '/api/state') {
    sawClient = true
    lastSeen = Date.now()
    const services = await probeAll()
    let voice = null
    let video = null
    let pcjobs = null
    try { voice = describeVoice() } catch { /* config.json 正在写，下一轮再说 */ }
    try { video = describeVideo() } catch { /* 同上 */ }
    try { pcjobs = describePcJobs() } catch { /* 同上 */ }
    return json(res, 200, {
      services,
      model: peekModel(),
      voice,
      video,
      pcjobs,
      actions: ACTIONS.map(({ plan, ...rest }) => rest),
      runs: [...runs.values()].slice(-6).reverse().map((r) => ({
        id: r.id, name: r.name, running: r.running, code: r.code,
      })),
    })
  }

  if (req.method === 'POST' && path === '/api/ping') {
    sawClient = true
    lastSeen = Date.now()
    return json(res, 200, { ok: true })
  }

  // launcher.vbs 双击时先打这个：服务已经在跑就让它把窗口拉起来，
  // 省得再起一个 node 进程（那样会留孤儿，还容易起不来）
  if (req.method === 'POST' && path === '/api/open-window') {
    lastSeen = Date.now()
    openWindow()
    return json(res, 200, { ok: true })
  }

  if (req.method === 'POST' && path === '/api/run') {
    lastSeen = Date.now()
    const body = await readBody(req)
    const action = ACTION_MAP.get(String(body.id ?? ''))
    if (!action) return json(res, 404, { error: '没有这个动作' })
    if (action.mode === 'window') return json(res, 200, openWindowAction(action))
    const run = runTask(action)
    return json(res, 200, { runId: run.id })
  }

  if (req.method === 'GET' && path === '/api/run') {
    lastSeen = Date.now()
    const run = runs.get(url.searchParams.get('id') ?? '')
    if (!run) return json(res, 404, { error: '任务不存在' })
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0)
    return json(res, 200, {
      id: run.id, name: run.name,
      running: run.running, code: run.code,
      total: run.lines.length,
      lines: run.lines.slice(since),
    })
  }

  if (req.method === 'GET' && path === '/api/model') {
    lastSeen = Date.now()
    const force = url.searchParams.get('force') === '1'
    try {
      return json(res, 200, await describeModel({ force }))
    } catch (error) {
      return json(res, 500, { error: error.message })
    }
  }

  if (req.method === 'POST' && path === '/api/model/apply') {
    lastSeen = Date.now()
    const body = await readBody(req)
    const index = Number(body.index)
    const run = startCustomRun('切换模型', async (log) => {
      const target = setPrimaryModel(index, log)
      await reloadBridge({ log })
      invalidateModelCache()
      log(`现在用：${target}`)
    })
    return json(res, 200, { runId: run.id })
  }

  if (req.method === 'GET' && path === '/api/voice') {
    lastSeen = Date.now()
    try {
      return json(res, 200, describeVoice())
    } catch (error) {
      return json(res, 500, { error: error.message })
    }
  }

  if (req.method === 'POST' && path === '/api/voice/apply') {
    lastSeen = Date.now()
    const body = await readBody(req)
    const run = startCustomRun('保存语音设置', async (log) => {
      const changed = patchVoice(body.patch ?? {}, log)
      if (!changed.length) return
      await reloadBridge({ log })
      log('语音设置已生效')
    })
    return json(res, 200, { runId: run.id })
  }

  if (req.method === 'POST' && path === '/api/model/autoadapt') {
    lastSeen = Date.now()
    const body = await readBody(req)
    const enabled = !!body.enabled
    const run = startCustomRun(enabled ? '开启自动适配' : '关闭自动适配', async (log) => {
      setAutoAdapt(enabled, log)
      await reloadBridge({ log })
    })
    return json(res, 200, { runId: run.id })
  }

  if (req.method === 'GET' && path === '/api/whitelist') {
    lastSeen = Date.now()
    try {
      return json(res, 200, await describeWhitelist())
    } catch (error) {
      return json(res, 500, { error: error.message })
    }
  }

  if (req.method === 'POST' && path === '/api/whitelist/apply') {
    lastSeen = Date.now()
    const body = await readBody(req)
    const run = startCustomRun('保存白名单', async (log) => {
      await applyWhitelist({
        private: body.private ?? [],
        groups: body.groups ?? [],
      }, log)
    })
    return json(res, 200, { runId: run.id })
  }

  // 视频分镜（2026-10-29 新功能，此前面板没有入口）
  if (req.method === 'GET' && path === '/api/video') {
    lastSeen = Date.now()
    try {
      return json(res, 200, describeVideo())
    } catch (error) {
      return json(res, 500, { error: error.message })
    }
  }

  if (req.method === 'POST' && path === '/api/video/apply') {
    lastSeen = Date.now()
    const body = await readBody(req)
    const run = startCustomRun('保存视频分镜设置', async (log) => {
      const changed = patchVideo(body.patch ?? {}, log)
      if (!changed.length) return
      await reloadBridge({ log })
      log('视频分镜设置已生效')
    })
    return json(res, 200, { runId: run.id })
  }

  // QQ 指令（本机干活）
  if (req.method === 'GET' && path === '/api/pcjobs') {
    lastSeen = Date.now()
    try {
      return json(res, 200, describePcJobs())
    } catch (error) {
      return json(res, 500, { error: error.message })
    }
  }

  if (req.method === 'POST' && path === '/api/pcjobs/apply') {
    lastSeen = Date.now()
    const body = await readBody(req)
    const run = startCustomRun('保存 QQ 指令设置', async (log) => {
      const changed = patchPcJobs(body.patch ?? {}, log)
      if (!changed.length) return
      await reloadBridge({ log })
      log('QQ 指令设置已生效')
    })
    return json(res, 200, { runId: run.id })
  }

  // 内嵌控制台副页面：给前端一个带令牌的地址 + 当前在不在线
  if (req.method === 'GET' && path === '/api/console') {
    lastSeen = Date.now()
    let token = ''
    try { token = String(readConfig().consoleToken ?? '') } catch { /* config 正在被写，下一轮再说 */ }
    const up = await portAlive(3100)
    const q = token ? `?token=${encodeURIComponent(token)}` : ''
    return json(res, 200, {
      up,
      port: 3100,
      url: `http://127.0.0.1:3100/${q}`,
    })
  }

  return json(res, 404, { error: 'not found' })
})

// ---------------------------------------------------------------- 启动
async function main() {
  if (await portAlive(PORT, 400)) {
    // 已经有实例在跑：只把窗口拉起来，然后自己退场
    openWindow()
    setTimeout(() => process.exit(0), 1200)
    return
  }

  server.on('error', (error) => {
    console.error(`启动器服务起不来：${error.message}`)
    process.exit(1)
  })

  server.listen(PORT, HOST, () => {
    console.log(`鲸鲸启动器  http://${HOST}:${PORT}/`)
    openWindow()
  })

  // 窗口关掉后页面不再心跳 → 自己退出，不留后台进程
  const bootAt = Date.now()
  setInterval(() => {
    if (!sawClient) {
      // 服务起来了却一直没人连上来（窗口被隐藏 / 起不来）→ 别留孤儿占着 3120
      if (Date.now() - bootAt > 90_000) {
        console.log('90 秒内没有窗口连上来，启动器退出（避免留孤儿进程）。')
        process.exit(0)
      }
      return
    }
    if ([...runs.values()].some((r) => r.running)) return
    if (Date.now() - lastSeen > IDLE_EXIT) {
      console.log('窗口已关闭，启动器退出。')
      process.exit(0)
    }
  }, 10_000).unref()
}

main()
