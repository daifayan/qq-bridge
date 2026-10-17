/**
 * Probe: does @snowluma/sdk actually retry a connection that never opened?
 *
 * Context: the bridge started while SnowLuma was down (21:45:49) and logged
 * exactly one "SnowLuma error: {}" - then never connected, even after SnowLuma
 * came up 4 minutes later. The SDK's scheduleReconnect() looks correct, so this
 * probe measures the real behaviour against a dead port.
 *
 * Pure ASCII on purpose.
 */
import { SnowLumaWebSocketClient } from '@snowluma/sdk'

const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's'

const c = new SnowLumaWebSocketClient({ url: 'ws://127.0.0.1:3999', reconnect: true })
console.log('normalized reconnect option =', JSON.stringify(c.reconnect))

c.on('error', (e) => console.log(at(), 'error   ', (e && e.message) || JSON.stringify(e) || String(e)))
c.on('close', (i) => console.log(at(), 'close   ', JSON.stringify(i)))
c.on('open', () => console.log(at(), 'OPEN'))

c.connect()
  .then(() => console.log(at(), 'connect() RESOLVED'))
  .catch((e) => console.log(at(), 'connect() REJECTED:', (e && e.message) || e))

setTimeout(() => {
  console.log(at(), 'stopping probe; reconnectAttempts =', c.reconnectAttempts, 'isConnected =', c.isConnected)
  process.exit(0)
}, 12000)
