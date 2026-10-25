// 仓库级凭据扫描：只扫描 Git 跟踪的文本文件，不读取未跟踪的本地配置和状态。
// 目标是拦住高置信度的密钥、令牌、私钥和本应被忽略的敏感文件，不替代专业密钥扫描器。
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAX_BYTES = 2 * 1024 * 1024

const FORBIDDEN_PATHS = [
  { name: 'real config.json', test: (file) => /(^|\/)config\.json$/i.test(file) },
  { name: 'runtime state', test: (file) => /(^|\/)state\//i.test(file) },
  { name: 'log file', test: (file) => /\.log$/i.test(file) },
  { name: 'shortcut file', test: (file) => /\.lnk$/i.test(file) },
  { name: 'backup file', test: (file) => /\.bak(?:-|$)/i.test(file) },
  { name: 'dotenv file', test: (file) => /(^|\/)\.env(?:\.(?:local|production|development))?$/i.test(file) },
  { name: 'credential file', test: (file) => /(^|\/)(?:console-token|sessions\.json|social-v2\.json|current-role\.json)$/i.test(file) },
  { name: 'private key file', test: (file) => /\.(?:pem|key|p12|pfx)$/i.test(file) },
]

const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36,}\b/ },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'DSH launch token', re: /[?&]token=([A-Za-z0-9_-]{32,})/ },
]

const ASSIGNMENT_RE = /(?:accessToken|consoleToken|authToken|apiKey|password|passwd|secret)\s*[:=]\s*["'`]([^"'`\n]{16,})["'`]/gi

const PLACEHOLDER_RE = /(?:example|fixture|dummy|placeholder|change[-_ ]?me|redacted|replace[-_ ]?me|your[-_ ]|xxxx|<[^>]+>|\$\{|process\.env)/i

export function isForbiddenPath(file) {
  const normalized = String(file).replace(/\\/g, '/')
  return FORBIDDEN_PATHS.find((entry) => entry.test(normalized))?.name ?? null
}

function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(value)
}

function looksRandom(value) {
  if (value.length < 24 || isPlaceholder(value)) return false
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length
  return classes >= 2
}

export function scanText(text, file = '<text>') {
  const findings = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.re.exec(line)
      if (!match) continue
      if (pattern.name === 'DSH launch token' && isPlaceholder(match[1])) continue
      findings.push({ file, line: index + 1, rule: pattern.name })
    }

    ASSIGNMENT_RE.lastIndex = 0
    let assignment
    while ((assignment = ASSIGNMENT_RE.exec(line)) !== null) {
      if (!looksRandom(assignment[1])) continue
      findings.push({ file, line: index + 1, rule: 'quoted credential assignment' })
    }
  }
  return findings
}

export function scanRepository(root = ROOT) {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
  const files = raw.toString('utf8').split('\0').filter(Boolean)
  const findings = []

  for (const file of files) {
    const forbidden = isForbiddenPath(file)
    if (forbidden) {
      findings.push({ file, line: 0, rule: `tracked ${forbidden}` })
      continue
    }

    const absolute = path.join(root, file)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      continue
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) continue

    let buffer
    try {
      buffer = readFileSync(absolute)
    } catch {
      continue
    }
    if (buffer.includes(0)) continue // 二进制文件
    findings.push(...scanText(buffer.toString('utf8'), file))
  }

  return { files: files.length, findings }
}

function main() {
  const { files, findings } = scanRepository()
  if (!findings.length) {
    console.log(`Secret scan: ${files} tracked files passed.`)
    return
  }
  for (const finding of findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file
    console.error(`SECRET ${location} [${finding.rule}]`)
  }
  console.error(`\nSecret scan: ${findings.length} finding(s) in ${files} tracked files.`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
