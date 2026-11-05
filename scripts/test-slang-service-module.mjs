// src/slang-service.js 的离线回归：不读真实 config、不连 DSH、不发消息。
// 盯四件事：注入缺项、共享容器语义、路由的"已处理/放行"约定（return true/false）、
// 以及限频与窗口这些容易静默坏掉的策略。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlangService } from '../src/slang-service.js';

const noop = () => {};
let failed = 0;
const must = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-'));
const STATE_DIR = path.join(ROOT, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
fs.writeFileSync(SLANG_FILE, JSON.stringify([]));
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ slang: {} }));

const logs = [];
function makeCtx(over = {}) {
  return {
    cfg: { slang: { enabled: true, injectMax: 8 } },
    log: (...a) => logs.push(a.join(' ')),
    STATE_DIR, SLANG_FILE, SLANG_SESSION_FILE, ROOT,
    readJsonSafe: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
    atomicWriteJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v)),
    atomicWriteText: noop,
    unwrap: (v) => v,
    ensureChatModel: async () => {},
    resolvePresetName: () => 'standard',
    getDshReady: () => false,
    getApi: () => ({ events: { follow: noop }, workspace: {}, sessions: {} }),
    ...over,
  };
}

console.log('\n[1] 依赖注入缺项 → 立刻抛（fail-closed）');
for (const k of ['cfg', 'log', 'STATE_DIR', 'SLANG_FILE', 'SLANG_SESSION_FILE', 'ROOT',
  'readJsonSafe', 'atomicWriteJson', 'atomicWriteText', 'unwrap',
  'ensureChatModel', 'resolvePresetName', 'getDshReady', 'getApi']) {
  let threw = '';
  try { createSlangService({ ...makeCtx(), [k]: undefined }); } catch (e) { threw = e.message; }
  must(`缺 ${k} 时抛错`, /ctx 缺少/.test(threw), threw);
}

console.log('\n[2] 暴露面');
const s0 = createSlangService(makeCtx());
for (const k of ['handleSlangRoutes', 'getSlangEntries', 'getSlangLearnerSessionId',
  'slangWindows', 'slangSubmitTimes', 'slangExtractionCooldowns', 'slangResearchingIds',
  'learnerSessions', 'learnerCollectors', 'learnerWaiters',
  'saveSlangStore', 'queueSlangTask', 'ensureSlangLearnerSession', 'invalidateSlangLearnerSession',
  'waitLearnerTurn', 'runSlangExtraction', 'runSlangResearch', 'maybeQueueSlangExtraction',
  'feedSlangWindow', 'allowSlangSubmit', 'publicSlangEntry', 'confirmedSlangListV2', 'withSlangContext']) {
  must(`${k} 已导出`, s0[k] !== undefined);
}
must('slangWindows 是 Map 实例（外部要共享）', s0.slangWindows instanceof Map);
must('learnerSessions 是 Set 实例', s0.learnerSessions instanceof Set);

// 路由调用辅助
function makeHelpers(body = null) {
  let json = null, status = 200;
  return {
    helpers: {
      sendJson: (o, st = 200) => { json = o; status = st; },
      readBody: async () => body ?? {},
    },
    get: () => ({ json, status }),
  };
}
async function call(svc, method, pathname, body = null) {
  const h = makeHelpers(body);
  const url = new URL('http://127.0.0.1:3100' + pathname);
  const handled = await svc.handleSlangRoutes({ method }, {}, url, h.helpers);
  return { handled, ...h.get() };
}

console.log('\n[3] 路由约定：命中必须 return true，不命中必须 return false');
{
  const s = createSlangService(makeCtx());
  const hits = [
    ['GET', '/api/slang'], ['POST', '/api/slang'], ['POST', '/api/slang/clear'],
    ['POST', '/api/slang/batch-delete'], ['POST', '/api/slang/batch-confirm'],
    ['POST', '/api/slang/batch-reject'], ['POST', '/api/slang/extract'],
    ['POST', '/api/slang/research'], ['POST', '/api/slang/config'],
    ['PATCH', '/api/slang/x1'], ['POST', '/api/slang/x1/confirm'], ['POST', '/api/slang/x1/reject'],
    ['DELETE', '/api/slang/x1'],
  ];
  for (const [m, p] of hits) {
    const r = await call(s, m, p, { ids: [], status: '' });
    must(`${m} ${p} 已接管`, r.handled === true);
  }
  for (const [m, p] of [['GET', '/api/slangx'], ['GET', '/api/roles'], ['POST', '/api/social/state'], ['GET', '/']]) {
    const r = await call(s, m, p);
    must(`${m} ${p} 放行`, r.handled === false);
  }
}

