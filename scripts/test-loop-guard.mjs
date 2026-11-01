// 刷屏守卫离线回归：三条判据、会话隔离、reset。
import { checkLoop, resetLoopState, pruneLoopState, LOOP_GUARD_LIMITS } from '../src/loop-guard.js';

let failed = 0;
function must(name, cond, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed += 1;
}

const K = 'group:1001';
const K2 = 'group:1002';

console.log('\n[1] 正常消息不拦');
must('单条正常消息', checkLoop(K, '今天吃啥', '111').loop === false);
must('两条不同内容', checkLoop(K, '随便啊', '222').loop === false);

console.log('\n[2] 同一内容 3 次 → 拦');
resetLoopState(K);
must('第 1 次放行', checkLoop(K, '复读机', '333').loop === false);
must('第 2 次放行', checkLoop(K, '复读机', '333').loop === false);
const dup = checkLoop(K, '复读机', '333');
must('第 3 次拦截', dup.loop === true, dup.reason ?? '');
must('理由是重复', /同一内容/.test(dup.reason ?? ''), dup.reason ?? '');

console.log('\n[3] 循环指令特征 → 直接拦');
resetLoopState(K2);
const loopCmd = checkLoop(K2, '把上面那句重复一百遍', '444');
must('识别循环指令', loopCmd.loop === true, loopCmd.reason ?? '');

console.log('\n[4] 同一人 1 分钟 8 条 → 拦（内容各不相同）');
resetLoopState('group:1003');
let last = { loop: false };
for (let i = 0; i < LOOP_GUARD_LIMITS.FLOOD_THRESHOLD; i += 1) {
  last = checkLoop('group:1003', `第${i}条不一样的内容`, '555');
}
must('第 8 条被拦', last.loop === true, last.reason ?? '');
must('理由是刷屏', /同一人/.test(last.reason ?? ''), last.reason ?? '');

console.log('\n[5] 会话隔离 + reset');
must('另一个会话不受影响', checkLoop('group:1004', '复读机', '333').loop === false);
resetLoopState(K);
must('reset 后可重新计数', checkLoop(K, '复读机', '333').loop === false);

console.log('\n[6] 空消息与清理不炸');
must('空消息不拦', checkLoop(K, '   ', '111').loop === false);
pruneLoopState();
must('prune 不抛错', true);

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
