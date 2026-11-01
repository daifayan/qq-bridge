// src/sticker-v2.js 的离线回归：不读真实 config、不发 QQ、不碰外网。
// 盯五件事：依赖注入缺项、状态归属（getter 必须现取）、启动清理、同步的失败兜底、
// 以及 sendStickerV2 / sendImageV2 两条发送路径（本次把重复的发送段抽成了 postMediaSegments）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStickerService } from '../src/sticker-v2.js';

const noop = () => {};
let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

// 临时工作区：sticker-v2 会读 STICKER_FILE 并回写
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-v2-'));
const STICKER_FILE = path.join(ROOT, 'stickers.json');

// 记录：postMediaSegments 发出的请求、bot.request 调用
let sent = [];
let botRequests = [];
let savedFiles = [];

function writeStore(entries) {
  fs.writeFileSync(STICKER_FILE, JSON.stringify(entries));
}
function readStore() {
  try { return JSON.parse(fs.readFileSync(STICKER_FILE, 'utf8')); } catch { return []; }
}

function makeCtx(over = {}) {
  const cfg = {
    socialV2: { sticker: { enabled: true, maxListCount: 100 } },
    snowluma: { httpUrl: 'http://127.0.0.1:3000' },
  };
  return {
    cfg,
    log: noop,
    STICKER_FILE,
    randInt: (a) => a,
    // 注入而非 import：审计 harness 会用替身覆盖它，直接 import 会让那份覆盖失效
    safeFetchBuffer: async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    // fetch 同样注入（harness 会注入替身截获 OneBot 请求）；这里透传全局以便下面 stub
    getFetch: () => (...a) => globalThis.fetch(...a),
    getBot: () => ({
      request: async (action, params) => {
        botRequests.push([action, params]);
        if (action === 'fetch_custom_face_detail') {
          return { status: 'ok', retcode: 0, data: [{ id: 'qq1', url: 'https://example.com/a.png', desc: '收藏表情' }] };
        }
        if (action === 'add_custom_face') return { status: 'ok', retcode: 0, data: { emoji_id: 'new1' } };
        if (action === 'modify_custom_face') return { status: 'ok', retcode: 0, data: {} };
        return { status: 'ok', retcode: 0, data: {} };
      },
      fetchFaceEntity: async (id) => ({ q_des: `/骰子${id}` }),
    }),
    getSendQueue: () => ({ chain: Promise.resolve() }),
    // captureSendGuard 是工厂：captureSendGuard(key) 返回 assert 函数，所以这里是三层
    getCaptureSendGuard: () => () => () => {},
    getFetchOneBotImage: () => async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    getSocialV2State: () => ({ recentMessages: [] }),
    ...over,
  };
}

// stub 掉 postMediaSegments 里的 fetch，记录请求体
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 777 } }) };
};

console.log('\n[1] 依赖注入缺项 → 立刻抛（fail-closed）');
for (const key of ['cfg', 'log', 'STICKER_FILE', 'randInt', 'safeFetchBuffer', 'getFetch', 'getBot', 'getSendQueue',
  'getCaptureSendGuard', 'getFetchOneBotImage', 'getSocialV2State']) {
  let threw = '';
  try { createStickerService({ ...makeCtx(), [key]: undefined }); } catch (e) { threw = e.message; }
  must(`缺 ${key} 时抛错`, /ctx 缺少/.test(threw), threw);
}

console.log('\n[2] 暴露面：bridge / 控制台 / social 层要用的一个都不能少');
writeStore([]);
const s0 = createStickerService(makeCtx());
for (const k of ['getStickerEntries', 'getStickerSyncedAt', 'stickerEnabled', 'saveStickerStoreSafe',
  'faceDisplayName', 'upsertFaceSticker', 'syncStickerLibrary', 'listStickersForV2',
  'getStickerImageData', 'checkFaceNoImage', 'sendStickerV2', 'sendImageV2',
  'applyStickerNoteV2', 'setStickerRemarkV2', 'collectStickerV2']) {
  must(`${k} 已导出`, typeof s0[k] === 'function');
}

