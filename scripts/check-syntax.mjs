// 跨平台语法检查：只检查 Git 跟踪的 src/ 与 scripts/ 下的 JS/MJS。
// 用 Node 而不是 shell 循环，保证 Windows 和 Linux CI 行为一致。
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const raw = execFileSync('git', ['ls-files', '-z', '--', 'src', 'scripts'], {
  cwd: ROOT,
  encoding: 'buffer',
})
const files = raw
  .toString('utf8')
  .split('\0')
  .filter((file) => /\.(?:js|mjs)$/i.test(file))
  .sort()

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], {
    encoding: 'utf8',
  })
  if (result.status === 0) continue
  failed += 1
  console.error(`FAIL ${file}`)
  const detail = (result.stderr || result.stdout || '').trim()
  if (detail) console.error(detail.split('\n').slice(0, 4).join('\n'))
}

if (failed) {
  console.error(`\nSyntax check: ${failed}/${files.length} file(s) failed.`)
  process.exitCode = 1
} else {
  console.log(`Syntax check: ${files.length}/${files.length} files passed.`)
}
