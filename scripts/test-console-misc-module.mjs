// src/console-misc.js 的离线回归：不读真实 config、不发 QQ、不碰网络。
// 盯四件事：依赖注入缺项、路由命中/放行、白名单与敏感闸门、以及令牌设置的校验与回写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsoleMisc } from '../src/console-misc.js';

const noop = () => {};
let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

// 临时工作区：模块会读 ROOT/config.json 和 ROOT/public/roles.html
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'console-misc-'));
const STATE_DIR = path.join(ROOT, 'state');
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public', 'roles.html'), '<html>roles</html>');
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
  allow: { private: [], groups: [] }, deny: { private: [], groups: [] },
  ownerQQ: 10001, video: {}, pcJobs: {}, security: { interceptNotify: true },
}));

// 记录写入，避免真落盘污染
const writes = [];
function makeCtx(over = {}) {
  const cfg = {
    allow: { private: [], groups: [90001] }, deny: { private: [], groups: [] },
    ownerQQ: 10001, video: {}, pcJobs: {}, security: { interceptNotify: true },
  };
  return {
    readJsonSafe: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
    atomicWriteJson: (f, v) => { writes.push(['json', f, v]); fs.writeFileSync(f, JSON.stringify(v)); },
    atomicWriteText: (f, t) => { writes.push(['text', f, t]); },
    ROOT, STATE_DIR, cfg, log: noop,
    normalizeOwnerQQ: (v) => {
      const n = Number(String(v ?? '').trim());
      if (!Number.isFinite(n) || n <= 0) throw new Error('ownerQQ 无效');
      return String(n);
    },
    reconcileSessionPolicies: () => { writes.push(['reconcile']); },
    allowed: (kind, id) => (kind === 'private' ? id === 10001 : id === 90001),
    modeAllowed: (key, kind, id, c, mode) => mode !== 'closed-agent',
    escapeCqText: (s) => s,
    redactKnownTokensOnly: (s) => s,
    getBot: () => ({
      sendPrivateMessage: async () => ({ message_id: 111 }),
      sendGroupMessage: async () => ({ message_id: 222 }),
    }),
    getCurrentMode: () => 'chat',
    setConsoleToken: (t) => { writes.push(['token', t]); },
    ...over,
  };
}

// 假 res/req：只够跑通直出 HTML 那条分支
function makeReq(method, pathname) {
  return { method, url: pathname };
}
function makeRes() {
  const r = { status: 200, headers: null, body: '', writeHead(s, h) { r.status = s; r.headers = h; }, end(b) { r.body = b; } };
  return r;
}
// 跑一条路由，返回 { handled, json }
async function call(handler, method, pathname, body = null) {
  let json = null, status = 200;
  const sendJson = (obj, s = 200) => { json = obj; status = s; };
  const readBody = async () => body;
  const url = new URL('http://127.0.0.1:3100' + pathname);
  const res = makeRes();
  const handled = await handler(makeReq(method, pathname), res, url, { sendJson, readBody, SECURITY_HEADERS: {} });
  return { handled, json, status, res };
}

console.log('\n[1] 依赖注入缺项 → 立刻抛（fail-closed）');
for (const key of ['cfg', 'log', 'ROOT', 'STATE_DIR', 'readJsonSafe', 'atomicWriteJson',
  'atomicWriteText', 'normalizeOwnerQQ', 'reconcileSessionPolicies', 'allowed',
  'modeAllowed', 'escapeCqText', 'redactKnownTokensOnly', 'getBot', 'getCurrentMode', 'setConsoleToken']) {
  let threw = '';
  try { createConsoleMisc({ ...makeCtx(), [key]: undefined }); } catch (e) { threw = e.message; }
  must(`缺 ${key} 时抛错`, /ctx 缺少/.test(threw), threw);
}

