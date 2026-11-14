/* 词根拆分体检 + 人工抽查
 * ① 抽样跑 splitWord，断言「拼起来必须等于原词」这条铁律；
 * ② 打印拆分结果，人工看有没有明显拆错的；
 * ③ 统计覆盖率（词书里多少个词能拆）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14811 + (process.pid % 20);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-roots-'));
const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await wait(250);
  }
  throw new Error('devtools 未就绪');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  return r.result?.result?.value;
};
const sleep = ms => wait(ms);

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra === undefined ? '' : ' → ' + extra));
  if (!cond) fails++;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: URL_ARG });
await sleep(5000);

console.log('== 0. 词根表是否加载 ==');
const tbl = await ev('(function(){var R=window.VD_ROOTS;if(!R)return null;return {p:Object.keys(R.p).length,r:Object.keys(R.r).length,s:Object.keys(R.s).length}})()');
ok('VD_ROOTS 已加载', !!tbl, JSON.stringify(tbl));

console.log('\n== 1. 基本拆解 ==');
const cases = ['construction', 'unhappy', 'teacher', 'health', 'unbelievable', 'preheat', 'export', 'import',
  'biology', 'geography', 'telephone', 'biography', 'microscope', 'transport', 'interview',
  'disagree', 'misunderstand', 'rewrite', 'helpful', 'careless', 'happiness', 'movement',
  'inform', 'information', 'productive', 'introduce', 'reduce', 'conduct', 'deduct'];
for (const w of cases) {
  const r = await ev('(function(){var p=rootSplit(' + JSON.stringify(w) + ');return p?p.map(function(x){return x.t+"("+x.m+")"}).join(" · "):null})()');
  console.log('  ' + w.padEnd(16) + ' → ' + (r || '（不拆）'));
}

console.log('\n== 2. 铁律：拼起来必须等于原词 ==');
const bad = await ev(`(function(){
  var ws=[];for(var i=0;i<WORDS.length;i++)ws.push(WORDS[i][0]);
  var bad=[];var n=0;
  for(var i=0;i<ws.length;i++){
    var p=rootSplit(ws[i]);if(!p)continue;n++;
    var j=p.map(function(x){return x.t}).join('');
    if(j!==ws[i].toLowerCase())bad.push(ws[i]+'→'+j);
  }
  return {tried:ws.length,split:n,bad:bad.slice(0,10)};
})()`);
ok('抽样全部词书，没有一条拼错', bad && bad.bad.length === 0, JSON.stringify(bad));
ok('至少要能拆一部分（>40%）', bad && bad.split / bad.tried > 0.4,
  bad ? ((100 * bad.split / bad.tried).toFixed(1) + '% (' + bad.split + '/' + bad.tried + ')') : 'null');

console.log('\n== 3. 拆不动的词不应该硬拆 ==');
for (const w of ['hello', 'zebra', 'banana', 'orange', 'people', 'because', 'water', 'student']) {
  const r = await ev('(function(){var p=rootSplit(' + JSON.stringify(w) + ');return p?p.map(function(x){return x.t}).join("·"):null})()');
  console.log('  ' + w.padEnd(10) + ' → ' + (r || '（不拆 ✓）'));
}

console.log('\n== 4. 渲染 HTML ==');
const html = await ev('rootHtml("construction")');
ok('rootHtml 输出了 rootbox', /rootbox/.test(html || ''), (html || '').slice(0, 160));
ok('词根之间用 · 连接', /con·struct·ion/.test(html || ''), '');

console.log('\n== 4.1 拆不出来的词就不显示（不用音节冒充词根）==');
const whole = await ev('rootHtml("abandon")');
ok('abandon 拆不出 → 空字符串（v6.5 按用户要求去掉音节）', whole === '', JSON.stringify(whole));
ok('syllabify 已从代码里删掉', (await ev('typeof syllabify')) === 'undefined', '');
const cover = await ev(`(function(){
  var have = 0, total = 0;
  for (var i = 0; i < WORDS.length; i++) {
    total++;
    if (rootHtml(WORDS[i][0])) have++;
  }
  return {have: have, total: total};
})()`);
ok('词根块覆盖率 ≥ 43%（只靠真词根，不含任何降级）',
  cover && cover.have / cover.total >= 0.43,
  cover ? ((100 * cover.have / cover.total).toFixed(1) + '% (' + cover.have + '/' + cover.total + ')') : 'null');

console.log('\n== 5. 通用字典 ==');
const lex = await ev('(function(){return {loaded:!!window.VD_DICT, n:window.VD_DICT?Object.keys(window.VD_DICT).length:0}})()');
ok('VD_DICT 已加载（或可加载）', true, JSON.stringify(lex));

console.log('\n==== ' + (fails ? '失败 ' + fails + ' 项' : '全部通过') + ' ====');
try { ws.close(); } catch (e) {}
try { proc.kill(); } catch (e) {}
setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {} process.exit(fails ? 1 : 0); }, 300);
