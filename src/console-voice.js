// 控制台 · 语音域路由（/api/voice、/api/voice/lab、/voice-lab 页面）。
// 2026-11-01 从 bridge.js 的 startConsoleServer 里搬出来（250 行）。
// 约定：返回 true 表示"这个请求我已经处理完了"，false 表示"不归我，继续往下匹配"。
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeTone, DEFAULT_TONE } from './voice-tone.js';

const CTX_KEYS = ['readJsonSafe', 'atomicWriteJson', 'ROOT', 'cfg', 'log', 'getVoiceEngine'];

export function createConsoleVoice(ctx) {
  for (const k of CTX_KEYS) {
    if (ctx?.[k] === undefined) throw new Error(`createConsoleVoice: ctx 缺少 ${k}`);
  }
  const { readJsonSafe, atomicWriteJson, ROOT, cfg, log, getVoiceEngine } = ctx;

  // 纯函数，bridge 里也有一份（video/pcjobs 共用），重复定义无副作用
  const clampNum = (v, min, max) => Math.min(max, Math.max(min, v));
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const MB = 1024 * 1024;

  /** 返回 true = 已处理；false = 不匹配，交给后面的路由。 */
  return async function handleVoiceRoutes(req, res, url, helpers) {
    const { sendJson, readBody, SECURITY_HEADERS } = helpers;
        if (req.method === 'GET' && url.pathname === '/api/voice') {
          // 读磁盘而不是内存 cfg：手动改过 config.json 之后，面板要显示文件里的真值，
          // 否则「文件改了、面板还显示旧值」会误导人（2026-10-30）。
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const v = { ...(onDisk.voice ?? {}) };
          const local = v.local ?? {};
          sendJson({
            ok: true,
            needRestart: true,
            voice: {
              enabled: !!v.enabled,
              replaceText: v.replaceText !== false,
              scope: ['owner', 'private', 'off'].includes(v.scope) ? v.scope : 'private',
              maxChars: numOr(v.maxChars, 60),
              minChars: numOr(v.minChars, 2),
              probability: numOr(v.probability, 0.35),
              emotionBoost: numOr(v.emotionBoost, 0.35),
              cooldownSec: Math.round(numOr(v.cooldownMs, 120000) / 1000),
              hourlyCapPerConv: numOr(v.hourlyCapPerConv, 4),
              dailyCap: numOr(v.dailyCap, 40),
              quietHours: Array.isArray(v.quietHours) && v.quietHours.length === 2
                ? [numOr(v.quietHours[0], 23), numOr(v.quietHours[1], 8)]
                : null,
              speed: numOr(local.speed, 1),
              sid: numOr(local.sid, 0),
              modelDir: String(local.modelDir ?? ''),
            },
          });
          return true;
        }

        if (req.method === 'POST' && url.pathname === '/api/voice') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const v = { ...(file.voice ?? {}) };
          const local = { ...(v.local ?? {}) };
          const changed = [];

          if (typeof body.enabled === 'boolean' && !!v.enabled !== body.enabled) {
            v.enabled = body.enabled; changed.push(`enabled=${body.enabled}`);
          }
          if (typeof body.replaceText === 'boolean' && (v.replaceText !== false) !== body.replaceText) {
            v.replaceText = body.replaceText; changed.push(`replaceText=${body.replaceText}`);
          }
          if (['owner', 'private', 'off'].includes(body.scope) && v.scope !== body.scope) {
            v.scope = body.scope; changed.push(`scope=${body.scope}`);
          }

          const setNum = (key, min, max, toStore = (n) => n, cur = v[key]) => {
            if (body[key] === undefined || body[key] === null || body[key] === '') return;
            const n = Number(body[key]);
            if (!Number.isFinite(n)) return;
            const next = toStore(clampNum(n, min, max));
            if (Number(cur) !== next) { v[key] = next; changed.push(`${key}=${next}`); }
          };
          setNum('maxChars', 10, 300);
          setNum('minChars', 1, 20);
          setNum('probability', 0, 1);
          setNum('emotionBoost', 0, 1);
          setNum('hourlyCapPerConv', 1, 50);
          setNum('dailyCap', 1, 500);
          setNum('cooldownSec', 10, 3600, (n) => Math.round(n) * 1000, numOr(v.cooldownMs, 120000) / 1000);

          if (body.quietHours === null || body.quietHours === false) {
            if (v.quietHours !== null) { v.quietHours = null; changed.push('quietHours=关闭'); }
          } else if (Array.isArray(body.quietHours) && body.quietHours.length === 2) {
            const s = clampNum(Math.round(numOr(body.quietHours[0], 23)), 0, 23);
            const e = clampNum(Math.round(numOr(body.quietHours[1], 8)), 0, 23);
            if (s === e) {
              if (v.quietHours !== null) { v.quietHours = null; changed.push('quietHours=关闭'); }
            } else if (!v.quietHours || v.quietHours[0] !== s || v.quietHours[1] !== e) {
              v.quietHours = [s, e]; changed.push(`quietHours=${s}-${e}`);
            }
          }

          if (body.speed !== undefined && body.speed !== null && body.speed !== '') {
            const sp = clampNum(numOr(body.speed, 1), 0.5, 2);
            if (numOr(local.speed, 1) !== sp) { local.speed = sp; changed.push(`speed=${sp}`); }
          }
          if (body.sid !== undefined && body.sid !== null && body.sid !== '') {
            const sid = clampNum(Math.round(numOr(body.sid, 0)), 0, 99);
            if (numOr(local.sid, 0) !== sid) { local.sid = sid; changed.push(`sid=${sid}`); }
          }

          if (!changed.length) {
            sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
            return true;
          }

          v.local = local;
          file.voice = v;
          atomicWriteJson(configFile, file);
          cfg.voice = v;
          log(`控制台：语音设置已更新（${changed.join('，')}）—— 重启桥接后生效`);
          sendJson({ ok: true, needRestart: true, changed });
          return true;
        }

        // ── 语音调音台（2026-10-31） ──────────────────────────────────────────
        // 和 /api/voice 的分工：
        //   /api/voice      发不发、频率、上限 —— 桥接启动时快照，改完要重启
        //   /api/voice/lab  音调、音量、情绪映射、语气词 —— 每句现读 cfg，改完立即生效
        // 所以这里返回 needRestart:false 是老实话，不是假装热更新。
        const readTone = (raw) => {
          const t = raw ?? {};
          const d = DEFAULT_TONE;
          return sanitizeTone({
            enabled: t.enabled !== false,
            pitch: numOr(t.pitch, d.pitch),
            gain: numOr(t.gain, d.gain),
            emotion: {
              on: t.emotion?.on !== false,
              calm: t.emotion?.calm ?? d.emotion.calm,
              normal: t.emotion?.normal ?? d.emotion.normal,
              soft: t.emotion?.soft ?? d.emotion.soft
            },
            clips: t.clips ?? d.clips
          });
        };

        if (req.method === 'GET' && url.pathname === '/api/voice/lab') {
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const v = onDisk.voice ?? {};
          const local = v.local ?? {};
          sendJson({
            ok: true,
            needRestart: false,
            engine: String(v.engine || 'local'),
            modelDir: String(local.modelDir ?? ''),
            speed: numOr(local.speed, 1),
            sid: numOr(local.sid, 0),
            sampleRate: getVoiceEngine()?.info?.sampleRate || 0,
            numSpeakers: getVoiceEngine()?.info?.numSpeakers || 1,
            tone: readTone(v.tone),
          });
          return true;
        }

        if (req.method === 'POST' && url.pathname === '/api/voice/lab') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const v = { ...(file.voice ?? {}) };
          const local = { ...(v.local ?? {}) };
          const changed = [];

          if (body.speed !== undefined && body.speed !== null && body.speed !== '') {
            const sp = clampNum(numOr(body.speed, 1), 0.5, 2);
            if (numOr(local.speed, 1) !== sp) { local.speed = sp; changed.push(`语速=${sp}`); }
          }
          if (body.sid !== undefined && body.sid !== null && body.sid !== '') {
            const sid = clampNum(Math.round(numOr(body.sid, 0)), 0, 99);
            if (numOr(local.sid, 0) !== sid) { local.sid = sid; changed.push(`音色=${sid}`); }
          }

          const nextTone = readTone({ ...(v.tone ?? {}), ...(body.tone ?? {}) });
          const before = JSON.stringify(readTone(v.tone));
          if (JSON.stringify(nextTone) !== before) changed.push('调音参数');

          if (!changed.length) {
            sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
            return true;
          }

          v.local = local;
          v.tone = nextTone;
          file.voice = v;
          atomicWriteJson(configFile, file);
          // 运行中的桥接也立刻拿到新值（合成时每句现读 cfg.voice）
          cfg.voice = { ...(cfg.voice ?? {}), local, tone: nextTone };
          log(`控制台：调音台已更新（${changed.join('，')}）—— 立即生效`);
          sendJson({ ok: true, needRestart: false, changed, tone: nextTone, speed: numOr(local.speed, 1), sid: numOr(local.sid, 0) });
          return true;
        }

        if (req.method === 'POST' && url.pathname === '/api/voice/lab/preview') {
          const body = await readBody();
          const engine = getVoiceEngine();
          if (!engine) {
            sendJson({ ok: false, error: '语音引擎还没初始化（桥接刚启动？稍等几秒再试）' }, 503);
            return true;
          }
          let text;
          try {
            text = toSpeakable(String(body.text ?? ''), { maxChars: 200 });
          } catch (error) {
            sendJson({ ok: false, error: `文本清洗失败：${error?.message ?? error}` }, 400);
            return true;
          }
          if (!text || !hasSpeakableContent(text)) {
            sendJson({ ok: false, error: '这段文字没有可念的内容' }, 400);
            return true;
          }
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const local = (onDisk.voice ?? {}).local ?? {};
          const tone = resolveTone({
            tone: readTone(body.tone),
            emotion: emotionScore(text),
            baseSpeed: numOr(body.speed, numOr(local.speed, 1)),
            baseSid: numOr(body.sid, numOr(local.sid, 0)),
          });
          try {
            const audio = await engine.synthesize(text, {
              timeoutMs: 30000,
              speed: tone.speed,
              sid: tone.sid,
              pitch: tone.pitch,
              gain: tone.gain,
            });
            const dur = audio.format === 'wav' ? (audio.wav.length - 44) / 2 / (audio.sampleRate || 22050) : 0;
            res.writeHead(200, {
              'content-type': 'audio/wav',
              'content-length': audio.wav.length,
              'cache-control': 'no-store',
              'x-tone-band': tone.band,
              'x-tone-pitch': String(tone.pitch),
              'x-tone-speed': tone.speed.toFixed(3),
              'x-tone-gain': tone.gain.toFixed(3),
              'x-audio-sec': dur.toFixed(2),
              'x-audio-ms': String(audio.ms || 0),
              ...SECURITY_HEADERS,
            });
            res.end(audio.wav);
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return true;
        }

        if (req.method === 'GET' && url.pathname === '/voice-lab') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'voice-lab.html'), 'utf8'));
          } catch {
            res.end('调音台页面缺失：qq-bridge/public/voice-lab.html');
          }
          return true;
        }
    return false;
  };
}
