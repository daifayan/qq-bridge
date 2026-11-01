// 表情包体系（二代仿真）· 带状态的服务层。
// 2026-11-01 从 bridge.js 的 main 里搬出来（370 行，13 个函数 + 2 个状态）。
//
// 与 src/sticker-lib.js 的分工：lib 是纯函数（findSticker / formatStickerList / markStickerUsed…），
// 这一层持有可变的本地库状态，并替 bridge 跑 OneBot 的收藏/同步/发送。
//
// 状态为什么也搬进来：stickerEntries 会被整体换数组（mergeStickerLibrary 返回新数组），
// 只有持有者自己能维护引用。外部一律走 getStickerEntries() 现取，别缓存。
import { promises as fsp } from 'node:fs';
import { sleep } from './async-utils.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary, normalizeStickerEntry,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
} from './sticker-lib.js';

const CTX_KEYS = [
  'cfg', 'log', 'STICKER_FILE', 'randInt',
  // safeFetchBuffer 也走注入：审计 harness 会用替身覆盖它（globals.safeFetchBuffer），
  // 如果这里直接 import，那份覆盖就失效了 —— 内网/本机地址本来也该由它拦。
  'safeFetchBuffer',
  // fetch 同理：审计 harness 会注入替身截获 OneBot 请求，模块里直接用全局 fetch 会绕过它。
  // 必须惰性取：vm context 默认没有 fetch，只有测试显式传 globals.fetch 时才存在，
  // 构造期就引用会让所有没传 fetch 的测试直接 ReferenceError。
  'getFetch',
  // 这四个在 bridge 里的定义晚于本模块初始化（TDZ），必须惰性取
  'getBot', 'getSendQueue', 'getCaptureSendGuard', 'getFetchOneBotImage',
  'getSocialV2State',
];

