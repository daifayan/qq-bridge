// Windows 启动脚本编码审计：cmd.exe 按字节解析 .bat，任何非 ASCII 字节都可能
// 让后续行错位。CI 在 Linux 和 Windows 都跑这一项，避免“本机双击正常、换机乱码”。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const raw = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
const files = raw
  .toString('utf8')
  .split('\0')
  .filter((file) => /\.(?:bat|cmd)(?:\.example)?$/i.test(file))
  .sort()

let failed = 0
for (const file of files) {
  const buffer = readFileSync(path.join(ROOT, file))
  const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const badBytes = []
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] > 0x7f) badBytes.push(index)
  }
  if (!bom && badBytes.length === 0) continue

  failed += 1
  console.error(`FAIL ${file}${bom ? ' (UTF-8 BOM)' : ''}`)
  if (badBytes.length) {
    console.error(`  first non-ASCII byte at offset ${badBytes[0]} (0x${buffer[badBytes[0]].toString(16)})`)
  }
}

if (failed) {
  console.error(`\nLauncher audit: ${failed}/${files.length} file(s) failed. Keep .bat/.cmd pure ASCII.`)
  process.exitCode = 1
} else {
  console.log(`Launcher audit: ${files.length}/${files.length} file(s) are pure ASCII.`)
}
