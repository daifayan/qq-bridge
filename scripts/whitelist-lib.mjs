/**
 * 白名单读写共享库（控制台 /api/whitelist 的封装）。
 *
 * 安全约定（吃过亏，写在这里）：
 *  1. 读失败/结构不对 → 抛错中止，**绝不拿空值去覆盖**真实配置。
 *  2. URL 用模板串拼，不要在 PowerShell 里拼 "$base?$token" ——
 *     PowerShell 会把 `?` 吞进变量名（`$base?`），URL 变残缺，加 `-s` 还会把错误静默掉。
 *  3. 所有写入都走这里，规则只有一份。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function readConsoleToken() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
    if (cfg.consoleToken) return String(cfg.consoleToken)
  } catch {}
  try { return readFileSync(join(ROOT, 'state', 'console-token'), 'utf8').trim() } catch {}
  return ''
}

const token = readConsoleToken()
export const BASE = token
  ? `http://127.0.0.1:3100/api/whitelist?token=${encodeURIComponent(token)}`
  : ''

export const norm = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x)) : [])

/** 读取白名单；失败即抛错。 */
export async function loadWhitelist() {
  if (!BASE) throw new Error('找不到控制台令牌（config.json 的 consoleToken / state/console-token）')
  const res = await fetch(BASE, { signal: AbortSignal.timeout(8000) })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.allow || !Array.isArray(json.allow.private) || !Array.isArray(json.allow.groups)) {
    throw new Error(`读取白名单失败（HTTP ${res.status}）：${JSON.stringify(json)}`)
  }
  return {
    private: norm(json.allow.private),
    groups: norm(json.allow.groups),
    denyPrivate: norm(json.deny?.private),
    denyGroups: norm(json.deny?.groups),
    ownerQQ: json.ownerQQ ?? null,
  }
}

/** 写入白名单（只动 allow，deny/ownerQQ 不传就保持原值）。 */
export async function saveWhitelist({ private: priv, groups, ownerQQ }) {
  const body = { allow: { private: priv, groups } }
  if (ownerQQ !== undefined) body.ownerQQ = ownerQQ
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.ok) throw new Error(`写入失败（HTTP ${res.status}）：${JSON.stringify(json)}`)
  return json
}

export const listAdd = (list, v) => (list.includes(String(v)) ? list : [...list, String(v)])
export const listDel = (list, v) => list.filter((x) => x !== String(v))

/** 读 OneBot（SnowLuma）接口，用于"这个号真的存在吗"这类校验。失败返回 null，不阻塞主流程。 */
export async function onebot(action, params = {}) {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
    const base = cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000'
    const headers = { 'content-type': 'application/json' }
    if (cfg.snowluma?.accessToken) headers.authorization = `Bearer ${cfg.snowluma.accessToken}`
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000),
    })
    const json = await res.json().catch(() => null)
    return json?.status === 'ok' ? json.data : null
  } catch {
    return null
  }
}
