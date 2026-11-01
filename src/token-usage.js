// Token 用量账本（按天）+ DeepSeek 价目表折算。
//
// 数据来源：DSH `session/list` 的 `item.projections.values.tokenUsage`
// （字段 uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens）。
// 这是**整条会话日志的累计值**，所以每次采集都要和上次的快照做差，只把增量记到当天；
// 会话被重置/压缩导致累计值变小时，subBuckets 会夹到 0，不会记出负账。
//
// 为什么不用桥接自己累加：DSH 的 tokenUsage 是权威投影，桥接侧只记调用次数（tool-calls.jsonl），
// 两者口径不同（2026-11-01 从阿深的 token-ledger 学到这一点，但这里只做轻量版，不搬他那套 958 行基线机）。
import fs from 'node:fs';
import path from 'node:path';
import {
  resolvePriceTable, normalizeUsage, addBuckets, subBuckets, priceUsage, totalTokensOf, ZERO_BUCKETS,
} from './model-prices.js';

const FILE_NAME = 'token-usage.json';
const KEEP_DAYS = 120;

function todayKey(atMs = Date.now()) {
  // 用北京时间切日，避免 UTC 跨天把账记到昨天
  const d = new Date(Number(atMs) + 8 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function emptyDay() {
  return { buckets: { ...ZERO_BUCKETS }, byModel: {} };
}

export function createTokenUsage({ cfg, log, api, unwrap, STATE_DIR }) {
  const file = path.join(STATE_DIR, FILE_NAME);
  const table = resolvePriceTable(cfg?.pricing);
  let store = { version: 1, cursor: {}, days: {}, updatedAt: 0, lastError: '' };
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object' && loaded.cursor && loaded.days) store = { ...store, ...loaded };
  } catch { /* 第一次跑，没有账本 */ }

  let saving = false;
  function save() {
    if (saving) return;
    saving = true;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      log?.('token 账本写入失败: ' + (error?.message ?? error));
    } finally {
      saving = false;
    }
  }

  function prune() {
    const keys = Object.keys(store.days).sort();
    const cutoff = todayKey(Date.now() - KEEP_DAYS * 86400_000);
    for (const k of keys) if (k < cutoff) delete store.days[k];
  }

  function modelName() {
    // autoAdapt 选中什么就用什么；拿不到就退回静态配置
    try {
      const adapt = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'api-adapt.json'), 'utf8'));
      const picked = String(adapt?.current?.model ?? adapt?.model ?? adapt?.picked?.model ?? '');
      if (picked) return picked;
    } catch { /* 没跑过 autoAdapt */ }
    return String(cfg?.dsh?.model ?? 'deepseek-flash');
  }

  /** 采集一次：只记增量。返回本次新增的桶（没变化时全 0）。 */
  async function collect() {
    const list = unwrap(await api.sessions.list({}), 'session.list');
    const items = Array.isArray(list?.items) ? list.items : [];
    const model = modelName();
    const at = Date.now();
    const day = todayKey(at);
    let delta = { ...ZERO_BUCKETS };

    for (const item of items) {
      const sid = String(item?.sessionId ?? '');
      const usage = item?.projections?.values?.tokenUsage;
      if (!sid || !usage) continue;
      const now = normalizeUsage(usage);
      const prev = store.cursor[sid];
      // 第一次见到这个会话：只建基线，不记账。
      // 否则上线第一轮会把 158 个会话的历史累计全算进"今天"，直接出一笔假账（2026-11-01 测试时发现）。
      if (!prev) {
        store.cursor[sid] = now;
        continue;
      }
      const inc = subBuckets(now, prev);
      store.cursor[sid] = now;
      if (totalTokensOf(inc) > 0) delta = addBuckets(delta, inc);
    }

    if (totalTokensOf(delta) > 0) {
      const d = store.days[day] ?? emptyDay();
      d.buckets = addBuckets(d.buckets, delta);
      d.byModel[model] = addBuckets(d.byModel[model] ?? ZERO_BUCKETS, delta);
      store.days[day] = d;
    }
    store.updatedAt = at;
    store.lastError = '';
    prune();
    save();
    return delta;
  }

  /** 汇总：today / 最近 n 天 / 全部；金额按当天内的模型价目算。 */
  function summary(days = 7) {
    const keys = Object.keys(store.days).sort();
    const today = todayKey();
    const recent = keys.slice(-Math.max(1, days));

    const priceDay = (key) => {
      const d = store.days[key];
      if (!d) return { cost: 0, estimated: false };
      let cost = 0;
      let estimated = false;
      const at = new Date(`${key}T12:00:00+08:00`).getTime();
      for (const [model, buckets] of Object.entries(d.byModel ?? {})) {
        const r = priceUsage(buckets, { model, at, table });
        cost += r.cost.total;
        if (r.rates?.estimated) estimated = true;
      }
      if (!Object.keys(d.byModel ?? {}).length) {
        const r = priceUsage(d.buckets, { model: modelName(), at, table });
        cost += r.cost.total;
        estimated = Boolean(r.rates?.estimated);
      }
      return { cost, estimated };
    };

    const dayRows = recent.map((key) => {
      const d = store.days[key];
      const { cost, estimated } = priceDay(key);
      return {
        date: key,
        tokens: totalTokensOf(d?.buckets),
        buckets: d?.buckets ?? { ...ZERO_BUCKETS },
        cost: Number(cost.toFixed(4)),
        estimated,
      };
    });

    const totalCost = dayRows.reduce((s, r) => s + r.cost, 0);
    return {
      ok: true,
      today: dayRows.find((r) => r.date === today) ?? { date: today, tokens: 0, cost: 0, buckets: { ...ZERO_BUCKETS }, estimated: false },
      days: dayRows,
      rangeCost: Number(totalCost.toFixed(4)),
      rangeTokens: dayRows.reduce((s, r) => s + r.tokens, 0),
      priceVersion: table.version,
      currency: 'CNY',
      updatedAt: store.updatedAt,
      trackedSessions: Object.keys(store.cursor).length,
      lastError: store.lastError || '',
    };
  }

  return { collect, summary, _store: () => store };
}