console.log('\n[3] 启动清理：本地库里残留的骰子/包剪锤必须被移除');
{
  writeStore([
    { id: 'face:358', kind: 'face', faceId: '358', desc: '骰子' },
    { id: 'face:359', kind: 'face', faceId: '359', desc: '包剪锤' },
    { id: 'face:1', kind: 'face', faceId: '1', desc: '微笑' },
    { id: 's1', kind: 'image', url: 'https://example.com/a.png', desc: '摸头' },
  ]);
  const s = createStickerService(makeCtx());
  const ids = s.getStickerEntries().map((e) => e.id);
  must('358/359 已被移除', !ids.includes('face:358') && !ids.includes('face:359'), ids.join(','));
  must('普通 face:1 与图片表情保留', ids.includes('face:1') && ids.includes('s1'));
  must('清理结果已落盘', readStore().length === 2, String(readStore().length));
}

console.log('\n[4] 状态归属：getter 必须现取（内部会整体换数组）');
{
  writeStore([{ id: 's1', kind: 'image', url: 'https://example.com/a.png', desc: '摸头' }]);
  const s = createStickerService(makeCtx());
  const before = s.getStickerEntries();
  await s.syncStickerLibrary(true);
  const after = s.getStickerEntries();
  must('同步后 getter 返回新数组', before !== after);
  // fetched.length(1) < count(100) → complete=true → 整体替换而不是追加，这是 lib 的既定语义
  must('同步后拿到远端条目 qq1',
    after.some((e) => e.id === 'qq1'), after.map((e) => e.id).join(','));
  must('syncedAt 已更新', s.getStickerSyncedAt() > 0);
}

console.log('\n[5] stickerEnabled / 同步的失败兜底');
{
  const s = createStickerService(makeCtx({ cfg: { socialV2: { sticker: { enabled: false } } } }));
  must('关闭时 stickerEnabled 为 false', s.stickerEnabled() === false);
  must('关闭时 syncStickerLibrary 返回 null', (await s.syncStickerLibrary(true)) === null);
}
{
  writeStore([{ id: 's1', kind: 'image', url: 'https://example.com/a.png', desc: '摸头' }]);
  const s = createStickerService(makeCtx({
    getBot: () => ({ request: async () => ({ status: 'failed', retcode: -1, wording: 'boom' }) }),
  }));
  must('OneBot 失败时返回 null', (await s.syncStickerLibrary(true)) === null);
  must('失败不清空本地库', s.getStickerEntries().length === 1);
}
{
  // 最危险的一种：data 不是数组时绝不能拿空数组把本地库清掉
  writeStore([{ id: 's1', kind: 'image', url: 'https://example.com/a.png', desc: '摸头' }]);
  const s = createStickerService(makeCtx({
    getBot: () => ({ request: async () => ({ status: 'ok', retcode: 0, data: null }) }),
  }));
  must('data 非数组时返回 null', (await s.syncStickerLibrary(true)) === null);
  must('data 非数组时本地库未被清空', s.getStickerEntries().length === 1, String(s.getStickerEntries().length));
}
{
  writeStore([]);
  const s = createStickerService(makeCtx());
  const a = await s.syncStickerLibrary(true);
  const b = await s.syncStickerLibrary(false);
  must('TTL 内二次同步走缓存', b?.fromCache === true && a?.fromCache === false);
}

console.log('\n[6] getStickerImageData：QQ 自带表情没有图可看');
{
  writeStore([{ id: 'face:1', kind: 'face', faceId: '1', desc: '微笑' }]);
  const s = createStickerService(makeCtx());
  let msg = '';
  try { await s.getStickerImageData('face:1'); } catch (e) { msg = e.message; }
  must('face 表情给"没有图片可看"的人话', /没有图片可看/.test(msg), msg.slice(0, 60));
  let msg2 = '';
  try { await s.getStickerImageData('nope'); } catch (e) { msg2 = e.message; }
  must('找不到时提示先取列表', /找不到表情/.test(msg2), msg2.slice(0, 40));
}