console.log('\n[2] 路由命中与放行：不归我的必须返回 false');
const h = createConsoleMisc(makeCtx());
for (const [m, p] of [['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['GET', '/api/security'],
  ['POST', '/api/security'], ['GET', '/api/video'], ['POST', '/api/video'], ['GET', '/api/pcjobs'],
  ['POST', '/api/pcjobs'], ['POST', '/api/console/token'], ['POST', '/api/test-send'], ['GET', '/roles']]) {
  const { handled } = await call(h, m, p, {});
  must(`${m} ${p} 已接管`, handled === true);
}
for (const [m, p] of [['GET', '/api/voice'], ['POST', '/api/social/state'], ['GET', '/'], ['GET', '/api/nope']]) {
  const { handled } = await call(h, m, p, {});
  must(`${m} ${p} 放行给后面的路由`, handled === false);
}

console.log('\n[3] 白名单 / 安全通知：读写与落盘');
{
  const { json } = await call(h, 'GET', '/api/whitelist');
  must('GET 返回 allow/deny/ownerQQ', !!json?.allow && !!json?.deny && json.ownerQQ === 10001);
}
{
  writes.length = 0;
  const { json } = await call(h, 'POST', '/api/whitelist', { allow: { groups: ['90002', '90002', 'x'] }, ownerQQ: '10002' });
  must('POST 去重并过滤非数字', JSON.stringify(json.allow.groups) === '[90002]', JSON.stringify(json.allow?.groups));
  must('ownerQQ 已归一化', json.ownerQQ === '10002', String(json.ownerQQ));
  must('已落盘 config.json', writes.some((w) => w[0] === 'json'));
  must('已触发 reconcileSessionPolicies', writes.some((w) => w[0] === 'reconcile'));
}
{
  writes.length = 0;
  const { json, status } = await call(h, 'POST', '/api/whitelist', { ownerQQ: 'abc' });
  must('非法 ownerQQ 返回 400', status === 400 && json?.ok === false, String(status));
  must('非法时不落盘', !writes.some((w) => w[0] === 'json'));
  must('非法时不触发 reconcile', !writes.some((w) => w[0] === 'reconcile'));
}
{
  const { json } = await call(h, 'GET', '/api/security');
  must('GET security 返回 interceptNotify', json?.security?.interceptNotify === true);
}

console.log('\n[4] 视频分镜 / QQ指令：取值归一与"无改动"短路');
{
  const { json } = await call(h, 'GET', '/api/video');
  must('GET video 返回默认宫格 9', json?.video?.cells === 9, String(json?.video?.cells));
  must('GET video 声明 needRestart', json?.needRestart === true);
}
{
  const { json } = await call(h, 'POST', '/api/video', { cells: 7 });
  must('非法宫格回落到 9', JSON.stringify(json.changed).includes('cells=9'), JSON.stringify(json.changed));
}
{
  const { json } = await call(h, 'POST', '/api/video', {});
  must('空改动短路为 note 无改动', json?.note === '没有改动' && json?.needRestart === false);
}
{
  const { json } = await call(h, 'POST', '/api/pcjobs', { prefix: '  执行 任务  ' });
  must('前缀去空白且截断', JSON.stringify(json.changed).includes('prefix=执行任务'), JSON.stringify(json.changed));
  must('pcJobs 改完立即生效（needRestart=false）', json?.needRestart === false);
}

console.log('\n[5] 控制台令牌：长度/字符集校验 + 回写与 setter');
{
  const { json, status } = await call(h, 'POST', '/api/console/token', { token: 'short' });
  must('过短令牌返回 400', status === 400 && json?.ok === false);
}
{
  const { json, status } = await call(h, 'POST', '/api/console/token', { token: 'a'.repeat(200) });
  must('过长令牌返回 400', status === 400 && json?.ok === false);
}
{
  const { json, status } = await call(h, 'POST', '/api/console/token', { token: 'bad token with space!!' });
  must('非法字符令牌返回 400', status === 400 && json?.ok === false);
}
{
  writes.length = 0;
  const { json } = await call(h, 'POST', '/api/console/token', {});
  must('留空生成 48 位随机令牌', json?.generated === true && json?.token?.length === 48, String(json?.token?.length));
  must('随机令牌写入 state/console-token', writes.some((w) => w[0] === 'text' && w[1].includes('console-token')));
  must('随机令牌调用 setter 更新内存值', writes.some((w) => w[0] === 'token' && w[1] === json.token));
}

console.log('\n[6] 测试发送：敏感 / 白名单 / 模式 三道闸门');
{
  const { json, status } = await call(h, 'POST', '/api/test-send', { kind: 'private', id: 10001, message: 'password=abc123def' });
  must('敏感内容返回 403', status === 403 && json?.ok === false, String(status));
}
{
  const { json, status } = await call(h, 'POST', '/api/test-send', { kind: 'private', id: 88888, message: '你好' });
  must('非白名单目标返回 403', status === 403 && /白名单/.test(json?.error ?? ''), json?.error);
}
{
  const h2 = createConsoleMisc(makeCtx({ getCurrentMode: () => 'closed-agent' }));
  const { json, status } = await call(h2, 'POST', '/api/test-send', { kind: 'private', id: 10001, message: '你好' });
  must('模式不允许返回 403', status === 403 && /不允许/.test(json?.error ?? ''), json?.error);
}
{
  const { json, status } = await call(h, 'POST', '/api/test-send', { kind: 'group', id: 0, message: '你好' });
  must('非法 id 返回 400', status === 400 && json?.ok === false);
}
{
  const h3 = createConsoleMisc(makeCtx({ getBot: () => ({ sendPrivateMessage: async () => { throw new Error('bot 掉线'); } }) }));
  const { json, status } = await call(h3, 'POST', '/api/test-send', { kind: 'private', id: 10001, message: '你好' });
  must('发送异常返回 500 且带原因', status === 500 && /bot 掉线/.test(json?.error ?? ''), json?.error);
}
{
  const { json, status } = await call(h, 'POST', '/api/test-send', { kind: 'private', id: 10001, message: '你好' });
  must('正常私聊发送返回 message_id', status === 200 && json?.message_id === 111, String(json?.message_id));
}

console.log('\n[7] 角色页直出');
{
  const { handled, res } = await call(h, 'GET', '/roles.html');
  must('roles.html 直出成功', handled === true && res.body === '<html>roles</html>');
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