console.log('\n[4] 增删改查：状态与落盘');
{
  fs.writeFileSync(SLANG_FILE, JSON.stringify([]));
  const s = createSlangService(makeCtx());
  // 新增
  const add = await call(s, 'POST', '/api/slang', { content: '蚌埠住了', meaning: '绷不住了' });
  must('新增返回 ok', add.json?.ok === true && add.json.entry?.content === '蚌埠住了', JSON.stringify(add.json).slice(0, 60));
  must('新增后 getter 能取到', s.getSlangEntries().length === 1);
  must('已落盘', JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8')).length === 1);
  // 重复
  const dup = await call(s, 'POST', '/api/slang', { content: '蚌埠住了' });
  must('重复内容被拒 400', dup.status === 400, String(dup.status));
  // 列表
  const list = await call(s, 'GET', '/api/slang');
  must('列表返回 1 条', list.json?.entries?.length === 1);
  const listCandidate = await call(s, 'GET', '/api/slang?status=confirmed');
  must('按 status 过滤', listCandidate.json?.entries?.length === 1, String(listCandidate.json?.entries?.length));
  // 改
  const id = s.getSlangEntries()[0].id;
  const patch = await call(s, 'PATCH', '/api/slang/' + id, { meaning: '改了含义' });
  must('PATCH 改成功', patch.json?.entry?.meaning === '改了含义', patch.json?.entry?.meaning);
  must('改动落盘', JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8'))[0].meaning === '改了含义');
  // 删
  const del = await call(s, 'DELETE', '/api/slang/' + id);
  must('DELETE 成功', del.json?.ok === true);
  must('删除后 getter 为空', s.getSlangEntries().length === 0);
}

console.log('\n[5] 批量操作与清空（含整体替换语义）');
{
  const seed = [
    { id: 'a1', content: 'x1', status: 'candidate', meaning: 'm1', count: 1 },
    { id: 'a2', content: 'x2', status: 'candidate', meaning: '', count: 1 },
    { id: 'a3', content: 'x3', status: 'confirmed', meaning: 'm3', count: 2 },
  ];
  fs.writeFileSync(SLANG_FILE, JSON.stringify(seed));
  const s = createSlangService(makeCtx());
  must('初始 3 条', s.getSlangEntries().length === 3);

  const bc = await call(s, 'POST', '/api/slang/batch-confirm', { ids: ['a1', 'a2'] });
  must('批量确认：缺含义的被跳过', bc.json?.confirmedCount === 1 && bc.json?.skippedCount === 1,
    JSON.stringify(bc.json));
  must('确认后状态变更', s.getSlangEntries().find((e) => e.id === 'a1').status === 'confirmed');

  const br = await call(s, 'POST', '/api/slang/batch-reject', { ids: ['a3'] });
  must('批量拒绝成功', br.json?.rejectedCount === 1);

  const bd = await call(s, 'POST', '/api/slang/batch-delete', { ids: ['a1'] });
  must('批量删除按 id', bd.json?.removedCount === 1 && s.getSlangEntries().length === 2);

  const cl = await call(s, 'POST', '/api/slang/clear', {});
  must('清空全部', cl.json?.removedCount === 2 && s.getSlangEntries().length === 0);
  must('清空后落盘为空', JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8')).length === 0);
}
{
  // clear 带 status：只删该状态
  const seed = [
    { id: 'b1', content: 'y1', status: 'candidate', meaning: 'm', count: 1 },
    { id: 'b2', content: 'y2', status: 'confirmed', meaning: 'm', count: 1 },
  ];
  fs.writeFileSync(SLANG_FILE, JSON.stringify(seed));
  const s = createSlangService(makeCtx());
  const r = await call(s, 'POST', '/api/slang/clear', { status: 'candidate' });
  must('按 status 清空只删该状态', r.json?.removedCount === 1 && s.getSlangEntries().length === 1);
  must('留下的是 confirmed', s.getSlangEntries()[0].status === 'confirmed');
}

console.log('\n[6] 上下文注入与公开字段');
{
  const seed = [
    { id: 'c1', content: '蚌埠住了', status: 'confirmed', meaning: '绷不住了', count: 9, usage: 'u', example: 'e' },
    { id: 'c2', content: '绝绝子', status: 'confirmed', meaning: '绝了', count: 2 },
    { id: 'c3', content: '候选词', status: 'candidate', meaning: '不该出现', count: 5 },
  ];
  fs.writeFileSync(SLANG_FILE, JSON.stringify(seed));
  const s = createSlangService(makeCtx());
  const list = s.confirmedSlangListV2();
  must('只返回 confirmed', list.every((e) => e.content !== '候选词') && list.length === 2, String(list.length));
  must('按出现次数降序', list[0].content === '蚌埠住了', list[0].content);
  const pub = s.publicSlangEntry({ id: 'x', content: 'c', internalSecret: '不该泄露' });
  must('公开字段不含内部字段', pub.internalSecret === undefined && pub.id === 'x');
  const withCtx = s.withSlangContext('原始提示词');
  must('上下文含时间行', withCtx.includes('【当前时间】'));
  must('上下文含黑话', withCtx.includes('蚌埠住了'));
  must('原始提示词被保留', withCtx.endsWith('原始提示词'));
}
{
  // 关闭 slang 时不注入
  fs.writeFileSync(SLANG_FILE, JSON.stringify([{ id: 'd1', content: '词', status: 'confirmed', meaning: 'm', count: 1 }]));
  const s = createSlangService(makeCtx({ cfg: { slang: { enabled: false } } }));
  const out = s.withSlangContext('原始');
  must('slang.enabled=false 时不注入黑话', !out.includes('词') && out.endsWith('原始'));
}

console.log('\n[7] 限频与窗口');
{
  fs.writeFileSync(SLANG_FILE, JSON.stringify([]));
  const s = createSlangService(makeCtx());
  const results = [1, 2, 3].map(() => s.allowSlangSubmit('group:1'));
  must('每分钟最多 2 次', results[0] && results[1] && !results[2], JSON.stringify(results));
  must('不同会话互不影响', s.allowSlangSubmit('group:2') === true);
}
{
  fs.writeFileSync(SLANG_FILE, JSON.stringify([]));
  const s = createSlangService(makeCtx());
  s.feedSlangWindow('group:1', '小明', '今天这波操作');
  must('普通消息进窗口', (s.slangWindows.get('group:1') ?? []).length === 1);
  s.feedSlangWindow('group:1', '小明', '/命令不该学');
  must('斜杠命令不进窗口', (s.slangWindows.get('group:1') ?? []).length === 1);
  s.feedSlangWindow('group:1', '小明', '进入角色扮演');
  must('角色控制语不进窗口', (s.slangWindows.get('group:1') ?? []).length === 1);
  for (let i = 0; i < 100; i++) s.feedSlangWindow('group:1', '小明', '刷屏' + i);
  must('窗口上限 80 条', (s.slangWindows.get('group:1') ?? []).length === 80,
    String((s.slangWindows.get('group:1') ?? []).length));
}

console.log('\n[8] 任务串行');
{
  const s = createSlangService(makeCtx());
  const order = [];
  const p1 = s.queueSlangTask(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); });
  const p2 = s.queueSlangTask(async () => { order.push(2); });
  await Promise.all([p1, p2]);
  must('任务按入队顺序串行', JSON.stringify(order) === '[1,2]', JSON.stringify(order));
}
{
  // 任务抛错不能中断整条链
  const s = createSlangService(makeCtx());
  const order = [];
  await s.queueSlangTask(async () => { throw new Error('故意失败'); });
  await s.queueSlangTask(async () => { order.push('after'); });
  must('前一个任务抛错不影响后续', order.includes('after'));
}

console.log('\n[9] dsh 未就绪时学习管线直接返回（不建会话）');
{
  const s = createSlangService(makeCtx({ getDshReady: () => false }));
  let threw = '';
  try {
    await s.runSlangExtraction('group:1');
    await s.runSlangResearch([{ id: 'x' }]);
    s.maybeQueueSlangExtraction('group:1');
  } catch (e) { threw = e.message; }
  must('未就绪时不抛错也不建会话', threw === '', threw);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
