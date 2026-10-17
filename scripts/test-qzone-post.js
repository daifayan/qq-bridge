const TOKEN = encodeURIComponent('deepseekHzm2006/9/25');
const BASE = 'http://127.0.0.1:3100';
async function post(request, dryRun = false) {
  const r = await fetch(BASE + '/api/qzone?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ request, dryRun }),
  });
  console.log('「' + request + '」 →', r.status);
  console.log(JSON.stringify(await r.json(), null, 2));
}
const [, , cmd, arg] = process.argv;
if (cmd === 'round') await post('说说 跑一轮');
else if (cmd === 'status') await post('说说', true);
else if (cmd === 'list') await post(`说说 ${arg || 3}`, true);
else if (cmd === 'peek') await post(`评看 ${arg}`, true);
else if (cmd === 'on') await post('说说 开');
else if (cmd === 'off') await post('说说 关');
else if (cmd === 'help') await post('帮助', true);
else console.log('用法: node scripts/test-qzone-post.js round|status|list [n]|peek <tid>|on|off|help');
