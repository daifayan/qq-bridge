// QQ 自带表情（kind='face'）支持回归测试 —— 纯函数，不联网、不动真实表情库。
//
// 背景（2026-10-01）：owner 发了个 QQ 自带的骰子表情（[CQ:face,id=358]），AI 想"偷"却报
// 「无法获取该表情的图片源」—— 因为 face 不是收藏表情（没有图片），收藏路径必然失败。
// 现在 face 走 OneBot 的 face 段直发，并作为 kind='face' 条目记进本地表情库。
//
// 用法：node scripts/test-sticker-face.mjs
import {
  normalizeStickerEntry, findSticker, formatStickerList, buildStickerContext,
  buildStickerStrategyHint, mergeStickerLibrary, applyStickerNote, markStickerUsed
} from '../src/sticker-lib.js'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`) }
}

const face = normalizeStickerEntry({ kind: 'face', faceId: '358', desc: '骰子', tags: ['QQ自带'], source: 'manual' })
const face2 = normalizeStickerEntry({ id: 'face:359', faceId: '359', desc: '包剪锤' })
const img = normalizeStickerEntry({ emoji_id: 'abc123', url: 'https://example.com/a.png', md5: 'aabbcc', desc: '一只猫' })
const list = [face, face2, img]

console.log('[1] 归一化')
check('face 条目 kind=face、id=face:358、faceId=358', face.kind === 'face' && face.id === 'face:358' && face.faceId === '358', JSON.stringify(face))
check('只给 id="face:359" 也能推出 faceId', face2.kind === 'face' && face2.faceId === '359', JSON.stringify(face2))
check('图片条目仍是 kind=image（没被误判）', img.kind === 'image' && img.faceId === '', JSON.stringify(img))

console.log('\n[2] 查找（AI 可能用各种写法引用）')
check('findSticker("face:358")', findSticker(list, 'face:358')?.desc === '骰子')
check('findSticker("face358")', findSticker(list, 'face358')?.desc === '骰子')
check('findSticker("358") 裸数字', findSticker(list, '358')?.desc === '骰子')
check('findSticker("abc123") 图片 id 仍可用', findSticker(list, 'abc123')?.desc === '一只猫')
check('findSticker("aabbcc") md5 仍可用', findSticker(list, 'aabbcc')?.desc === '一只猫')
check('findSticker("999") 找不到就返回 null', findSticker(list, '999') === null)

console.log('\n[3] 列表 / 搜索')
const byName = formatStickerList(list, '骰子')
check('按备注搜"骰子"命中 1 条', byName.matched === 1, JSON.stringify(byName.stickers))
check('返回项带 kind=face 与 faceId', byName.stickers[0]?.kind === 'face' && byName.stickers[0]?.faceId === '358')
check('返回项带"怎么发"的提示', /qq_send_sticker/.test(byName.stickers[0]?.hint ?? ''))
check('按 id 搜 "face:359" 命中', formatStickerList(list, 'face:359').matched === 1)
check('按 faceId 搜 "359" 命中', formatStickerList(list, '359').matched === 1)

console.log('\n[4] 注入提示')
const ctx = buildStickerContext(list, 5)
check('摘要里点名 QQ 自带表情与 id', /QQ 自带表情/.test(ctx) && /face:358/.test(ctx), ctx.replace(/\n/g, ' | ').slice(0, 260))
const hint = buildStickerStrategyHint()
check('策略提示写明骰子/包剪锤发不了', /骰子（face:358）/.test(hint) && /发不了/.test(hint), hint.slice(0, 200))
check('策略提示给出替代方案（用文字骰子）', /🎲 5/.test(hint))
check('策略提示写明普通系统表情仍可发', /face:<数字>/.test(hint))

console.log('\n[5] 与 QQ 端同步时的存活（关键：不能被"清理已删除收藏"误删）')
const pruned = mergeStickerLibrary(list, [{ emoji_id: 'other' }], { complete: true })
check('face 条目在 prune 后幸存', pruned.some((e) => e.id === 'face:358') && pruned.some((e) => e.id === 'face:359'), pruned.map((e) => e.id).join(','))
check('没被 fetch 到的 qq 图片条目被清掉（原行为不变）', !pruned.some((e) => e.id === 'abc123'), pruned.map((e) => e.id).join(','))

console.log('\n[6] 备注/记忆/使用计数对 face 条目同样有效')
const noted = applyStickerNote(list, 'face:358', { note: '和群友玩随机数用', tags: ['随机'] })
check('applyStickerNote 能改 face 条目', noted.entry?.localNote === '和群友玩随机数用' && noted.entry?.kind === 'face', JSON.stringify(noted.entry))
const used = markStickerUsed(list, 'face:358', 'sticker')
check('markStickerUsed 能记 face 条目', used.entry?.useCount === 1 && used.entry?.kind === 'face')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
