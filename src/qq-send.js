// 发送通道：分条发送 / 语音 / 媒体字节解析 / 发送审计与静默闸门。
// 2026-11-01 从 bridge.js 抽出（907 行）。这里只关心"怎么把东西发出去"，
// 业务决策（发什么、发给谁）留在 bridge 和 social 层；状态通过 ctx 注入。
import fs from 'node:fs';
import path from 'node:path';
import { createTts, concatWav } from './tts.js';
import { toSpeakable, hasSpeakableContent } from './tts-text.js';
import { decide, recordSpoken, createVoiceMemory, emotionScore } from './voice-policy.js';
import { resolveTone } from './voice-tone.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { sleep, withTimeout, SEND_TIMEOUT_MS } from './async-utils.js';

const CTX_KEYS = [
  'cfg', 'log', 'ROOT', 'STATE_DIR', 'sendQueue', 'sendToQQ',
  'appendActivity', 'escapeCqText', 'randInt', 'sessionPolicy', 'readRoleState',
  'isSessionAllowedInCurrentMode', 'redactKnownTokensOnly', 'getSocialV2State',
  'getState', 'getMode',
  // 这四个在 bridge 里的定义晚于本模块初始化（TDZ），必须惰性取
  'getBot', 'getVideoStoryboard', 'getMessageMediaStore', 'getSocialV2',
];

