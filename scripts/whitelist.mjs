/**
 * 白名单命令行工具（管理端）。
 *
 *   node scripts/whitelist.mjs show
 *   node scripts/whitelist.mjs private-add <QQ>
 *   node scripts/whitelist.mjs private-remove <QQ>
 *   node scripts/whitelist.mjs group-add <群号>
 *   node scripts/whitelist.mjs group-remove <群号>
 *   node scripts/whitelist.mjs owner <QQ|->          （- 表示清除管理员）
 *
 * 读写都走 scripts/whitelist-lib.mjs：读不到就中止，绝不用空值覆盖。
 * 想要中文交互界面就用仓库根目录的 whitelist-menu.mjs（桌面快捷方式指向它）。
 */
import { loadWhitelist, saveWhitelist, listAdd, listDel } from './whitelist-lib.mjs'

const [cmd, arg] = process.argv.slice(2)
const usage = () => console.error('用法见 scripts/whitelist.mjs 文件头注释')

const w = await loadWhitelist()
const fmt = (label, p, g) => {
  console.log(`${label} 允许私聊: ${p.join(', ') || '（空）'}`)
  console.log(`${label} 允许群  : ${g.join(', ') || '（空）'}   管理员: ${w.ownerQQ ?? '未设置'}`)
}

if (!cmd || cmd === 'show') {
  fmt('·', w.private, w.groups)
  console.log(`· 拒绝私聊: ${w.denyPrivate.join(', ') || '（空）'}`)
  console.log(`· 拒绝群  : ${w.denyGroups.join(', ') || '（空）'}`)
  process.exit(0)
}

if (!arg) { usage(); process.exit(2) }

// ⚠️ 先快照"改前"，再改动 —— 否则打印出来的"改前"其实是改完的状态。
const before = { private: [...w.private], groups: [...w.groups] }
let next = { private: w.private, groups: w.groups }
let ownerQQ

switch (cmd) {
  case 'private-add': next = { private: listAdd(w.private, arg), groups: w.groups }; break
  case 'private-remove': next = { private: listDel(w.private, arg), groups: w.groups }; break
  case 'group-add': next = { private: w.private, groups: listAdd(w.groups, arg) }; break
  case 'group-remove': next = { private: w.private, groups: listDel(w.groups, arg) }; break
  case 'owner': ownerQQ = arg === '-' ? '' : arg; break
  default: usage(); process.exit(2)
}

fmt('改前:', before.private, before.groups)
await saveWhitelist({ ...next, ownerQQ })
const after = await loadWhitelist()
console.log('')
console.log(`改后: 允许私聊: ${after.private.join(', ') || '（空）'}`)
console.log(`改后: 允许群  : ${after.groups.join(', ') || '（空）'}   管理员: ${after.ownerQQ ?? '未设置'}`)
