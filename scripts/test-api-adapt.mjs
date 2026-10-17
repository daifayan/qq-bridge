import fs from 'node:fs';
import { createApiAdapter } from '../src/api-adapt.js';

const raw = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

function makeCfg(overrides = {}) {
  return { dsh: { ...raw.dsh, ...overrides } };
}

const logs = [];
const log = (m) => { logs.push(m); console.log('  ' + m); };

(async () => {
  console.log('\n[1] 正常：OFM 在跑 → 应选 ofm');
  {
    const a = createApiAdapter({ cfg: makeCfg(), log });
    const pick = await a.resolve();
    console.log('  => ' + pick.provider + '/' + pick.model);
  }

  console.log('\n[2] OFM 端口写错 → 应自动退回 deepseek-official');
  {
    const cfg = makeCfg({
      autoAdapt: {
        ...raw.dsh.autoAdapt,
        candidates: raw.dsh.autoAdapt.candidates.map((c) =>
          c.probe === 'ofm' ? { ...c, baseURL: 'http://127.0.0.1:19999/v1', probeTimeoutMs: 1500 } : c
        )
      }
    });
    const a = createApiAdapter({ cfg, log });
    const pick = await a.resolve();
    console.log('  => ' + pick.provider + '/' + pick.model);
  }

  console.log('\n[3] 关掉 autoAdapt → 应退回 cfg.dsh.provider/model');
  {
    const cfg = makeCfg({ autoAdapt: { ...raw.dsh.autoAdapt, enabled: false } });
    const a = createApiAdapter({ cfg, log });
    const pick = await a.resolve();
    console.log('  => ' + pick.provider + '/' + pick.model);
  }

  console.log('\n[4] ofm 调用失败 → 冷却后应自动落到 deepseek-official');
  {
    const a = createApiAdapter({ cfg: makeCfg(), log });
    const first = await a.resolve();
    console.log('  first => ' + first.provider + '/' + first.model);
    a.reportFailure(first.provider, first.model);
    const second = await a.resolve();
    console.log('  afterFailure => ' + second.provider + '/' + second.model);
  }

  console.log('\n[5] 状态文件');
  {
    const p = new URL('../state/api-adapt.test.json', import.meta.url);
    const a = createApiAdapter({ cfg: makeCfg(), log, stateFile: p.pathname.replace(/^\//, '') });
    await a.resolve();
    try { console.log('  ' + fs.readFileSync(p, 'utf8').replace(/\n/g, ' ')); } catch (e) { console.log('  无状态文件'); }
    try { fs.unlinkSync(p); } catch {}
  }
})();
