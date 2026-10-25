// secret-scan 的回归测试：验证高置信度凭据会被拦下，占位符和示例不会被误报。
import { scanText, isForbiddenPath } from './secret-scan.mjs'

let pass = 0
let fail = 0

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`PASS ${name}`)
  } else {
    fail += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const fakeToken = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'
const fakePrivateKey = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')

const dshFinding = scanText(`https://127.0.0.1/?token=${fakeToken}`, 'fixture.txt')
check('DSH 启动令牌会被识别', dshFinding.some((item) => item.rule === 'DSH launch token'))

const placeholder = scanText('https://127.0.0.1/?token=fixture-console-token', 'fixture.txt')
check('测试占位令牌不会误报', placeholder.length === 0)

const keyFinding = scanText(fakePrivateKey, 'fixture.txt')
check('私钥块会被识别', keyFinding.some((item) => item.rule === 'private key block'))

const assignmentLine = ['consoleToken', ': ', "'", fakeToken, "'"].join('')
const assignmentFinding = scanText(assignmentLine, 'fixture.txt')
check('带随机值的令牌赋值会被识别', assignmentFinding.some((item) => item.rule === 'quoted credential assignment'))

const placeholderLine = ['consoleToken', ': ', "'", 'example-token-value', "'"].join('')
const placeholderAssignment = scanText(placeholderLine, 'fixture.txt')
check('示例令牌赋值不会误报', placeholderAssignment.length === 0)

check('真实 config.json 被禁止提交', isForbiddenPath('config.json') === 'real config.json')
check('config.example.json 允许提交', isForbiddenPath('config.example.json') === null)
check('state 目录被禁止提交', isForbiddenPath('state/sessions.json') === 'runtime state')
check('日志文件被禁止提交', isForbiddenPath('logs/bridge.log') === 'log file')
check('普通源码允许提交', isForbiddenPath('src/bridge.js') === null)

console.log(`\nsecret-scan: ${pass}/${pass + fail} checks passed.`)
if (fail) process.exitCode = 1
