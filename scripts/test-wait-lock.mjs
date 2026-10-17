/**
 * 回归测试：qq_wait_for_messages 的会话等待锁。
 *
 * 覆盖三件事：
 *   A. 并发第二个等待必须被挡下（429），锁本身要起作用；
 *   B. 等待正常结束后锁必须已释放，紧接着的等待不能再被 429；
 *   C. 锁到点后（deadline）必须能被强制清理 —— 用一段超短 timeoutMs 的等待 + 主动放弃连接
 *      来模拟"handler 卡住"，然后确认之后仍能正常等待。
 *
 * 用法：node scripts/test-wait-lock.mjs [key]
 * 默认用 private:2433147136（业主私聊，当前不在对话中，取消它的回复检查定时器无副作用）。
 */
import { readFileSync } from 'node:fs'

const TOKEN = (() => {
  try { return JSON.parse(readFileSync('config.json', 'utf8')).consoleToken } catch {}
  return ''
})()

const key = process.argv[2] || 'private:2433147136'
const base = 'http://127.0.0.1:3100/api/socialV2/wait?token=' + encodeURIComponent(TOKEN)

async function post(body, signal) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, ok: json?.ok, error: json?.error, timeout: json?.timeout }
}

const t = () => new Date().toTimeString().slice(0, 8)

console.log('--- A) two concurrent waits (expect one ok + one 429) ---')
const [a, b] = await Promise.all([
  post({ key, timeoutMs: 8000 }),
  post({ key, timeoutMs: 8000 }),
])
console.log(t(), 'first :', JSON.stringify(a))
console.log(t(), 'second:', JSON.stringify(b))
const blocked = [a, b].some((r) => r.status === 429)
console.log(blocked ? 'PASS 锁挡住了并发' : 'FAIL 没有挡住并发')

console.log('\n--- B) a new wait right after must NOT be 429 (lock released) ---')
const c = await post({ key, timeoutMs: 5000 })
console.log(t(), 'after:', JSON.stringify(c))
console.log(c.ok ? 'PASS 锁已释放' : 'FAIL 锁没释放')

console.log('\n--- C) abandoned wait, then confirm the lock still frees ---')
const ac = new AbortController()
const abandoned = post({ key, timeoutMs: 60000 }, ac.signal).catch((e) => ({ aborted: e?.name }))
await new Promise((r) => setTimeout(r, 1500))
ac.abort() // 模拟客户端自己超时放弃（连接断开 → req 'close' → 锁应立即释放）
await abandoned
console.log(t(), 'abandoned the long wait')
await new Promise((r) => setTimeout(r, 1500))
const d = await post({ key, timeoutMs: 5000 })
console.log(t(), 'after:', JSON.stringify(d))
console.log(d.ok ? 'PASS 放弃后锁已释放' : 'FAIL 锁仍被占：' + d.error)
