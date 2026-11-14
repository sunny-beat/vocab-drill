/* 功能回归：卡片「已掌握」出口、完成页「再清 N 个」、完成页空格接力。
 * 独立跑，自己灌数据、自己清 profile，不依赖 smoke.mjs 的顺序。
 *
 *   node tools/smoke-feat.mjs                       # 默认 http://127.0.0.1:8642
 *   node tools/smoke-feat.mjs "file:///E:/.../index.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8642/index.html';
const W = 900, H = 800;
const OUT = path.resolve('tools/shots');   // v6.11.1 清理：_tmp/ 已删除，失败截图落到 tools/shots/
mkdirSync(OUT, { recursive: true });
const PORT = 13500 + (process.pid % 90);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-func-'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
const proc = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=' + W + ',' + H, 'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await wait(250);
  }
  throw new Error('devtools not ready');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pending = new Map(); const errs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('[console] ' + m.params.args.map(a => a.value).join(' '));
});
function send(method, params = {}) {
  const id = ++n; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', returnByValue: true, awaitPromise: true });
  const d = r.result;
  if (d?.exceptionDetails) throw new Error(d.exceptionDetails.exception?.description || d.exceptionDetails.text);
  return d?.result?.value;
}
async function until(expr, tries = 50) {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(300); }
  return false;
}
async function shot(name) {
  await wait(350);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  console.log('  saved', name + '.png');
}
function ok(name, cond, info) {
  console.log((cond ? '  ok    ' : '  FAIL  ') + name + (info === undefined ? '' : '  → ' + JSON.stringify(info)));
  if (!cond) process.exitCode = 1;
}

await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ARG });
await until('return !!document.getElementById("hero-start");');

/* 灌 30 个到期词，上限 3 → 清完 3 个后应出现「再清 N 个」 */
await js(`
  var bk = window.VD_DATA[Object.keys(window.VD_DATA)[0]];
  var ws = bk.words.slice(0, 30).map(function (w) { return w[0]; });
  var now = Date.now();
  S.progress = {}; S.pause = {}; S.session = null;
  for (var i = 0; i < 30; i++) {
    S.progress[ws[i]] = { due: now - (i+1)*3600e3, stability: 3+i, difficulty: 5, last: now-86400e3,
      state: 2, lv: 1, wrong: 0, lastWrong: 0, lastG: 3 };
  }
  S.settings.reviewMode = 'all'; S.settings.reviewCap = 3; save();
  return 1;
`);
await send('Page.reload', {});
await until('return !!document.getElementById("hero-start");');

/* ---- 1. 卡片上的「已掌握」按钮存在 ---- */
const start = await js(`
  document.getElementById('hero-start').click();
  await new Promise(r => setTimeout(r, 800));
  return {
    page: S.page,
    hasMaster: !!document.getElementById('wmaster'),
    hasPause: !!document.getElementById('wpause'),
    word: document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '',
    queue: QUEUE.length
  };
`);
ok('卡片上只剩「已掌握」这一个出口（暂缓已删）', start.hasMaster && !start.hasPause, start);
await shot('P3-wacts');

/* ---- 2. 点「已掌握」：词被 park、不打分、前进到下一个 ---- */
const dropped = await js(`
  var w = document.querySelector('.word').firstChild.textContent.trim();
  var before = JSON.stringify(S.progress[w]);
  document.getElementById('wmaster').click();
  await new Promise(r => setTimeout(r, 400));
  var now = document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '';
  return {
    word: w, next: now, advanced: now && now !== w,
    pause: S.pause[w], before: before, after: JSON.stringify(S.progress[w]),
    inQueue: QUEUE.indexOf(w), queue: QUEUE.length,
    hasMaster: !!document.getElementById('wmaster')
  };
`);
ok('「已掌握」把这个词永久移出（pause=0）', dropped.pause === 0 && dropped.inQueue === -1, dropped);
ok('「已掌握」不打分、进度一个字都没改', dropped.before === dropped.after, { before: dropped.before === dropped.after });
ok('「已掌握」之后自动翻到下一张', dropped.advanced && dropped.hasMaster, dropped);

/* ---- 3. v6.6 删掉暂缓：Z 键不该再有任何副作用 ---- */
const paused = await js(`
  var w = document.querySelector('.word').firstChild.textContent.trim();
  var hasBtn = !!document.getElementById('wpause');
  var before = JSON.stringify(S.pause[w] == null ? null : S.pause[w]);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return {
    word: w, hasBtn: hasBtn, before: before,
    after: JSON.stringify(S.pause[w] == null ? null : S.pause[w]),
    inQueue: QUEUE.indexOf(w)
  };
`);
ok('按 Z 不再暂缓（状态不变、词还在队列里）',
  !paused.hasBtn && paused.before === paused.after && paused.inQueue >= 0, paused);

/* ---- 4. 清掉剩下的（cap=3，只剩 1 个）→ 完成页出现「再清 N 个」 ---- */
const done = await js(`
  var guard = 0;
  while (guard++ < 40) {
    if (document.querySelector('.done')) break;
    var opts = document.querySelectorAll('#qopts .qopt');
    if (opts.length && !document.querySelector('.qres')) {
      var wi = quizOpts.findIndex(function (o) { return o.ok; });
      opts[wi].click();
      await new Promise(r => setTimeout(r, 200));
      var nd = document.getElementById('qnext');
      if (nd) nd.click();
      await new Promise(r => setTimeout(r, 400));
    } else {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  var d = document.querySelector('.done');
  if (!d) return { done: false };
  var btns = Array.from(d.querySelectorAll('.actions button')).map(function (b) { return b.textContent.trim(); });
  return {
    done: true,
    h2: d.querySelector('h2').textContent,
    btns: btns,
    p: d.querySelector('p').textContent.trim(),
    more: !!document.getElementById('go-more')
  };
`);
ok('复习完成页出现「再清 N 个」', done.done && done.more, done);
ok('完成页说明里写清了还剩多少到期词', /还有 \d+ 个到期词/.test(done.p || ''), done.p);
await shot('P4-done-more');

/* ---- 5. 完成页按空格 = 点主按钮（接着清） ---- */
const space = await js(`
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  return {
    done: !!document.querySelector('.done'),
    studying: !!document.querySelector('#qopts .qopt'),
    queue: QUEUE.length,
    sub: document.getElementById('study-sub-text').textContent
  };
`);
ok('完成页空格直接开始下一批（不用点鼠标）', space.studying && !space.done, space);
const nextCount = Number((done.btns?.[0] || '').match(/再清 (\d+) 个/)?.[1]);
ok('再清按钮的词数与实际队列一致', space.queue === nextCount, { label: nextCount, actual: space.queue });

console.log('ERRS', JSON.stringify(errs));
ws.close(); proc.kill();
await wait(300);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
