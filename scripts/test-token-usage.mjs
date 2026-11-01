// token 账本离线回归：不连 DSH，用假 session/list 验证增量记账与计价。
// 计价基准：deepseek-flash 空闲时段（周日跑测试即空闲）= cacheMiss 1 元/百万、cacheHit 0.02、output 4。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenUsage } from '../src/token-usage.js';

let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-'));
const unwrap = (x) => x;
let usage = { uncachedInputTokens: 0 };   // 从 0 开始：首次采集只建基线
const api = {
  sessions: {
    list: async () => ({
      items: [{ sessionId: 's1', projections: { values: { tokenUsage: usage } } }],
    }),
  },
};

const tu = createTokenUsage({
  cfg: { dsh: { model: 'deepseek-flash' } },
  log: () => {},
  api,
  unwrap,
  STATE_DIR: tmp,
});

console.log('\n[1] 首次采集：只建基线，不记账（防止把历史累计算进今天）');
await tu.collect();
let s = tu.summary(7);
must('首次不记账', s.today.cost === 0, String(s.today.cost));
must('币种 CNY', s.currency === 'CNY');

console.log('\n[1b] 用量涨到 1M → 记 1 元（空闲时段）');
usage = { uncachedInputTokens: 1_000_000 };
await tu.collect();
s = tu.summary(7);
must('今日 token 1M', s.today.tokens === 1_000_000, String(s.today.tokens));
must('金额 1 元', Math.abs(s.today.cost - 1) < 1e-6, String(s.today.cost));

console.log('\n[2] 再采集一次（用量没变）→ 不重复记账');
await tu.collect();
s = tu.summary(7);
must('仍是 1 元', Math.abs(s.today.cost - 1) < 1e-6, String(s.today.cost));

console.log('\n[3] 用量涨到 1.5M → 只记 0.5M 增量（+0.5 元）');
usage = { uncachedInputTokens: 1_500_000 };
await tu.collect();
s = tu.summary(7);
must('累计 1.5M token', s.today.tokens === 1_500_000, String(s.today.tokens));
must('金额 1.5 元', Math.abs(s.today.cost - 1.5) < 1e-6, String(s.today.cost));

console.log('\n[4] 会话被重置（累计值变小）→ 不记负账');
usage = { uncachedInputTokens: 200_000 };
await tu.collect();
s = tu.summary(7);
must('金额不倒退（仍 ≥1.5）', s.today.cost >= 1.5 - 1e-9, String(s.today.cost));
must('token 数不倒退', s.today.tokens >= 1_500_000, String(s.today.tokens));

console.log('\n[5] 输出桶计价：1M output → 4 元/百万');
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage2-'));
const api2 = {
  sessions: {
    list: async () => ({ items: [{ sessionId: 's2', projections: { values: { tokenUsage: { outputTokens: 1_000_000 } } } }] }),
  },
};
const tu2 = createTokenUsage({ cfg: { dsh: { model: 'deepseek-flash' } }, log: () => {}, api: api2, unwrap, STATE_DIR: tmp2 });
await tu2.collect();   // 首次只建基线
let s2 = tu2.summary(7);
must('output 首次不记账', s2.today.cost === 0, String(s2.today.cost));
api2.sessions.list = async () => ({ items: [{ sessionId: 's2', projections: { values: { tokenUsage: { outputTokens: 2_000_000 } } } }] });
await tu2.collect();   // 涨到 2M → 记 2M output
s2 = tu2.summary(7);
must('output 增量 1M = 4 元', Math.abs(s2.today.cost - 4) < 1e-6, String(s2.today.cost));

console.log('\n[6] 持久化：重新加载后账本还在');
const tu3 = createTokenUsage({ cfg: { dsh: { model: 'deepseek-flash' } }, log: () => {}, api: api2, unwrap, STATE_DIR: tmp2 });
must('重启后今日金额不丢', Math.abs(tu3.summary(7).today.cost - 4) < 1e-6, String(tu3.summary(7).today.cost));

for (const d of [tmp, tmp2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
