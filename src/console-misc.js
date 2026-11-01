// 控制台 · 零碎域路由（白名单 / 安全通知 / 角色页 / 视频分镜 / QQ指令 / 控制台令牌 / 测试发送）。
// 2026-11-01 从 bridge.js 的 startConsoleServer 里搬出来（约 260 行）。
// 约定：返回 true 表示"这个请求我已经处理完了"，false 表示"不归我，继续往下匹配"。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { text } from '@snowluma/sdk';
import { SENSITIVE_RE } from './sensitive.js';

const CTX_KEYS = [
  'readJsonSafe', 'atomicWriteJson', 'atomicWriteText', 'ROOT', 'STATE_DIR',
  'cfg', 'log', 'normalizeOwnerQQ', 'reconcileSessionPolicies',
  'allowed', 'modeAllowed', 'escapeCqText', 'redactKnownTokensOnly',
  // 这三个在 bridge 里的定义晚于本模块初始化（TDZ），必须惰性取
  'getBot', 'getCurrentMode', 'setConsoleToken',
];

export function createConsoleMisc(ctx) {
  for (const k of CTX_KEYS) {
    if (ctx?.[k] === undefined) throw new Error(`createConsoleMisc: ctx 缺少 ${k}`);
  }
  const {
    readJsonSafe, atomicWriteJson, atomicWriteText, ROOT, STATE_DIR,
    cfg, log, normalizeOwnerQQ, reconcileSessionPolicies,
    allowed, modeAllowed, escapeCqText, redactKnownTokensOnly,
    getBot, getCurrentMode, setConsoleToken,
  } = ctx;

  // 纯函数/常量，bridge 里也有一份（voice/video/pcjobs 共用），重复定义无副作用
  const clampNum = (v, min, max) => Math.min(max, Math.max(min, v));
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const MB = 1024 * 1024;
  const CONSOLE_TOKEN_RE = /^[A-Za-z0-9_\/-]+$/;

  /** 返回 true = 已处理；false = 不匹配，交给后面的路由。 */
  return async function handleMiscRoutes(req, res, url, helpers) {
    const { sendJson, readBody, SECURITY_HEADERS } = helpers;

    // ── 白名单：控制台读写（ownerQQ 也在这里改） ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readJsonSafe(configFile, null, true);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return true;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return true;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({ security: cfg.security ?? { interceptNotify: true } });
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return true;
        }

    // ── 语音 / 视频分镜 / QQ 指令：控制台读写（2026-10-30） ────────────────
    // 字段名和单位与启动器面板（launcher/config-ops.mjs）保持一致，
    // 两边读写的是同一份 config.json。
    //
    // ⚠ 生效时机不一样，别混：
    //   voice / video  桥接启动时快照进 tts / storyboard 实例 → 改完要重启
    //   pcJobs         每次判定现读 cfg → 立刻生效
    // 所以下面一律老实返回 needRestart，不假装热更新。

    // 角色管理面板（2026-10-31）：独立页面，和调音台一样直出静态 HTML，令牌在页面内处理。
    if (req.method === 'GET' && (url.pathname === '/roles' || url.pathname === '/roles.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      try {
        res.end(fs.readFileSync(path.join(ROOT, 'public', 'roles.html'), 'utf8'));
      } catch {
        res.end('角色管理页面缺失：qq-bridge/public/roles.html');
      }
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/video') {
      const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
      const v = { ...(onDisk.video ?? {}) };
      sendJson({
        ok: true,
        needRestart: true,
        video: {
          enabled: v.enabled !== false,
          cells: numOr(v.cells, 9),
          maxMB: Math.round((numOr(v.maxBytes, 40 * MB) / MB) * 10) / 10,
          timeoutSec: Math.round(numOr(v.timeoutMs, 150000) / 1000),
          transcript: v.transcript === 'auto' ? 'auto' : 'off',
          keepDays: numOr(v.keepDays, 2),
          maxTextChars: numOr(v.maxTextChars, 4000),
        },
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/video') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const v = { ...(file.video ?? {}) };
      const changed = [];

      if (typeof body.enabled === 'boolean' && (v.enabled !== false) !== body.enabled) {
        v.enabled = body.enabled; changed.push(`enabled=${body.enabled}`);
      }
      if ((body.transcript === 'auto' || body.transcript === 'off')
        && (v.transcript === 'auto' ? 'auto' : 'off') !== body.transcript) {
        v.transcript = body.transcript; changed.push(`transcript=${body.transcript}`);
      }
      // 插件只吃 0/4/6/9 这几种宫格
      if (body.cells !== undefined && body.cells !== null && body.cells !== '') {
        const raw = Math.round(Number(body.cells));
        const cells = [0, 4, 6, 9].includes(raw) ? raw : 9;
        if (numOr(v.cells, 0) !== cells) { v.cells = cells; changed.push(`cells=${cells}`); }
      }

      const setVid = (key, min, max, toStore, label = key) => {
        if (body[key] === undefined || body[key] === null || body[key] === '') return;
        const n = Number(body[key]);
        if (!Number.isFinite(n)) return;
        const next = toStore(clampNum(n, min, max));
        if (Number(v[key]) !== next) { v[key] = next; changed.push(`${label}=${next}`); }
      };
      setVid('maxMB', 1, 200, (n) => Math.round(n * MB));
      setVid('timeoutSec', 20, 600, (n) => Math.round(n) * 1000);
      setVid('keepDays', 1, 30, (n) => Math.round(n));
      setVid('maxTextChars', 500, 20000, (n) => Math.round(n));

      if (!changed.length) {
        sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
        return true;
      }

      file.video = v;
      atomicWriteJson(configFile, file);
      cfg.video = v;
      log(`控制台：视频分镜设置已更新（${changed.join('，')}）—— 重启桥接后生效`);
      sendJson({ ok: true, needRestart: true, changed });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/pcjobs') {
      const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
      const p = onDisk.pcJobs ?? {};
      sendJson({
        ok: true,
        needRestart: false,
        pcJobs: {
          enabled: p.enabled !== false,
          prefix: String(p.prefix ?? '指令'),
          ownerPrivateOnly: p.ownerPrivateOnly !== false,
          cwd: String(p.cwd ?? ''),
          preset: String(p.preset ?? 'standard'),
          ownerQQ: cfg.ownerQQ ? String(cfg.ownerQQ) : null,
        },
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/pcjobs') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const p = { ...(file.pcJobs ?? {}) };
      const changed = [];

      if (typeof body.enabled === 'boolean' && (p.enabled !== false) !== body.enabled) {
        p.enabled = body.enabled; changed.push(`enabled=${body.enabled}`);
      }
      if (typeof body.prefix === 'string') {
        // 前缀不能为空、不能带空白：它是正则的一部分，带空格会切错词
        const next = body.prefix.trim().replace(/\s+/g, '').slice(0, 12);
        if (next && next !== String(p.prefix ?? '指令')) {
          p.prefix = next; changed.push(`prefix=${next}`);
        }
      }

      if (!changed.length) {
        sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
        return true;
      }

      file.pcJobs = p;
      atomicWriteJson(configFile, file);
      cfg.pcJobs = p;
      // pcJobs 是每次判定现读 cfg 的，改完立刻生效，不用重启
      log(`控制台：QQ 指令设置已更新（${changed.join('，')}）—— 立即生效`);
      sendJson({ ok: true, needRestart: false, changed });
      return true;
    }

    // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/console/token') {
      const body = await readBody();
      let newToken = String(body.token ?? '').trim();
      const generated = !newToken;
      if (generated) {
        newToken = crypto.randomBytes(24).toString('hex');
      }
      if (newToken.length < 16) {
        sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
        return true;
      }
      if (newToken.length > 128) {
        sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
        return true;
      }
      if (!CONSOLE_TOKEN_RE.test(newToken)) {
        sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线、短横线或斜杠' }, 400);
        return true;
      }
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
      file.consoleToken = generated ? '' : newToken;
      atomicWriteJson(configFile, file);
      cfg.consoleToken = generated ? '' : newToken;
      atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
      // consoleToken 是 bridge 内的 let，跨模块改不了，必须走 setter
      setConsoleToken(newToken);
      log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
      sendJson({ ok: true, token: newToken, generated });
      return true;
    }

    // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/test-send') {
      const body = await readBody();
      const kind = body.kind === 'private' ? 'private' : 'group';
      const id = Number(body.id);
      const message = String(body.message ?? '').trim();
      if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; }
      if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
      if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
      const currentMode = getCurrentMode();
      if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return true; }
      if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return true; }
      try {
        const bot = getBot();
        const safeMessage = escapeCqText(redactKnownTokensOnly(message));
        const result = kind === 'private'
          ? await bot.sendPrivateMessage(id, text(safeMessage))
          : await bot.sendGroupMessage(id, text(safeMessage));
        log(`控制台：测试发送 ${kind}:${id} 成功`);
        sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
      } catch (error) {
        sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
      }
      return true;
    }

    return false;
  };
}