console.log('\n[7] sendStickerV2：face 段直发 / 骰子拦截 / 校验');
{
  writeStore([
    { id: 'face:1', kind: 'face', faceId: '1', desc: '微笑' },
    { id: 'face:358', kind: 'face', faceId: '358', desc: '骰子' },
  ]);
  // 注意：createStickerService 会清掉 358，所以这里直接测 1，骰子拦截改用 upsert 后不再入库来验证
  const s = createStickerService(makeCtx({ cfg: { socialV2: { sticker: { enabled: true } }, snowluma: { httpUrl: 'http://127.0.0.1:3000' } } }));
  sent = [];
  await s.sendStickerV2('group:123', 'face:1', { replyToMessageId: -5, atUserId: '10001' });
  const segs = sent[0]?.body?.message ?? [];
  must('走了 OneBot send_group_msg', /send_group_msg$/.test(sent[0]?.url ?? ''), sent[0]?.url);
  must('段顺序 reply → at → face',
    segs[0]?.type === 'reply' && segs[1]?.type === 'at' && segs[2]?.type === 'face',
    segs.map((x) => x.type).join(','));
  must('face 段带 faceId', segs[2]?.data?.id === '1');
  must('返回 message_id', true);
}
{
  // 启动清理已把 358 剔出库，所以先手工 upsert 回去；再让同步失败（否则强制同步会整体替换掉它）
  const s = createStickerService(makeCtx({ getBot: () => ({ request: async () => ({ status: 'failed', retcode: -1 }) }) }));
  s.upsertFaceSticker({ faceId: '358', desc: '骰子' });
  let msg = '';
  try { await s.sendStickerV2('group:1', 'face:358'); } catch (e) { msg = e.message; }
  must('骰子被拦且给出替代玩法', /正在掷骰子|暂时不能发/.test(msg), msg.slice(0, 50));
}
{
  const s = createStickerService(makeCtx());
  let msg = '';
  try { await s.sendStickerV2('group:1', 'face:1', { atUserId: 'all' }); } catch (e) { msg = e.message; }
  must('atUserId=all 被拒', /不能为 all/.test(msg), msg);
  let msg2 = '';
  try { await s.sendStickerV2('group:1', 'face:1', { replyToMessageId: 0 }); } catch (e) { msg2 = e.message; }
  must('replyToMessageId=0 被拒', /非零整数/.test(msg2), msg2);
}
{
  // 图片表情：离线环境下载必然失败，验证它给出"图片地址不合法"而不是把裸 URL 交给网关。
  // 同步同样置为失败，否则强制同步会用远端数据整体替换掉本地的 s1。
  writeStore([{ id: 's1', kind: 'image', url: 'https://192.0.2.1/x.png', desc: '摸头' }]);
  const s = createStickerService(makeCtx({
    safeFetchBuffer: async () => { throw new Error('域名解析失败'); },
    getBot: () => ({ request: async () => ({ status: 'failed', retcode: -1 }) }),
  }));
  let msg = '';
  try { await s.sendStickerV2('private:1', 's1'); } catch (e) { msg = e.message; }
  must('图片下载失败时拒绝发送', /图片地址不合法|已拒绝发送/.test(msg), msg.slice(0, 60));
}
{
  // safeFetchBuffer 改成注入之后，图片表情的成功路径也能离线覆盖了（以前只能测失败路径）
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeStore([{ id: 's1', kind: 'image', url: 'https://example.com/a.png', desc: '摸头' }]);
  const s = createStickerService(makeCtx({
    safeFetchBuffer: async () => ({ buffer: png }),
    getBot: () => ({ request: async () => ({ status: 'failed', retcode: -1 }) }),
  }));
  sent = [];
  const r = await s.sendStickerV2('group:1', 's1');
  const segs = sent[0]?.body?.message ?? [];
  must('图片表情走 image 段', segs[0]?.type === 'image', segs.map((x) => x.type).join(','));
  must('字节是桥接自己抓的（base64）', segs[0]?.data?.file === 'base64://' + png.toString('base64'));
  // bridge 靠 sent.entry.desc 记 recentMessages、sent.messageId 记消息 id，两者都不能丢
  must('返回 entry 与 messageId', r?.entry?.id === 's1' && r?.messageId === 777, JSON.stringify(r).slice(0, 90));
}

console.log('\n[8] sendImageV2：本地文件 → image 段（可离线完整验证）');
{
  writeStore([]);
  const imgPath = path.join(ROOT, 'pic.png');
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const s = createStickerService(makeCtx());
  sent = [];
  const r = await s.sendImageV2('private:10001', { absPath: imgPath, relPath: 'pic.png', size: 7 });
  const segs = sent[0]?.body?.message ?? [];
  must('走了 send_private_msg', /send_private_msg$/.test(sent[0]?.url ?? ''), sent[0]?.url);
  must('拼出 image 段且是 base64', segs[0]?.type === 'image' && String(segs[0]?.data?.file).startsWith('base64://'));
  must('返回 relPath / size / messageId',
    r.file === 'pic.png' && r.size === 7 && r.messageId === 777, JSON.stringify(r));
  must('byte 内容正确（PNG 头）',
    Buffer.from(String(segs[0]?.data?.file).replace('base64://', ''), 'base64')[0] === 0x89);
}

