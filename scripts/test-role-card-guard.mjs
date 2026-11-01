// 角色卡守卫离线回归：结构判断、比例校验、备份恢复。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRoleCard, sectionsOf, findLatestBackup, restoreRoleCard, validateForSave, ROLE_LIMITS } from '../src/role-card-guard.js';

let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

const GOOD = `# 角色卡：测试
## 一、你是谁
你是一只鲸鱼。
## 二、性格核心
温和、爱笑。
## 三、说话方式
短句，口语。
## 四、绝对不做
不骂人。
${'补充说明。'.repeat(160)}`;

console.log('\n[1] 正常角色卡');
const ok = inspectRoleCard(GOOD);
must('通过', ok.ok === true, ok.issues.join('；'));
must('识别 4 个二级标题', ok.sections.length === 4, ok.sections.join(','));
must('字符数合理', ok.chars > ROLE_LIMITS.minChars, String(ok.chars));

console.log('\n[2] 坏卡（空 / 无标题 / 超长）');
must('空卡拦下', inspectRoleCard('').ok === false);
must('无标题拦下', inspectRoleCard('一堆没有结构的文字'.repeat(100)).ok === false);
must('超长拦下', inspectRoleCard(`## 一\n${'字'.repeat(ROLE_LIMITS.maxChars + 10)}`).ok === false);

console.log('\n[3] 与上一版比较：被删掉一半 → 拦');
const shrunk = inspectRoleCard('## 一、你是谁\n你是一只鲸鱼。', { previous: GOOD });
must('字数骤减拦下', shrunk.ok === false, shrunk.issues.join('；'));
must('提示少节', shrunk.warnings.length > 0 || shrunk.issues.length > 0);

console.log('\n[4] 少一节但字数够 → 只提醒不拦');
const lostOne = GOOD.replace('## 四、绝对不做\n不骂人。', '');
const r4 = inspectRoleCard(lostOne, { previous: GOOD });
must('仍然通过', r4.ok === true, r4.issues.join('；'));
must('有少节提醒', r4.warnings.some((w) => /少了这些节/.test(w)), r4.warnings.join(' | '));

console.log('\n[5] 备份发现与恢复');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'role-guard-'));
const file = path.join(tmp, 'x.md');
fs.writeFileSync(file, '坏掉的空壳');
fs.writeFileSync(`${file}.bak-1`, GOOD);
must('找到备份', findLatestBackup(file) !== '', findLatestBackup(file));
const fixed = restoreRoleCard(file);
must('恢复成功', fixed.ok === true, fixed.error ?? '');
must('恢复后内容正确', fs.readFileSync(file, 'utf8').includes('你是谁'));
must('坏版本另存了', Boolean(fixed.savedBrokenAs) && fs.existsSync(fixed.savedBrokenAs));

console.log('\n[6] validateForSave 读当前文件作为基线');
const file2 = path.join(tmp, 'y.md');
fs.writeFileSync(file2, GOOD);
must('正常内容可保存', validateForSave(file2, GOOD).ok === true);
must('删成空壳不能保存', validateForSave(file2, '## 一、你是谁\n短').ok === false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
