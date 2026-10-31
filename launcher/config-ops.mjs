/**
 * 启动器的配置操作层（零依赖）
 * ============================================================
 * 为什么要单独一层：模型和语音都住在 config.json 里，改完必须让桥接
 * 重新加载才生效。把「读 → 校验 → 备份 → 写 → 重启 → 等回来」收在
 * 一处，server.mjs 只管暴露 HTTP，将来加新配置项也只动这个文件。
 *
 * 两个必须记住的坑（2026-10-29 查实）：
 *
 * 1) 模型：`dsh.autoAdapt.enabled = true` 时，桥接**只认 candidates 的
 *    顺序**（src/api-adapt.js 的 doResolve），`dsh.provider/model` 仅在
 *    全部候选不可用时当兜底。所以「切模型」= 把目标候选挪到第一位，
 *    光改 dsh.provider 是白改。
 *
 * 2) 语音：config.json 的 voice 段是全量配置，桥接启动时读一次
 *    （bridge.js 的 loadConfig）。改完不重启不生效。
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(ROOT, 'config.json')
const BACKUP = path.join(ROOT, 'config.before-launcher.json')
const LOCK = path.join(ROOT, 'state', 'bridge.lock')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 基础 IO

export function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
}

export function writeConfig(cfg) {
  fs.copyFileSync(CONFIG, BACKUP)
  // 先写临时文件再 rename：桥接或启动器可能正读到一半，不能留半截 JSON
  const tmp = `${CONFIG}.launcher-tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, CONFIG)
}

export function configPaths() {
  return { config: CONFIG, backup: BACKUP }
}

function portOpen(port, timeout = 800) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout })
    const finish = (v) => { socket.destroy(); done(v) }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function readLockPid() {
  try { return fs.readFileSync(LOCK, 'utf8').trim() } catch { return '' }
}

function getJson(url, { headers = {}, timeoutMs = 2500 } = {}) {
  return new Promise((done) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; done(v) } }
    let req
    try {
      req = http.get(url, { headers }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c; if (body.length > 300000) req.destroy() })
        res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }))
      })
    } catch (error) {
      finish({ ok: false, error: error?.message ?? String(error) })
      return
    }
    req.on('error', (error) => finish({ ok: false, error: error?.message ?? String(error) }))
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ ok: false, error: `超时 ${timeoutMs}ms` }) })
  })
}

function readOfmKey() {
  if (process.env.OFM_API_KEY) return process.env.OFM_API_KEY
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const txt = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')
    const m = txt.match(/^\s*OFM_API_KEY:\s*"([^"]+)"/m)
      || txt.match(/^\s*OFM_API_KEY:\s*'([^']+)'/m)
      || txt.match(/^\s*OFM_API_KEY:\s*([^\s#]+)/m)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 模型

function candidatesOf(cfg) {
  const list = cfg?.dsh?.autoAdapt?.candidates
  return Array.isArray(list) ? list.filter((c) => c && c.provider && c.model) : []
}

function autoEnabled(cfg) {
  return cfg?.dsh?.autoAdapt?.enabled !== false && candidatesOf(cfg).length > 0
}

/** 探一个候选现在能不能用；规则跟 src/api-adapt.js 一致 */
export async function probeCandidate(c) {
  const probe = String(c.probe || 'none')
  if (probe === 'ofm') {
    const key = c.apiKey || readOfmKey()
    if (!key) return { ok: false, error: '缺少 OFM_API_KEY' }
    const base = String(c.baseURL || 'http://127.0.0.1:18900/v1').replace(/\/+$/, '')
    const r = await getJson(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
    if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` }
    return { ok: true }
  }
  return { ok: true }
}

let modelCache = { at: 0, data: null }

/**
 * 当前模型全景：候选列表 + 每个候选能不能用 + 实际会选谁。
 * 探测有网络开销，缓存 45 秒（页面 2.5s 轮询不能每次都打）。
 */
export async function describeModel({ force = false } = {}) {
  const now = Date.now()
  if (!force && modelCache.data && now - modelCache.at < 45_000) return modelCache.data

  const cfg = readConfig()
  const candidates = candidatesOf(cfg)
  const enabled = autoEnabled(cfg)

  const probed = await Promise.all(candidates.map(async (c) => {
    const p = await probeCandidate(c)
    return {
      provider: String(c.provider),
      model: String(c.model),
      reasoningEffort: c.reasoningEffort ? String(c.reasoningEffort) : null,
      probe: String(c.probe || 'none'),
      baseURL: c.baseURL ? String(c.baseURL) : null,
      ok: p.ok,
      error: p.ok ? null : p.error,
    }
  }))

  // 实际生效：autoAdapt 开着就按顺序挑第一个可用的；否则看 dsh.provider
  let activeIndex = -1
  let activeSource = 'fixed'
  if (enabled) {
    activeSource = 'auto'
    activeIndex = probed.findIndex((c) => c.ok)
  } else {
    activeIndex = probed.findIndex(
      (c) => c.provider === cfg.dsh?.provider && c.model === cfg.dsh?.model,
    )
  }

  const data = {
    autoAdapt: enabled,
    autoAdaptRaw: cfg.dsh?.autoAdapt?.enabled !== false,
    fixed: { provider: cfg.dsh?.provider ?? null, model: cfg.dsh?.model ?? null, reasoningEffort: cfg.dsh?.reasoningEffort ?? null },
    candidates: probed,
    activeIndex,
    activeSource,
    active: activeIndex >= 0 ? probed[activeIndex] : null,
    probedAt: new Date().toISOString(),
  }
  modelCache = { at: now, data }
  return data
}

export function invalidateModelCache() {
  modelCache = { at: 0, data: null }
}

/** 同步取已有探测结果（可能为 null）。给 /api/state 用，避免每次轮询都去探测。 */
export function peekModel() {
  return modelCache.data
}

/**
 * 切主模型：把第 index 个候选挪到 candidates 第一位。
 * autoAdapt 关着的时候，直接改 dsh.provider/model（那才是真正生效的字段）。
 */
export function setPrimaryModel(index, log = () => {}) {
  const cfg = readConfig()
  const list = candidatesOf(cfg)
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    throw new Error(`候选序号不对：${index}（共 ${list.length} 个）`)
  }
  const pick = list[index]
  const target = `${pick.provider}/${pick.model}`
  const before = list.map((c) => `${c.provider}/${c.model}`)

  if (autoEnabled(cfg)) {
    const reordered = [pick, ...list.filter((_, i) => i !== index)]
    cfg.dsh.autoAdapt.candidates = reordered
    log(`候选顺序：${before.join(' → ')}`)
    log(`调整为：${reordered.map((c) => `${c.provider}/${c.model}`).join(' → ')}`)
  } else {
    log('autoAdapt 未启用，直接改 dsh.provider / dsh.model')
  }

  // 兜底字段始终跟主模型对齐，autoAdapt 全挂时不至于漂回旧值
  cfg.dsh.provider = String(pick.provider)
  cfg.dsh.model = String(pick.model)
  if (pick.reasoningEffort) cfg.dsh.reasoningEffort = String(pick.reasoningEffort)

  writeConfig(cfg)
  invalidateModelCache()
  log(`已写入 config.json（备份 config.before-launcher.json），目标：${target}`)
  return target
}

// ---------------------------------------------------------------- 语音

const VOICE_DEFAULTS = {
  enabled: false,
  replaceText: true,
  engine: 'local',
  scope: 'private',
  maxChars: 60,
  minChars: 2,
  probability: 0.35,
  emotionBoost: 0.35,
  cooldownMs: 120000,
  hourlyCapPerConv: 4,
  dailyCap: 40,
  quietHours: null,
  timeoutMs: 25000,
}

const SCOPE_LABEL = { owner: '只对老大', private: '所有私聊', off: '谁都不发' }

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/** 只暴露前端能改的字段，其余原样保留 */
export function describeVoice() {
  const cfg = readConfig()
  const v = { ...VOICE_DEFAULTS, ...(cfg.voice ?? {}) }
  const local = v.local ?? {}
  return {
    enabled: !!v.enabled,
    replaceText: v.replaceText !== false,
    scope: SCOPE_LABEL[v.scope] ? v.scope : 'private',
    scopeLabel: SCOPE_LABEL[v.scope] ?? '未知',
    engine: String(v.engine || 'local'),
    maxChars: Number(v.maxChars) || 60,
    minChars: Number(v.minChars) || 2,
    probability: Number.isFinite(v.probability) ? v.probability : 0.35,
    emotionBoost: Number.isFinite(v.emotionBoost) ? v.emotionBoost : 0.35,
    cooldownSec: Math.round((Number(v.cooldownMs) || 120000) / 1000),
    hourlyCapPerConv: Number(v.hourlyCapPerConv) || 4,
    dailyCap: Number(v.dailyCap) || 40,
    quietHours: Array.isArray(v.quietHours) && v.quietHours.length === 2
      ? [Number(v.quietHours[0]), Number(v.quietHours[1])]
      : null,
    speed: Number(local.speed) || 1,
    sid: Number(local.sid) || 0,
    modelDir: String(local.modelDir || ''),
  }
}

/**
 * 合并写回语音配置。patch 里只认白名单字段，值一律夹到安全区间，
 * 免得前端传个 999 把机器人变成话痨。
 */
export function patchVoice(patch = {}, log = () => {}) {
  const cfg = readConfig()
  const v = { ...VOICE_DEFAULTS, ...(cfg.voice ?? {}) }
  const local = { ...(v.local ?? {}) }
  const changed = []

  const bool = (key) => {
    if (typeof patch[key] === 'boolean' && v[key] !== patch[key]) {
      v[key] = patch[key]
      changed.push(`${key}=${patch[key]}`)
    }
  }

  bool('enabled')
  bool('replaceText')

  if (typeof patch.scope === 'string' && SCOPE_LABEL[patch.scope] && v.scope !== patch.scope) {
    v.scope = patch.scope
    changed.push(`scope=${patch.scope}`)
  }

  const num = (key, min, max, target = v, name = key) => {
    const raw = patch[key]
    if (raw === undefined || raw === null || raw === '') return
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    const next = clamp(n, min, max)
    if (target[name] !== next) {
      target[name] = next
      changed.push(`${name}=${next}`)
    }
  }

  num('maxChars', 10, 300)
  num('minChars', 1, 20)
  num('probability', 0, 1)
  num('emotionBoost', 0, 1)
  num('hourlyCapPerConv', 1, 50)
  num('dailyCap', 1, 500)

  if (patch.cooldownSec !== undefined && patch.cooldownSec !== null && patch.cooldownSec !== '') {
    const sec = clamp(Number(patch.cooldownSec) || 120, 10, 3600)
    if (v.cooldownMs !== sec * 1000) {
      v.cooldownMs = sec * 1000
      changed.push(`cooldownMs=${sec * 1000}`)
    }
  }

  if (patch.quietHours === null || patch.quietHours === false) {
    if (v.quietHours !== null) { v.quietHours = null; changed.push('quietHours=关闭') }
  } else if (Array.isArray(patch.quietHours) && patch.quietHours.length === 2) {
    const start = clamp(Math.round(Number(patch.quietHours[0]) || 0), 0, 23)
    const end = clamp(Math.round(Number(patch.quietHours[1]) || 0), 0, 23)
    if (start === end) {
      if (v.quietHours !== null) { v.quietHours = null; changed.push('quietHours=关闭') }
    } else if (!v.quietHours || v.quietHours[0] !== start || v.quietHours[1] !== end) {
      v.quietHours = [start, end]
      changed.push(`quietHours=${start}-${end}`)
    }
  }

  if (patch.speed !== undefined) {
    const sp = clamp(Number(patch.speed) || 1, 0.5, 2)
    if (Number(local.speed) !== sp) { local.speed = sp; changed.push(`speed=${sp}`) }
  }
  if (patch.sid !== undefined) {
    const sid = clamp(Math.round(Number(patch.sid) || 0), 0, 99)
    if (Number(local.sid) !== sid) { local.sid = sid; changed.push(`sid=${sid}`) }
  }

  if (!changed.length) {
    log('没有改动，config.json 原样不动')
    return []
  }

  v.local = local
  cfg.voice = v
  writeConfig(cfg)
  log(`已写入 config.json：${changed.join('，')}`)
  return changed
}

// ---------------------------------------------------------------- 视频分镜

/**
 * 视频分镜（config.video）—— 2026-10-29 新功能，面板此前没有入口。
 * 语义见 src/video-storyboard.js 的 DEFAULTS：cells 为 0 时让插件自己定。
 */
const VIDEO_DEFAULTS = {
  enabled: true,
  cells: 9,
  maxBytes: 40 * 1024 * 1024,
  timeoutMs: 150_000,
  transcript: 'off',
  keepDays: 2,
  maxTextChars: 4000,
}

const MB = 1024 * 1024

export function describeVideo() {
  const cfg = readConfig()
  const v = { ...VIDEO_DEFAULTS, ...(cfg.video ?? {}) }
  const bytes = Number(v.maxBytes) || VIDEO_DEFAULTS.maxBytes
  return {
    enabled: v.enabled !== false,
    cells: Number(v.cells) || 0,
    maxMB: Math.round((bytes / MB) * 10) / 10,
    timeoutSec: Math.round((Number(v.timeoutMs) || VIDEO_DEFAULTS.timeoutMs) / 1000),
    transcript: v.transcript === 'auto' ? 'auto' : 'off',
    keepDays: Number(v.keepDays) || 2,
    maxTextChars: Number(v.maxTextChars) || 4000,
  }
}

export function patchVideo(patch = {}, log = () => {}) {
  const cfg = readConfig()
  const v = { ...VIDEO_DEFAULTS, ...(cfg.video ?? {}) }
  const changed = []

  if (typeof patch.enabled === 'boolean' && (v.enabled !== false) !== patch.enabled) {
    v.enabled = patch.enabled
    changed.push(`enabled=${patch.enabled}`)
  }

  if (patch.transcript === 'auto' || patch.transcript === 'off') {
    if ((v.transcript === 'auto' ? 'auto' : 'off') !== patch.transcript) {
      v.transcript = patch.transcript
      changed.push(`transcript=${patch.transcript}`)
    }
  }

  // cells 只认 0 / 4 / 6 / 9 —— 插件只吃这几种宫格
  if (patch.cells !== undefined && patch.cells !== null && patch.cells !== '') {
    const raw = Math.round(Number(patch.cells))
    const cells = [0, 4, 6, 9].includes(raw) ? raw : 9
    if ((Number(v.cells) || 0) !== cells) {
      v.cells = cells
      changed.push(`cells=${cells}`)
    }
  }

  const num = (key, min, max, toStore = (n) => n, label = key) => {
    const raw = patch[key]
    if (raw === undefined || raw === null || raw === '') return
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    const next = toStore(clamp(n, min, max))
    if (Number(v[key]) !== next) {
      v[key] = next
      changed.push(`${label}=${next}`)
    }
  }

  num('maxMB', 1, 200, (n) => Math.round(n * MB))
  num('timeoutSec', 20, 600, (n) => Math.round(n) * 1000)
  num('keepDays', 1, 30, (n) => Math.round(n))
  num('maxTextChars', 500, 20000, (n) => Math.round(n))

  if (!changed.length) {
    log('没有改动，config.json 原样不动')
    return []
  }

  cfg.video = v
  writeConfig(cfg)
  log(`已写入 config.json：${changed.join('，')}`)
  return changed
}

// ---------------------------------------------------------------- QQ 指令（本机干活）

/**
 * config.pcJobs —— owner 私聊发「指令 …」让本机干活。
 * 只开放开关和前缀；cwd / preset / ownerPrivateOnly 是安全边界，面板只读展示。
 */
export function describePcJobs() {
  const cfg = readConfig()
  const p = cfg.pcJobs ?? {}
  return {
    enabled: p.enabled !== false,
    prefix: String(p.prefix ?? '指令'),
    ownerPrivateOnly: p.ownerPrivateOnly !== false,
    cwd: String(p.cwd ?? ''),
    preset: String(p.preset ?? 'standard'),
    ownerQQ: cfg.ownerQQ ? String(cfg.ownerQQ) : null,
  }
}

export function patchPcJobs(patch = {}, log = () => {}) {
  const cfg = readConfig()
  const p = { ...(cfg.pcJobs ?? {}) }
  const changed = []

  if (typeof patch.enabled === 'boolean' && (p.enabled !== false) !== patch.enabled) {
    p.enabled = patch.enabled
    changed.push(`enabled=${patch.enabled}`)
  }

  if (typeof patch.prefix === 'string') {
    // 前缀不能为空、不能带空白，否则「指令 xxx」的切词会错位
    const next = patch.prefix.trim().replace(/\s+/g, '')
    if (next && next !== String(p.prefix ?? '指令')) {
      p.prefix = next.slice(0, 12)
      changed.push(`prefix=${p.prefix}`)
    }
  }

  if (!changed.length) {
    log('没有改动，config.json 原样不动')
    return []
  }

  cfg.pcJobs = p
  writeConfig(cfg)
  log(`已写入 config.json：${changed.join('，')}`)
  return changed
}

// ---------------------------------------------------------------- 自动适配开关

/**
 * 开关 autoAdapt。
 * 关掉时必须同时把 dsh.provider/model 钉到第一位候选 —— 否则那两个字段
 * 可能还是很久以前的旧值，桥接会突然用一个不相干的模型。
 */
export function setAutoAdapt(enabled, log = () => {}) {
  const cfg = readConfig()
  const list = candidatesOf(cfg)
  if (!list.length) throw new Error('config.json 里一个候选都没配，autoAdapt 开关没意义')

  const want = !!enabled
  const was = cfg.dsh?.autoAdapt?.enabled !== false
  if (was === want) {
    log(`自动适配本来就是${want ? '开' : '关'}的，没有改动`)
    return want
  }

  cfg.dsh.autoAdapt = { ...(cfg.dsh.autoAdapt ?? {}), enabled: want }

  if (want) {
    log('自动适配已开启：按候选顺序挑第一个能用的，某个挂了自动往下掉')
  } else {
    const first = list[0]
    cfg.dsh.provider = String(first.provider)
    cfg.dsh.model = String(first.model)
    if (first.reasoningEffort) cfg.dsh.reasoningEffort = String(first.reasoningEffort)
    log(`自动适配已关闭，固定使用 ${first.provider}/${first.model}`)
    log('注意：关掉后就没有自动降级了 —— 这个模型挂了，机器人就直接不说话')
  }

  writeConfig(cfg)
  invalidateModelCache()
  log('已写入 config.json（备份 config.before-launcher.json）')
  return want
}

// ---------------------------------------------------------------- 白名单

const QQ_RE = /^\d{5,12}$/

function dedupeNums(list) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw).trim()
    if (!QQ_RE.test(s) || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

async function bridgeJson(pathname, cfg, init = {}) {
  const token = String(cfg?.consoleToken ?? '')
  const url = `http://127.0.0.1:3100${pathname}?token=${encodeURIComponent(token)}`
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`HTTP ${res.status}${body?.error ? '：' + body.error : ''}`)
  return body
}

/**
 * 白名单全景：允许/拒绝列表 + 联系人名录（用来把 QQ 号显示成名字）。
 * 桥接在线就走它的接口（顺带拿到好友/群名），离线就直接读 config.json，
 * 此时只有号码没有名字 —— 但至少能改。
 */
export async function describeWhitelist() {
  const cfg = readConfig()
  const alive = await portOpen(3100)

  let source = 'file'
  let allow = cfg.allow ?? { private: [], groups: [] }
  let deny = cfg.deny ?? { private: [], groups: [] }
  let ownerQQ = cfg.ownerQQ ?? null
  const contacts = { friends: [], groups: [], error: null }

  if (alive) {
    try {
      const wl = await bridgeJson('/api/whitelist', cfg)
      allow = wl.allow ?? allow
      deny = wl.deny ?? deny
      ownerQQ = wl.ownerQQ ?? ownerQQ
      source = 'bridge'
    } catch (error) {
      contacts.error = `读白名单失败：${error.message}`
    }
    try {
      const c = await bridgeJson('/api/contacts', cfg)
      if (c?.ok) {
        contacts.friends = (c.friends ?? []).map((f) => ({ id: String(f.id), name: String(f.name ?? '') }))
        contacts.groups = (c.groups ?? []).map((g) => ({ id: String(g.id), name: String(g.name ?? '') }))
      } else {
        contacts.error = c?.error ?? '拿不到联系人'
      }
    } catch (error) {
      contacts.error = `拿不到联系人：${error.message}`
    }
  } else {
    contacts.error = '桥接没在跑，只能按号码加，看不到名字'
  }

  const nameOf = new Map()
  for (const f of contacts.friends) nameOf.set(f.id, f.name)
  for (const g of contacts.groups) nameOf.set(g.id, g.name)

  const decorate = (arr) => dedupeNums(arr).map((id) => ({ id, name: nameOf.get(id) || null }))

  return {
    bridgeAlive: alive,
    source,
    ownerQQ: ownerQQ ? String(ownerQQ) : null,
    allow: { private: decorate(allow.private), groups: decorate(allow.groups) },
    deny: { private: decorate(deny.private), groups: decorate(deny.groups) },
    contacts,
  }
}

/**
 * 提交白名单（全量替换 allow）。
 * 桥接在线 → 走 /api/whitelist，它会原子写文件 + 热更新内存 + 重算会话策略；
 * 桥接离线 → 自己写 config.json，下次启动生效。
 */
export async function applyWhitelist({ private: priv, groups }, log = () => {}) {
  const next = { private: dedupeNums(priv), groups: dedupeNums(groups) }
  const cfg = readConfig()
  const alive = await portOpen(3100)

  if (alive) {
    const body = await bridgeJson('/api/whitelist', cfg, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow: next }),
    })
    if (!body?.ok) throw new Error(`桥接拒绝写入：${body?.error ?? '未知原因'}`)
    log(`桥接已接受：私聊 ${next.private.length} 个、群 ${next.groups.length} 个`)
    log('立即生效，不用重启')
    return { via: 'bridge', ...next }
  }

  cfg.allow = {
    private: next.private.map(Number),
    groups: next.groups.map(Number),
  }
  writeConfig(cfg)
  log(`桥接没在跑，已直接写入 config.json：私聊 ${next.private.length} 个、群 ${next.groups.length} 个`)
  log('下次启动桥接时生效')
  return { via: 'file', ...next }
}

