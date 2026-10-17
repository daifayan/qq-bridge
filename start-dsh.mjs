// start-dsh.mjs — launch `dsh web` and tee its stdout/stderr to both
// the console and the DSH log file.
//
// Why: dsh prints its access URL (with a fresh random token) to stdout on
// every start. The QQ bridge auto-discovers that token by scanning the
// log file. If dsh is launched directly (dsh.cmd web) the token only
// appears in its own console window and the bridge gets 401 forever.
// This wrapper is the "proper" launch path.
//
// Path resolution (no hardcoded machine paths — this file is open-source):
//   LOG    paths.bat LOGDIR (fallback: ../bridge-logs next to the project)
//   DSHBIN paths.bat DSHBIN -> env DSH_BIN -> auto-detect via
//          scripts/dsh-modules.mjs (probes $DSH_HOME profiles)
import { spawn } from 'node:child_process'
import { existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { loadPaths } from './scripts/paths.mjs'
import { dshModulesDir } from './scripts/dsh-modules.mjs'

const P = loadPaths()
const LOG = join(P.logDir, 'server-dsh.out.log')

// Run dsh's bin.js directly with the current node.exe — avoids the
// whitespace-in-command-path problem that dsh.cmd hits when spawned with
// shell:true.
function resolveDshBin() {
  const fromPaths = String(P.dshBin ?? '').trim()
  if (fromPaths && existsSync(fromPaths)) return fromPaths

  const fromEnv = String(process.env.DSH_BIN ?? '').trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  try {
    const req = createRequire(join(dshModulesDir(), 'package.json'))
    return req.resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch (err) {
    console.error('[start-dsh] 无法定位 DSH 的 lib/bin.js')
    console.error('  请在 paths.bat 里设置 DSHBIN=<DSH 安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js，')
    console.error('  或设置环境变量 DSH_BIN 指向同一文件后重试。')
    console.error(`  自动探测失败原因: ${err?.message ?? err}`)
    process.exit(1)
  }
}

const DSH_BIN = resolveDshBin()

mkdirSync(dirname(LOG), { recursive: true })

const child = spawn(process.execPath, [DSH_BIN, 'web'], {
  env: { ...process.env },
  windowsHide: false,
})

const tee = (chunk) => {
  process.stdout.write(chunk)
  try { appendFileSync(LOG, chunk) } catch {}
}
child.stdout.on('data', tee)
child.stderr.on('data', tee)
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => { console.error(err); process.exit(1) })
