// 性能相关回归：只碰临时文件，不访问运行中的桥接、QQ 或 DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoundedLineWriter } from '../src/log-utils.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-perf-'));
let failed = 0;
function test(name, run) {
  try {
    run();
    console.log('PASS', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL', name, error.message);
  }
}

try {
  test('有界日志首次加载旧内容并在超限时批量裁剪', () => {
    const file = path.join(temp, 'activity.log');
    fs.writeFileSync(file, Array.from({ length: 20 }, (_, i) => `old-${i}`).join('\n') + '\n');
    const writer = createBoundedLineWriter({ file, maxLines: 5, trimSlack: 2 });
    for (let i = 0; i < 20; i++) writer.append(`new-${i}`);
    writer.flush();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.ok(lines.length <= 7, `日志应保持有界，实际 ${lines.length} 行`);
    assert.equal(lines.at(-1), 'new-19', '最新一行必须保留');
    assert.ok(lines.some((line) => line === 'new-15'), '裁剪后仍应保留最近窗口');
    assert.ok(!lines.includes('old-0'), '最旧内容应被裁剪');
  });

  test('有界日志在新文件上正常工作且只写传入内容', () => {
    const file = path.join(temp, 'nested', 'bridge.log');
    const writer = createBoundedLineWriter({ file, maxLines: 50 });
    writer.append('第一行');
    writer.append('第二行');
    assert.equal(writer.lineCount, 2);
    writer.flush();
    assert.equal(fs.readFileSync(file, 'utf8'), '第一行\n第二行\n');
  });

  test('热路径不再逐行全量读取日志', () => {
    const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
    assert.ok(!source.includes('fs.appendFileSync(BRIDGE_LOG'), 'bridge.log 应通过有界写入器追加');
    assert.ok(!source.includes('fs.appendFileSync(ACTIVITY_LOG'), 'activity log 应通过有界写入器追加');
    assert.ok(!source.includes('fs.appendFileSync(TOOL_LOG_FILE'), 'tool log 应通过有界写入器追加');
    assert.ok(!source.includes('fs.readFileSync(BRIDGE_LOG'), 'bridge.log 不应在每行写入后全量读取');
  });

  test('remote.mux inbox 不再用 shift 搬移整个积压数组', () => {
    const source = fs.readFileSync(path.join(root, 'src/dsh-client.js'), 'utf8');
    assert.ok(!source.includes('inbox.shift()'), 'inbox 不应再用 shift()');
    assert.ok(source.includes('inboxHead'), 'inbox 应使用读游标');
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