// ---------------------------------------------------------------- 重启桥接

/**
 * 让配置生效：桥接活着就走控制台 /api/restart 干净重启，
 * 没活着就什么都不做（下次启动自然读到新配置）。
 */
export async function reloadBridge({ log = () => {}, timeoutMs = 40_000 } = {}) {
  const cfg = readConfig()
  const alive = await portOpen(3100)
  if (!alive) {
    log('桥接当前没在跑 —— 配置已存好，下次启动自动生效，不用重启')
    return { restarted: false, skipped: true }
  }

  const oldPid = readLockPid()
  const token = cfg.consoleToken ?? ''
  log(`桥接活着（pid=${oldPid || '?'}），发重启指令 …`)

  try {
    await fetch(`http://127.0.0.1:3100/api/restart?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    })
  } catch {
    // 重启瞬间连接被掐断是预期行为
  }

  log('等桥接重新上线（以 state\\bridge.lock 的 pid 变化为准）…')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = readLockPid()
    if (pid && pid !== oldPid && (await portOpen(3100))) {
      log(`新 pid=${pid}，已回来`)
      invalidateModelCache()
      return { restarted: true, pid }
    }
    await sleep(1200)
  }

  log('⚠ 40 秒内没等到桥接回来 —— 配置是存好的，但这次没验证成功')
  log('  去启动器点「链路体检」看具体哪一环断了')
  throw new Error('桥接重启超时')
}