/** 缺项立即炸（fail-closed），不要等到发消息时才 undefined。 */
export function createQQSend(ctx) {
  for (const k of CTX_KEYS) {
    if (ctx?.[k] === undefined) throw new Error(`createQQSend: ctx 缺少 ${k}`);
  }
  const {
    cfg, log, ROOT, STATE_DIR, sendQueue, sendToQQ,
    appendActivity, escapeCqText, randInt, sessionPolicy, readRoleState,
    isSessionAllowedInCurrentMode, redactKnownTokensOnly, getSocialV2State,
    getState, getMode,
    getBot, getVideoStoryboard, getMessageMediaStore, getSocialV2,
  } = ctx;
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendQueue.chain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendQueue.chain = sendQueue.chain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(getBot().sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(getBot().sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error));
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendQueue.chain = sendQueue.chain.then(() => sleep(delay));
      }
    }
    return sendQueue.chain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 语音回复（可选） ────────────────────────────────────────────────────
  // 策略在 voice-policy.js（纯函数，好测），引擎在 tts.js（本地 sherpa-onnx / 外部 HTTP）。
  // 这里只做三件事：判定 → 合成 → 发 record 段。任何一步失败都只降级成文字，不静默。
  const voiceCfg = cfg.voice || {};
  const tts = createTts(voiceCfg, { log, rootDir: ROOT });
  // voiceEngine 由 bridge 在 createQQSend() 之后赋值（见 bridge.js 注入处）
  const voiceMemory = createVoiceMemory(path.join(STATE_DIR, 'voice.json'));

  async function sendVoiceRecord(key, wav) {
    const [kind, id] = key.split(':');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params =
      kind === 'private'
        ? { user_id: Number(id), message: [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }] }
        : { group_id: Number(id), message: [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }] };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`语音发送失败：${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  }

  // 先做决策（同步、不发送）。返回 { decision, spoken, replace } 或 null。
  // replace=true 表示「用语音替代文字」：命中后调用方不要再发同样的文字，避免重复。
  function planVoice(key, rawText) {
    if (!voiceCfg.enabled) return null;
    const maxChars = Number(voiceCfg.maxChars) || 60;
    // 原文超长：只发文字、不补语音。
    // toSpeakable 会把长文本截断到 maxChars 再交给 decide，若不先卡原文长度，
    // 长回复会被截成 60 字念出来；一旦 replaceText 命中还会把原文整段吞掉 → 丢内容。
    if (String(rawText ?? '').trim().length > maxChars) return null;
    let spoken;
    try {
      spoken = toSpeakable(rawText, { maxChars });
    } catch (error) {
      log(`语音清洗异常 (${key})：${error?.message ?? error}`);
      return null;
    }
    if (!hasSpeakableContent(spoken)) return null;
    const decision = decide({
      key,
      text: spoken,
      cfg: voiceCfg,
      memory: voiceMemory.data,
      ownerKey: cfg.ownerQQ ? `private:${cfg.ownerQQ}` : ''
    });
    if (!decision.speak) {
      log(`语音跳过 (${key})：${decision.reason}`);
      return null;
    }
    // decide 只在文本 ≤ maxChars 时才 speak（原文已先卡过长），所以替代不会丢内容；
    // replaceText=false 时退回「文字+语音」旧行为。
    const replace = !!voiceCfg.replaceText;
    return { decision, spoken, replace };
  }

  // 这一句按什么音色念。
  // 调音参数（音调/音量/情绪映射）每句现读 cfg.voice —— 所以调音台改完立即生效；
  // 模型目录、引擎仍是启动时的快照，那两样要重启。
  function toneFor(text) {
    const v = cfg.voice ?? voiceCfg;
    return resolveTone({
      tone: v.tone,
      emotion: emotionScore(text),
      baseSpeed: Number(v.local?.speed) || 1,
      baseSid: Number(v.local?.sid) || 0,
    });
  }

  // 真正合成 + 经 OneBot 发语音，挂到 sendQueue.chain 排队；失败只降级、不静默。
  function enqueueVoice(key, plan) {
    const assertSendAllowed = captureSendGuard(key);
    const started = Date.now();
    const timeoutMs = Number(voiceCfg.timeoutMs) || 25000;
    const tone = toneFor(plan.decision.text);

    // 合成是整条语音链里最慢的一步（本地模型/外部 TTS，默认上限 25 秒）。
    // 先让它独立跑，合成完再进全局发送链——否则一次语音会把其他会话的
    // 文本、图片一起堵在 sendQueue.chain 后面，连 DSH 事件消费都会被拖住。
    const preparation = (async () => {
      assertSendAllowed();
      const audio = await tts.synthesize(plan.decision.text, {
        timeoutMs,
        speed: tone.speed,
        sid: tone.sid,
        pitch: tone.pitch,
        gain: tone.gain,
      });

      // 语气词：从词库随机挑一个，跟正文拼成一条语音（间隔留一点气口）。
      // 词条也走同一个 TTS 合成，第二次就命中缓存，不用另存素材文件。
      let wav = audio.wav;
      let clipWord = '';
      const clips = (cfg.voice ?? voiceCfg).tone?.clips;
      if (clips?.on && Array.isArray(clips.list) && clips.list.length && Math.random() < (Number(clips.chance) || 0)) {
        const word = String(clips.list[Math.floor(Math.random() * clips.list.length)] || '').trim();
        if (word) {
          try {
            const clip = await tts.synthesize(word, {
              timeoutMs,
              speed: tone.speed,
              sid: tone.sid,
              pitch: tone.pitch,
              gain: tone.gain,
            });
            wav = concatWav([clip.wav, audio.wav], { gapMs: Number(clips.gapMs) || 90 });
            clipWord = word;
          } catch (error) {
            log(`语气词「${word}」没拼上，只念正文：${error?.message ?? error}`);
          }
        }
      }
      return { wav, audio, clipWord };
    })();

    preparation
      .then(({ wav, audio, clipWord }) => {
        // 只把真正的 OneBot 发送放进发送链，继续复用原有顺序与限频。
        // 发送前重新校验权限：合成期间白名单可能已经被撤销。
        sendQueue.chain = sendQueue.chain
          .then(async () => {
            assertSendAllowed();
            await sendVoiceRecord(key, wav);
            recordSpoken(voiceMemory.data, key);
            voiceMemory.save();
            const isWav = wav === audio.wav ? audio.format === 'wav' : true;
            const dur = isWav ? ((wav.length - 44) / 2 / (audio.sampleRate || 22050)).toFixed(1) : '?';
            log(
              `语音已发 (${key}) ${plan.decision.text.length} 字 / ${dur}s 音频 / 合成 ${Date.now() - started}ms` +
                ` / 档=${tone.band} 音调=${tone.pitch} 语速=${tone.speed.toFixed(2)}` +
                `${clipWord ? `（语气词「${clipWord}」）` : ''}${plan.replace ? '（替代文字）' : ''}`
            );
            appendActivity(`${key} 发了一条语音：${plan.decision.text.slice(0, 40)}`);
          })
          .catch((error) => {
            // 失败必须出声：主人能从日志和控制台活动里看见，而不是"怎么没声音"。
            log(`⚠️ 语音未发出 (${key})：${error?.message ?? error}`);
            appendActivity(`${key} 语音未发出：${String(error?.message ?? error).slice(0, 120)}`);
          });
      })
      .catch((error) => {
        log(`⚠️ 语音未发出 (${key})：${error?.message ?? error}`);
        appendActivity(`${key} 语音未发出：${String(error?.message ?? error).slice(0, 120)}`);
      });
  }

  // 兼容旧行为：文字照发，再追加一条语音（replaceText=false 或无法替代时）。
  function maybeSendVoice(key, rawText) {
    const plan = planVoice(key, rawText);
    if (plan) enqueueVoice(key, plan);
  }

  if (voiceCfg.enabled) tts.warmup();

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // 单条消息图片总字节上限（与 safeFetchBuffer 默认一致）
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await getBot().getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && isSafeLocalMediaPath(obj.file)) {
          try {
            const stat = await fsp.stat(obj.file);
            if (!stat.isFile()) throw new Error('not a regular file');
            if (stat.size > MAX_MEDIA_BYTES) {
              log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
            } else {
              const buf = await fsp.readFile(obj.file);
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } catch {}
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await getBot().fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc} face:${media.faceId}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  // 视频 → 分镜图 + 时间码清单。失败就退化成一行说明，绝不让整条消息丢掉。
  async function resolveVideoParts(media, index) {
    if (!getVideoStoryboard().available()) {
      return { bytes: 0, parts: [{ type: 'text', text: `[视频${index}（这台机器还没装视频分镜，看不到内容）]` }] };
    }
    const url = String(media.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { bytes: 0, parts: [{ type: 'text', text: `[视频${index}（拿不到可下载的地址，看不到内容）]` }] };
    }
    try {
      const result = await getVideoStoryboard().run({ url, tag: media.file || url });
      const parts = [
        { type: 'text', text: `[视频${index}] 下面是按时间顺序的分格清单，每格带起止时间；先读清单，需要细节再对照图片。` },
        { type: 'image', mediaType: 'image/png', data: result.pngBuffer.toString('base64'), name: `qq-video-${index}.png` }
      ];
      if (result.text) parts.push({ type: 'text', text: result.text });
      return { bytes: result.pngBuffer.length, parts };
    } catch (error) {
      log(`视频分镜失败 (${index}): ${error?.message ?? error}`);
      return {
        bytes: 0,
        parts: [{ type: 'text', text: `[视频${index}（解析失败：${String(error?.message ?? error).slice(0, 100)}）]` }]
      };
    }
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    let videoCount = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'video') {
        // 一条消息只解析第一个视频：下载 + 抽帧都是重活，连发三个视频能把回复拖成几分钟。
        videoCount += 1;
        if (videoCount > 1) {
          parts.push({ type: 'text', text: `[视频${index}（单条消息只解析第一个视频，已跳过）]` });
          continue;
        }
        const videoParts = await resolveVideoParts(media, index);
        totalBytes += videoParts.bytes;
        parts.push(...videoParts.parts);
      } else if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-image-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'video') {
        // 视频走分镜：抽宫格图 + 时间码清单。以前这里没有 video 分支，
        // 视频会掉进下面的 else 被当图片抓 → "抓取内容不是有效图片"（2026-10-31 实测）。
        const videoParts = await resolveVideoParts(media, index);
        const imagePart = videoParts.parts.find((p) => p.type === 'image');
        const textPart = videoParts.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        if (imagePart) {
          totalBytes += videoParts.bytes;
          out.push({
            index,
            kind: 'video',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: imagePart.mediaType || 'image/png',
            data: imagePart.data,
            text: textPart
          });
        } else {
          out.push({ index, kind: 'video', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: textPart || '（视频解析失败）' });
        }
      } else if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    // 分开数：视频要明确告诉模型"有视频"，否则它只会当成图片，压根不会调工具。
    const videoCount = mediaList.filter((m) => m && m.kind === 'video').length;
    const otherCount = mediaList.length - videoCount;
    const label = [
      videoCount > 0 ? `${videoCount} 个视频` : '',
      otherCount > 0 ? `${otherCount} 个图片/表情` : ''
    ].filter(Boolean).join('、') || `${mediaList.length} 个媒体`;
    if (getMode() === 'reserved2') {
      return `\n【媒体】本条消息包含 ${label}（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}"（当前会话 key，不要改动）, messageId="${messageRef}"。视频会返回一张宫格分镜图 + 带时间码的清单，先读清单，需要细节再对照图片。`;
    }
    return `\n【媒体】本条消息包含 ${label}（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (getMode() === 'reserved2' || getSocialV2().conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st && Array.isArray(st.recentMessages)) {
          const found = st.recentMessages.find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
          if (found && Array.isArray(found.media)) return found.media;
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = getMessageMediaStore().get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // 替代模式：单段、短的回复直接发语音，不重复发同一句文字
    const plan = planVoice(key, messages.join(''));
    if (plan && plan.replace && messages.length === 1) {
      enqueueVoice(key, plan);
      return sendQueue.chain.then(() => {
        if (failed.length > 0) {
          const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
          err.sent = sent.slice();
          throw err;
        }
        // 语音已经替代了这条文字，必须算作"已发送"。
        // 2026-10-31 实测：以前这里返回空数组 → 模型收到 sent:0/failed:1 →
        // 以为没发出去 → 又调一次 send_message → 用户同时收到语音和文字。
        sent.push(messages[0]);
        sent.voiced = true;
        return sent;
      });
    }
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendQueue.chain = sendQueue.chain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendQueue.chain = sendQueue.chain.then(() => sleep(d));
      }
    }
    return sendQueue.chain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      // 二代仿真（reserved2）里 AI 用工具发消息，不经过 sendToQQ；语音挂在这里才接得上。
      if (sent.length > 0) maybeSendVoice(key, sent.join(''));
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (getMode() === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = getState().sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && getState().sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    const plan = planVoice(key, text);
    if (plan && plan.replace) {
      // 语音替代文字：只发语音，不再发同一句文字（去重）
      enqueueVoice(key, plan);
    } else {
      await sendToQQ(key, text);
      if (plan) enqueueVoice(key, plan);
    }
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次。
  // 四种 QQ 模式共用 DSH 会话，统一使用 cfg.dsh 里配的 provider/model/reasoningEffort。
  // 用 deepseek-flash 是因为它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  // ⚠️ reasoningEffort 直接决定花钱多少：思考链按"输出"计费（¥4/M 空闲、¥8/M 高峰），
  // 而缓存命中的输入只要 ¥0.02/M —— 输出是它的 200 倍。闲聊不需要深度推理，
  // 所以这里配 low；下面的 `|| 'max'` 兜底是"最贵档"，缺配置时请务必显式写清楚。
  // ── 对外暴露面：bridge 主流程 / 控制台 / social 层用到的发送能力 ──
  return {
    singleLineForQQ, splitLongSegment, planSocialTimeline, sendBurstToQQ, onebotSend,
    tts, voiceCfg, voiceMemory, sendVoiceRecord, planVoice, toneFor, enqueueVoice, maybeSendVoice,
    mimeFromBuffer, mimeFromUrl, getImageDimensions,
    MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, MAX_MEDIA_STORE_PER_KEY,
    fetchOneBotImage, resolveMediaList, fetchMediaData, mediaHintFor, findMessageMedia,
    computeGapsV2, sendMessagesV2,
    shouldAuditKey, captureSendGuard, shouldBlockSilentReply, auditAndSend,
  };
}