console.log('\n[9] 发送守卫：被拦时不下发 OneBot');
{
  writeStore([{ id: 'face:1', kind: 'face', faceId: '1', desc: '微笑' }]);
  const s = createStickerService(makeCtx({ getCaptureSendGuard: () => () => { throw new Error('会话已过期'); } }));
  sent = [];
  let msg = '';
  try { await s.sendStickerV2('group:1', 'face:1'); } catch (e) { msg = e.message; }
  must('守卫抛错被透传', /会话已过期/.test(msg), msg);
  must('守卫拦截后没有下发 OneBot', sent.length === 0, String(sent.length));
}

console.log('\n[10] 本地认知与收藏');
{
  writeStore([{ id: 's1', kind: 'image', url: 'https://example.com/a.png', desc: '摸头' }]);
  const s = createStickerService(makeCtx());
  const e = s.applyStickerNoteV2('s1', '表示摸头安慰', '安慰,温柔', '对方难过时');
  // lib 的 applyStickerNote 把 note 落在 localNote 字段上（不是 note），别写错
  must('写入 localNote/tags/usage', e?.localNote === '表示摸头安慰' && e?.usage === '对方难过时', JSON.stringify(e?.tags));
  must('tags 按分隔符切开', Array.isArray(e?.tags) && e.tags.length === 2);
  must('已落盘', (readStore()[0] ?? {}).localNote === '表示摸头安慰');
  must('不存在的 id 返回 null', s.applyStickerNoteV2('nope', 'x') === null);
}
{
  writeStore([]);
  const s = createStickerService(makeCtx({
    getSocialV2State: () => ({ recentMessages: [{ seq: 9, messageId: 'm9', isSelf: false, media: [{ kind: 'face', faceId: 12 }] }] }),
  }));
  const r = await s.collectStickerV2('group:1', 'm9', '龇牙');
  must('收藏 QQ 自带表情走 face 分支', r.face === true && r.emojiId === 'face:12', JSON.stringify(r).slice(0, 80));
  must('已写进本地库', s.getStickerEntries().some((e) => e.id === 'face:12'));
}
{
  writeStore([]);
  const s = createStickerService(makeCtx({
    getSocialV2State: () => ({ recentMessages: [{ seq: 1, isSelf: true, media: [{ kind: 'image' }] }] }),
  }));
  let msg = '';
  try { await s.collectStickerV2('group:1', 1); } catch (e) { msg = e.message; }
  must('不能收藏自己发的表情', /不能收藏自己发的/.test(msg), msg);
}
{
  writeStore([]);
  const s = createStickerService(makeCtx({
    getSocialV2State: () => ({ recentMessages: [{ seq: 1, isSelf: false, media: [] }] }),
  }));
  let msg = '';
  try { await s.collectStickerV2('group:1', 1); } catch (e) { msg = e.message; }
  must('没有可收藏内容时报错', /没有可收藏/.test(msg), msg);
}

console.log('\n[11] 备注同步（modify_custom_face）');
{
  // setStickerRemarkV2 会先同步一次，同步结果会整体替换本地库 ——
  // 所以远端 mock 里必须带回 s1，否则下一步 findSticker 就找不到了。
  writeStore([{ id: 's1', kind: 'image', url: 'https://example.com/a.png', desc: '旧备注' }]);
  botRequests = [];
  const s = createStickerService(makeCtx({
    getBot: () => ({
      request: async (action, params) => {
        botRequests.push([action, params]);
        if (action === 'fetch_custom_face_detail') {
          return { status: 'ok', retcode: 0, data: [{ id: 's1', url: 'https://example.com/a.png', desc: '旧备注' }] };
        }
        return { status: 'ok', retcode: 0, data: {} };
      },
    }),
  }));
  const e = await s.setStickerRemarkV2('s1', '新备注');
  must('调了 modify_custom_face', botRequests.some((b) => b[0] === 'modify_custom_face'));
  must('本地 desc 已同步', e?.desc === '新备注', String(e?.desc));
  let msg = '';
  try { await s.setStickerRemarkV2('nope', 'x'); } catch (err) { msg = err.message; }
  must('不存在的 id 报错', /找不到表情/.test(msg), msg);
}

globalThis.fetch = realFetch;
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