export function createStickerService(ctx) {
  for (const k of CTX_KEYS) {
    if (ctx?.[k] === undefined) throw new Error(`createStickerService: ctx 缺少 ${k}`);
  }
  const {
    cfg, log, STICKER_FILE, randInt, safeFetchBuffer, getFetch,
    getBot, getSendQueue, getCaptureSendGuard, getFetchOneBotImage, getSocialV2State,
  } = ctx;

  // ── 状态（外部只读，一律走下面的 getter） ──────────────────────────────
  let stickerEntries = loadStickerStore(STICKER_FILE);
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // ── QQ 自带表情（系统/魔法表情）────────────────────────────────────────────
  // 这类表情（face:358 骰子、face:359 包剪锤…）**不是** QQ 收藏表情：没有图片和 url，
  // 走 `add_custom_face` 收藏必然失败（历史上就是那句"无法获取该表情的图片源"）。
  // 它们唯一的用法是 OneBot 的 face 段直发，所以本地库把它们记成 kind='face' 的条目。
  async function faceDisplayName(faceId) {
    try {
      const face = await getBot().fetchFaceEntity(Number(faceId));
      const name = String(face?.q_des || (Array.isArray(face?.emoji_name_alias) ? face.emoji_name_alias[0] : '') || '')
        .replace(/^\//, '').trim();
      if (name) return name;
    } catch (error) {
      log(`[sticker] 查 QQ 自带表情名失败 face:${faceId}: ${error?.message ?? error}`);
    }
    return '';
  }

  /** 幂等地把 QQ 自带表情记进本地库（同 faceId 只更新备注/名字）。 */
  function upsertFaceSticker({ faceId, desc, tags, source = 'manual' } = {}) {
    const digits = String(faceId ?? '').replace(/[^\d]/g, '');
    if (!digits) return null;
    const id = `face:${digits}`;
    const idx = stickerEntries.findIndex((e) => e && e.kind === 'face' && String(e.faceId) === digits);
    const old = idx >= 0 ? stickerEntries[idx] : null;
    const next = normalizeStickerEntry({
      ...(old || {}),
      kind: 'face',
      faceId: digits,
      id,
      resId: id,
      desc: String(desc || old?.desc || '').trim(),
      tags: Array.isArray(tags) && tags.length ? tags : (old?.tags?.length ? old.tags : ['QQ自带', '表情']),
      source: old?.source || source,
      createdAt: old?.createdAt,
      updatedAt: new Date().toISOString()
    });
    if (!next) return null;
    if (idx >= 0) stickerEntries[idx] = next; else stickerEntries.push(next);
    saveStickerStoreSafe();
    return next;
  }

  // ⚠️ 2026-10-01 实测回退：**不预置、也不允许发** QQ 的"随机结果"表情（骰子 358 / 包剪锤 359）。
  // 网关（SnowLuma 1.14.19）把它们发成 commonElem{serviceType:37, pbElem:QFaceExtra(packId, stickerId, qsid,
  // sourceType=1, stickerType, randomType=1)} —— 但**不带 resultId**（协议里 QFaceExtra.resultId 是字符串字段，
  // 官方客户端的骰子元素里带着结果），于是接收端 QQ 永远停在"正在掷骰子"。
  // 机制保留：非随机的系统表情仍可发；等网关补上 resultId 再把这两个放回来。
  const FACE_SEND_BLOCKED = new Map([
    ['358', '骰子（随机结果表情：网关发出去的元素不带结果字段，对方会一直显示"正在掷骰子"）'],
    ['359', '包剪锤（同上）']
  ]);
  // 启动时清理一次：本地库里可能残留着以前预置的骰子/包剪锤条目。
  {
    const before = stickerEntries.length;
    stickerEntries = stickerEntries.filter((e) => !(e && e.kind === 'face' && FACE_SEND_BLOCKED.has(String(e.faceId))));
    if (stickerEntries.length !== before) {
      saveStickerStoreSafe();
      log(`[sticker] 已移除 ${before - stickerEntries.length} 个不可用的随机结果表情（骰子/包剪锤）`);
    }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await getBot().request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // QQ 自带表情（face:358 骰子…）没有图片也没有 url：看图这条路走不通，但发是能发的。
  // 这里给一句人话，而不是让它去下载一个空 URL 然后报"图片地址不合法"。
  function checkFaceNoImage(entry) {
    if (entry?.kind === 'face') {
      throw new Error(`「${entry.desc || entry.id}」是 QQ 自带表情（id=${entry.id}），没有图片可看；想发它就直接 qq_send_sticker stickerId="${entry.id}"`);
    }
    return entry;
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return checkFaceNoImage(entry2);
    }
    return checkFaceNoImage(entry);
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = getCaptureSendGuard()(key); // captureSendGuard(key) 是工厂，返回 assert 函数
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    // QQ 自带表情（系统/魔法表情，如 face:358 骰子）：走 OneBot 的 face 段，没有图片可下载。
    const isFace = entry.kind === 'face' && /^\d+$/.test(String(entry.faceId || ''));
    if (isFace && FACE_SEND_BLOCKED.has(String(entry.faceId))) {
      throw new Error(`暂时不能发「${entry.desc || entry.id}」：${FACE_SEND_BLOCKED.get(String(entry.faceId))}。想玩骰子就直接发文字（例如"🎲 5"，数字你自己随机一个）`);
    }
    const url = entry.url;
    if (!isFace && !url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    if (isFace) {
      // QQ 自带表情：OneBot 直接收 face 段（QQ 客户端会自己渲染成动画/随机结果），不需要图片字节。
      segments.push({ type: 'face', data: { id: String(entry.faceId) } });
    } else {
      // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
      let image;
      try {
        image = await safeFetchBuffer(url);
      } catch (error) {
        throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
      }
      segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    }
    const data = await postMediaSegments(key, segments, { assertSendAllowed, timeoutMs: 15000 });
    // 更新本地使用统计（bridge 要拿 entry.desc 记 recentMessages，所以必须原样回传 entry）
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 发送一张真实图片（image 段）。只接受已通过 resolveImageFileUnderRoot 校验的文件。
  // 与表情发送共用 sendQueue.chain：保证"先文字后图"的真人顺序不被并发工具调用打乱。
  async function sendImageV2(key, resolved, options = {}) {
    const assertSendAllowed = getCaptureSendGuard()(key); // captureSendGuard(key) 是工厂，返回 assert 函数
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 读图放进发送链里异步做：既不阻塞事件循环，也保持「先文字后图」的队列顺序。
    const absPath = resolved.absPath;
    return postMediaSegments(key, segments, {
      assertSendAllowed,
      timeoutMs: 30000,
      // 真人发表情/发图前都会有一小段停顿（选图/截图），别让文字和图贴得太紧
      beforeSend: async () => {
        const buf = await fsp.readFile(absPath);
        segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
        await sleep(randInt(600, 1600));
      },
    }).then((data) => ({
      file: resolved.relPath, size: resolved.size, messageId: data?.message_id ?? null,
    }));
  }

  // 把拼好的消息段排进 sendQueue 发出去（表情和图片共用这一段）。
  // 为什么必须排队：并发的工具调用会打乱"先文字后图"的真人顺序。
  async function postMediaSegments(key, segments, { assertSendAllowed, timeoutMs, beforeSend } = {}) {
    const [kind, id] = key.split(':');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const sendQueue = getSendQueue();
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendQueue.chain = sendQueue.chain.then(async () => {
      try {
        if (beforeSend) await beforeSend();
        else await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await getFetch()(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    return sendResult;
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await getBot().request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = getCaptureSendGuard()(key); // captureSendGuard(key) 是工厂，返回 assert 函数
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    // QQ 自带表情（骰子/包剪锤这类）：没有图片源，**不能**去调 add_custom_face
    // （那正是以前那句"无法获取该表情的图片源"的来源）。改为直接记进本地表情库，
    // id = face:<数字>，之后 qq_send_sticker 就能把它发出去。
    if (media?.kind === 'face') {
      const faceId = String(media.faceId ?? '').replace(/[^\d]/g, '');
      if (!faceId) throw new Error('这条消息里的表情没有可用的 faceId，收藏不了');
      assertSendAllowed();
      const maxLen = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
      const cleanRemark = String(remark ?? '').trim().slice(0, maxLen);
      const name = cleanRemark || await faceDisplayName(faceId);
      const entry = upsertFaceSticker({ faceId, desc: name || `QQ表情${faceId}`, source: 'ai' });
      return { emojiId: `face:${faceId}`, entry, remark: name || '', face: true };
    }
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await getFetchOneBotImage()(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      // 理论上到不了这里（face 分支已在上面提前返回）；留一句话说明，避免以后误改成"再试一次图片"。
      throw new Error('QQ 自带表情不能收藏成自定义表情（没有图片源）；请走 face 分支');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await getBot().request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await getBot().request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  return {
    // 状态访问器：外部一律现取，别缓存（内部会整体换数组）
    getStickerEntries: () => stickerEntries,
    getStickerSyncedAt: () => stickerSyncedAt,
    stickerEnabled, saveStickerStoreSafe, faceDisplayName, upsertFaceSticker,
    syncStickerLibrary, listStickersForV2, getStickerImageData, checkFaceNoImage,
    sendStickerV2, sendImageV2, applyStickerNoteV2, setStickerRemarkV2, collectStickerV2,
  };
}
