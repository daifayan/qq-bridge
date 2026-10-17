// API 自动适配（2026-10-17）
//
// 目的：让 QQ 机器人的"聊天大脑"能按候选顺序自动挑一个可用的 provider/model，
// 而不是死死锁在 config.dsh.provider 上。典型场景：优先用本机 Our Free Model（OFM）
// 的免费模型，OFM 没起来 / 没密钥 / 探测失败时自动退回官方 DeepSeek。
//
// 配置（config.json 的 dsh.autoAdapt）：
//   {
//     "enabled": true,
//     "probeIntervalMs": 300000,        // 选中结果的缓存时长；到期重新探测
//     "candidates": [
//       { "provider": "ofm", "model": "z-ai/glm-5.3", "reasoningEffort": "low",
//         "probe": "ofm", "baseURL": "http://127.0.0.1:18900/v1" },
//       { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low" }
//     ]
//   }
//
// probe 取值：
//   "ofm"  —— GET {baseURL}/models（带 Bearer OFM_API_KEY），2xx 视为可用
//   "none" / 省略 —— 不做探测，直接视为可用（适合官方 DeepSeek 这类"相信它在"的兜底项）
//
// OFM_API_KEY 的读取顺序：环境变量 → $DSH_HOME/.credentials.yaml（默认 ~/.dsh）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 300000;
const DEFAULT_COOLDOWN_MS = 600000;

function readOfmKey() {
  if (process.env.OFM_API_KEY) return process.env.OFM_API_KEY;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, '.credentials.yaml');
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m =
      txt.match(/^\s*OFM_API_KEY:\s*"([^"]+)"/m) ||
      txt.match(/^\s*OFM_API_KEY:\s*'([^']+)'/m) ||
      txt.match(/^\s*OFM_API_KEY:\s*([^\s#]+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function httpGetJson(url, { headers = {}, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = http.get(url, { headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 400000) req.destroy();
        });
        res.on('end', () =>
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body })
        );
      });
    } catch (error) {
      finish({ ok: false, error: error?.message ?? String(error) });
      return;
    }
    req.on('error', (error) => finish({ ok: false, error: error?.message ?? String(error) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ ok: false, error: `timeout ${timeoutMs}ms` });
    });
  });
}

function normalizeCandidates(auto) {
  const list = Array.isArray(auto?.candidates) ? auto.candidates : [];
  const cleaned = list
    .filter((c) => c && typeof c === 'object' && c.provider && c.model)
    .map((c) => ({
      provider: String(c.provider),
      model: String(c.model),
      reasoningEffort: c.reasoningEffort ? String(c.reasoningEffort) : undefined,
      probe: c.probe ? String(c.probe) : 'none',
      baseURL: c.baseURL ? String(c.baseURL) : undefined,
      apiKey: c.apiKey ? String(c.apiKey) : undefined,
      probeTimeoutMs: Number(c.probeTimeoutMs) > 0 ? Number(c.probeTimeoutMs) : DEFAULT_PROBE_TIMEOUT_MS
    }));
  return cleaned;
}

/**
 * 创建自动适配器。
 * @param {object} options
 * @param {object} options.cfg       完整的桥接配置（读 cfg.dsh）
 * @param {Function} [options.log]   日志函数
 * @param {string} [options.stateFile] 选中结果落盘路径（可选）
 * @param {Function} [options.fallbackProvider] 无候选时的兜底（返回 {provider, model, reasoningEffort}）
 */
export function createApiAdapter({ cfg, log = () => {}, stateFile = null, fallbackProvider = null }) {
  const auto = cfg?.dsh?.autoAdapt ?? {};
  const enabled = auto.enabled !== false && Array.isArray(auto.candidates) && auto.candidates.length > 0;
  const ttl = Number(auto.probeIntervalMs) > 0 ? Number(auto.probeIntervalMs) : DEFAULT_TTL_MS;
  const cooldown = Number(auto.failureCooldownMs) > 0 ? Number(auto.failureCooldownMs) : DEFAULT_COOLDOWN_MS;
  const candidates = normalizeCandidates(auto);

  let chosen = null;
  let chosenAt = 0;
  let inflight = null;
  const badUntil = new Map(); // "provider/model" -> timestamp

  function baseFallback() {
    if (typeof fallbackProvider === 'function') {
      const f = fallbackProvider();
      if (f && f.provider && f.model) return f;
    }
    return {
      provider: String(cfg?.dsh?.provider || 'deepseek-official'),
      model: String(cfg?.dsh?.model || 'deepseek-flash'),
      reasoningEffort: cfg?.dsh?.reasoningEffort ? String(cfg.dsh.reasoningEffort) : undefined
    };
  }

  function persist() {
    if (!stateFile || !chosen) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ chosen, at: new Date(chosenAt).toISOString(), candidates: candidates.map((c) => `${c.provider}/${c.model}`) }, null, 2)
      );
    } catch (error) {
      log(`[api-adapt] 写状态失败：${error?.message ?? error}`);
    }
  }

  async function probeCandidate(c) {
    if (c.probe === 'ofm') {
      const key = c.apiKey || readOfmKey();
      if (!key) return { ok: false, error: '缺少 OFM_API_KEY（环境变量与 .credentials.yaml 都没有）' };
      const base = String(c.baseURL || 'http://127.0.0.1:18900/v1').replace(/\/+$/, '');
      const r = await httpGetJson(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: c.probeTimeoutMs
      });
      if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
      return { ok: true };
    }
    return { ok: true };
  }

  async function doResolve() {
    const now = Date.now();
    for (const c of candidates) {
      const key = `${c.provider}/${c.model}`;
      const until = badUntil.get(key) ?? 0;
      if (until > now) {
        log(`[api-adapt] 跳过 ${key}：${Math.ceil((until - now) / 1000)}s 冷却中（上次调用失败）`);
        continue;
      }
      const p = await probeCandidate(c);
      if (p.ok) {
        chosen = { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort };
        chosenAt = Date.now();
        log(`[api-adapt] 选用 ${c.provider}/${c.model}`);
        persist();
        return chosen;
      }
      log(`[api-adapt] 跳过 ${c.provider}/${c.model}：${p.error}`);
    }
    const fb = baseFallback();
    chosen = fb;
    chosenAt = Date.now();
    log(`[api-adapt] 全部候选不可用，兜底 ${fb.provider}/${fb.model}`);
    persist();
    return chosen;
  }

  return {
    enabled,
    candidates: candidates.map((c) => `${c.provider}/${c.model}`),

    /** 取当前应使用的模型；缓存到期或强制时重新探测。 */
    async resolve({ force = false } = {}) {
      if (!enabled) return baseFallback();
      if (!force && chosen && Date.now() - chosenAt < ttl) return chosen;
      if (inflight) return inflight;
      inflight = doResolve().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    /** 某次调用失败后调用：给这个候选上冷却，下一次 resolve 会自动落到下一个候选。 */
    reportFailure(provider, model) {
      if (!enabled || !provider || !model) return;
      const key = `${provider}/${model}`;
      badUntil.set(key, Date.now() + cooldown);
      log(`[api-adapt] ${key} 调用失败，冷却 ${Math.round(cooldown / 1000)}s 后重试`);
      if (chosen && chosen.provider === provider && chosen.model === model) {
        chosen = null;
        chosenAt = 0;
      }
    },

    /** 当前选择（可能为 null）。 */
    get current() {
      return chosen;
    }
  };
}
