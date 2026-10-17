/**
 * 设置某个会话的唤醒配置（管理端），并在被"沉睡前强制观察"挡下时自动重试。
 *
 * 管理端（不带 x-agent-token）现在已经不受沉睡前观察限制，所以正常情况下一次就成；
 * 重试逻辑保留作为兜底 —— 比如桥接正在重启、或旧版本还在跑。
 *
 * 用法：
 *   node set-wake-config.mjs <key> '<jsonConfig>' [maxWaitMinutes]
 *
 * 例（把某群被叫"杯子"也能唤醒，概率提到 0.3）：
 *   node set-wake-config.mjs group:1054972659 '{"triggers":{"probability":0.3,"keywords":["杯子","傲娇杯子"]}}'
 *
 * jsonConfig 会与下面的 base 深合并，只需要写想改的字段。
 * ⚠️ triggers.keywords 是整体替换，所以要把想保留的旧关键词一起写上。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const [key, jsonArg, maxMinArg] = process.argv.slice(2)
if (!key || !jsonArg) {
  console.error("usage: node set-wake-config.mjs <key> '<jsonConfig>' [maxWaitMinutes]")
  process.exit(2)
}
let overrides
try {
  // 支持 @文件路径（同 curl 的 --data @file）：Windows 的 PowerShell/cmd 会把参数里的
  // 双引号吃掉，内联 JSON 几乎必被搞坏，落盘再读最稳。
  const source = jsonArg.startsWith('@') ? readFileSync(jsonArg.slice(1), 'utf8') : jsonArg
  overrides = JSON.parse(source)
} catch (error) {
  console.error('jsonConfig 读取/解析失败: ' + error.message)
  process.exit(2)
}
const maxWaitMin = Number(maxMinArg) > 0 ? Number(maxMinArg) : 20

function readToken() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
    if (cfg.consoleToken) return String(cfg.consoleToken)
  } catch {}
  try { return readFileSync(join(ROOT, 'state', 'console-token'), 'utf8').trim() } catch {}
  return ''
}
const token = readToken()
if (!token) { console.error('no console token found'); process.exit(2) }

const config = {
  mode: 'diving',
  infinite: true,
  ...overrides,
  triggers: {
    atMention: true,
    nameMention: true,
    question: true,
    poke: true,
    ...(overrides.triggers ?? {}),
  },
}
const url = `http://127.0.0.1:3100/api/socialV2/wake-config?token=${encodeURIComponent(token)}`
const body = JSON.stringify({ key, config })

const deadline = Date.now() + maxWaitMin * 60_000
const at = () => new Date().toTimeString().slice(0, 8)

while (true) {
  let json = null
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    json = await res.json().catch(() => null)
    if (json?.ok) {
      console.log(`${at()} OK  ${key} <- ${JSON.stringify(config)}`)
      process.exit(0)
    }
  } catch (error) {
    console.log(`${at()} --- 桥接暂时不可达: ${error?.message ?? error}`)
  }
  const remain = json?.preSleepWaitRemainingMs
  if (remain === undefined && json && !json.ok) {
    console.log(`${at()} FAIL ${JSON.stringify(json)}`)
    process.exit(1)
  }
  if (Date.now() >= deadline) {
    console.log(`${at()} GIVEUP 等了 ${maxWaitMin} 分钟仍未写入`)
    process.exit(1)
  }
  console.log(`${at()} wait 观察窗口还没开（剩 ${Math.ceil((remain ?? 0) / 1000)}s），30s 后重试`)
  await new Promise((r) => setTimeout(r, 30_000))
}
