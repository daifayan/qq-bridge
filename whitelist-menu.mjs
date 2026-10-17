/**
 * QQ 机器人 · 聊天白名单管理（交互式，给桌面快捷方式用）
 *
 * 为什么要一个 Node 菜单而不是纯 .bat：
 *   cmd.exe 按字节解析 .bat，脚本里出现中文就会把后续行解析错位（吃过这个坑）。
 *   所以 .bat 只负责 chcp 65001 + 调起本脚本，中文界面全部放在这个 UTF-8 的 .mjs 里。
 *
 * 用法：双击桌面「白名单管理」，或 node whitelist-menu.mjs
 */
import readline from 'node:readline'
import { loadWhitelist, saveWhitelist, listAdd, listDel, onebot } from './scripts/whitelist-lib.mjs'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY === true,
})
const iter = rl[Symbol.asyncIterator]()

/** 输入流结束（EOF/管道）时抛出，由 main 统一优雅退出。 */
class InputEnded extends Error {}

/**
 * 用 readline 的异步迭代器读一行，而不是 rl.question：
 * 管道/重定向输入时 rl.question 的回调永远不会触发（输入一进来就 EOF），
 * 菜单会直接挂死或提前退出 —— 那样既不能用管道测试，也不是我们想要的语义。
 */
async function ask(prompt) {
  process.stdout.write(prompt)
  const { value, done } = await iter.next()
  if (done) throw new InputEnded()
  return String(value ?? '').trim()
}

function render(w) {
  console.log('')
  console.log('='.repeat(66))
  console.log('   QQ 机器人 · 聊天白名单管理')
  console.log('='.repeat(66))
  console.log('   允许私聊 : ' + (w.private.join(', ') || '（空）'))
  console.log('   允许群   : ' + (w.groups.join(', ') || '（空）'))
  console.log('   管理员   : ' + (w.ownerQQ ?? '未设置') + '   （唯一能用管理命令的人）')
  console.log('   拒绝私聊 : ' + (w.denyPrivate.join(', ') || '（空）'))
  console.log('   拒绝群   : ' + (w.denyGroups.join(', ') || '（空）'))
  console.log('-'.repeat(66))
  console.log('   1) 加私聊      2) 删私聊      3) 加群      4) 删群')
  console.log('   5) 改管理员    6) 刷新        q) 退出')
  console.log('-'.repeat(66))
  console.log('   白名单同时管"收"和"发"：不在名单里的群/人，机器人既不回，也不能主动发。')
  console.log('')
}

const isQq = (s) => /^\d{5,12}$/.test(s)

async function main() {
  console.log('正在读取当前白名单…')
  let w = await loadWhitelist()

  for (;;) {
    render(w)
    const choice = (await ask('   请选择> ')).toLowerCase()
    console.log('')

    if (choice === 'q' || choice === 'quit' || choice === 'exit') break

    if (choice === '6') {
      w = await loadWhitelist()
      console.log('   已刷新。')
      continue
    }

    if (choice === '1' || choice === '2') {
      const qq = await ask(choice === '1' ? '   要加入白名单的 QQ 号：' : '   要移出白名单的 QQ 号：')
      if (!isQq(qq)) { console.log('   ✗ 不是有效的 QQ 号（应为 5~12 位数字），已取消。'); continue }

      if (choice === '1') {
        // 先确认这个号真的是机器人的好友，否则加到白名单也收不到私聊
        const friends = await onebot('get_friend_list')
        const hit = Array.isArray(friends) ? friends.find((f) => String(f.user_id) === qq) : null
        if (Array.isArray(friends) && !hit) {
          console.log(`   ⚠ ${qq} 不在机器人的好友列表里。`)
          console.log('     不是好友的话，他发的私聊根本到不了机器人，加白名单也没用。')
          const go = (await ask('   仍然要加吗？(y/N) ')).toLowerCase()
          if (go !== 'y' && go !== 'yes') { console.log('   已取消。'); continue }
        } else if (hit) {
          console.log(`   找到好友：${hit.nickname || '(无昵称)'}（${qq}）`)
        }
        await saveWhitelist({ private: listAdd(w.private, qq), groups: w.groups })
        console.log(`   ✓ 已加入允许私聊：${qq}`)
      } else {
        const after = listDel(w.private, qq)
        if (after.length === w.private.length) { console.log(`   ${qq} 本来就不在白名单里，无需删除。`); continue }
        await saveWhitelist({ private: after, groups: w.groups })
        console.log(`   ✓ 已从允许私聊移除：${qq}`)
      }
      w = await loadWhitelist()
      continue
    }

    if (choice === '3' || choice === '4') {
      const gid = await ask(choice === '3' ? '   要加入白名单的群号：' : '   要移出白名单的群号：')
      if (!isQq(gid)) { console.log('   ✗ 不是有效的群号（应为 5~12 位数字），已取消。'); continue }

      if (choice === '3') {
        // 机器人必须已经在这个群里，否则收不到该群消息
        const groups = await onebot('get_group_list')
        const hit = Array.isArray(groups) ? groups.find((g) => String(g.group_id) === gid) : null
        if (Array.isArray(groups) && !hit) {
          console.log(`   ⚠ 机器人不在群 ${gid} 里。`)
          console.log('     不加入该群的话，群消息到不了机器人，加白名单也没用。')
          const go = (await ask('   仍然要加吗？(y/N) ')).toLowerCase()
          if (go !== 'y' && go !== 'yes') { console.log('   已取消。'); continue }
        } else if (hit) {
          console.log(`   找到群：${hit.group_name || '(无群名)'}（${gid}）`)
        }
        await saveWhitelist({ private: w.private, groups: listAdd(w.groups, gid) })
        console.log(`   ✓ 已加入允许群：${gid}`)
      } else {
        const after = listDel(w.groups, gid)
        if (after.length === w.groups.length) { console.log(`   群 ${gid} 本来就不在白名单里，无需删除。`); continue }
        await saveWhitelist({ private: w.private, groups: after })
        console.log(`   ✓ 已从允许群移除：${gid}`)
      }
      w = await loadWhitelist()
      continue
    }

    if (choice === '5') {
      const qq = await ask('   新的管理员 QQ（直接回车 = 清除管理员）：')
      if (qq && !isQq(qq)) { console.log('   ✗ 不是有效的 QQ 号，已取消。'); continue }
      await saveWhitelist({ private: w.private, groups: w.groups, ownerQQ: qq })
      console.log(qq ? `   ✓ 管理员已设为：${qq}` : '   ✓ 管理员已清除（清除后没人能用管理命令，fail-closed）。')
      w = await loadWhitelist()
      continue
    }

    console.log('   ✗ 没看懂这个选项，请输入 1~6 或 q。')
  }

  console.log('   已退出。白名单改动立即生效，无需重启任何服务。')
  rl.close()
  process.exit(0)
}

main().catch((error) => {
  if (error instanceof InputEnded) {
    console.log('')
    console.log('   输入结束，退出。白名单改动立即生效，无需重启任何服务。')
    process.exit(0)
  }
  console.log('')
  console.log('   ✗ 出错：' + (error?.message ?? error))
  console.log('     （桥接没在跑？双击“DeepSeek 全家桶”把服务拉起来再试）')
  process.exit(1)
})
