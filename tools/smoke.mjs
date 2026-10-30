/* 冒烟测试：无需 Playwright，用 Node 22 内置 WebSocket 直连 Edge 的 CDP。
 *
 * 用法：
 *   python -m http.server 8642 --bind 127.0.0.1   # 另开一个终端
 *   node tools/smoke.mjs [baseUrl]
 *
 * 默认 baseUrl = http://127.0.0.1:8642/index.html
 * 也可以通过 file:// 跑：node tools/smoke.mjs "file:///E:/path/to/vocab-drill/index.html"
 * （file:// 下不测 Service Worker）
 *
 * 每次运行使用独立临时 profile 且禁用 HTTP 缓存，避免「读到旧文件」的假象。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8642/index.html';
const PORT = 9333 + (process.pid % 200);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-smoke-'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome'
];

const bin = BROWSERS.find(existsSync) || process.env.BROWSER_BIN;
if (!bin) {
  console.error('找不到 Chrome/Edge，可用 BROWSER_BIN 指定');
  process.exit(2);
}

const proc = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--window-size=1280,900',
  'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const page = (await r.json()).find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* not ready */ }
    await wait(250);
  }
  throw new Error('devtools 未就绪');
}

const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));

let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('[console] ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}
async function js(expr) {
  const r = await send('Runtime.evaluate', {
    expression: '(async function(){' + expr + '})()',
    returnByValue: true, awaitPromise: true
  });
  const d = r.result;
  if (d?.exceptionDetails) throw new Error(d.exceptionDetails.exception?.description || d.exceptionDetails.text);
  return d?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

const isFile = URL_ARG.startsWith('file:');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
}

// ---------- 1. 加载 ----------
await send('Page.navigate', { url: URL_ARG });
// 线上（GitHub Pages）首次加载词库可能要几秒，轮询等封面/卡片出现而不是死等固定时长
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  await wait(500);
  ready = await js(`return !!(document.querySelector('#hero-start') || document.querySelector('.word') || document.querySelector('.bad'));`);
}
check('FSRS 已加载', await js('return !!window.FSRS && Object.keys(window.FSRS).length > 10;'));

// 封面（今日任务）：首次进入应落地在这里
const hero = await js(`
  var h = document.getElementById('hero');
  if (!h || h.classList.contains('hidden')) return null;
  return {
    h1: (h.querySelector('h1') || {}).innerText || '',
    stats: Array.from(h.querySelectorAll('.hstat b')).map(b => b.innerText),
    forecast: h.querySelectorAll('.forecast .fc').length,
    cta: (document.getElementById('hero-start') || {}).innerText || ''
  };
`);
check('封面页落地', !!hero, hero && { h1: hero.h1, cta: hero.cta });
if (hero) {
  check('封面三指标 + 7 天预测', hero.stats.length === 3 && hero.forecast === 7, hero.stats);
}
// 从封面进入学习
await js(`
  var b = document.getElementById('hero-start');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 600));
  return 1;
`);
let cardReady = false;
for (let i = 0; i < 20 && !cardReady; i++) {
  await wait(300);
  cardReady = await js(`return !!document.querySelector('.word');`);
}
check('点击开始进入卡片', cardReady);

const first = await js(`
  var w = document.querySelector('.word');
  var opts = Array.from(document.querySelectorAll('#qopts .qopt'));
  return {
    card: w ? w.firstChild.textContent.trim() : '',
    n: opts.length,
    okN: (typeof quizOpts !== 'undefined') ? quizOpts.filter(function (o) { return o.ok; }).length : -1,
    texts: opts.map(function (b) { var t = b.querySelector('.qtext'); return t ? t.innerText.trim() : ''; })
  };
`);
check('学习卡已渲染', !!first.card, first.card);
check('识别＝四选一（4 个选项，恰好 1 个正确）', first.n === 4 && first.okN === 1, { n: first.n, ok: first.okN });
check('四个选项文本互不重复', new Set(first.texts).size === 4, first.texts);

// ---------- 2. 答题与评分 ----------
if (!first.card || first.n !== 4) {
  check('答题交互可用', false, '卡片未就绪（词库加载失败？）');
} else {
  // 答错：亮出正确项 + 释义 + 例句，且不自动跳走
  const wrong = await js(`
    var wi = quizOpts.findIndex(function (o) { return !o.ok; });
    document.querySelectorAll('#qopts .qopt')[wi].click();
    await new Promise(r => setTimeout(r, 300));
    var fb = document.getElementById('qfb');
    return {
      bad: !!document.querySelector('.qopt-bad'),
      okShown: !!document.querySelector('.qopt-ok'),
      res: !!fb.querySelector('.qres.bad'),
      mean: !!fb.querySelector('.meaning .dline'),
      sent: !!fb.querySelector('.meaning .sent'),
      next: !!document.getElementById('qnext'),
      here: document.querySelector('.word').firstChild.textContent.trim()
    };
  `);
  check('答错高亮错误项与正确项', wrong.bad && wrong.okShown, wrong);
  check('答错显示释义 + 例句', wrong.res && wrong.mean && wrong.sent, wrong);
  check('答错后停留等你看完', wrong.here === first.card && wrong.next, wrong.here);

  const afterWrong = await js(`
    var w = document.querySelector('.word').firstChild.textContent.trim();
    document.getElementById('qnext').click();
    await new Promise(r => setTimeout(r, 400));
    var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
    var p = st.progress && st.progress[w];
    var nw = document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '';
    return { word: w, wrong: p ? p.wrong : null, advanced: !!nw && nw !== w };
  `);
  check('答错记为「不认识」并进错词本', afterWrong.wrong >= 1, afterWrong);
  check('「下一个」推进到下一张', afterWrong.advanced, afterWrong);

  // 答对：写入 FSRS 字段，并在 900ms 后自动翻页
  const right = await js(`
    var wi = quizOpts.findIndex(function (o) { return o.ok; });
    var w = document.querySelector('.word').firstChild.textContent.trim();
    document.querySelectorAll('#qopts .qopt')[wi].click();
    await new Promise(r => setTimeout(r, 1500));
    var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
    var p = st.progress && st.progress[w];
    var nw = document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '';
    return { word: w, stab: p ? p.stability : 0, moved: !!nw && nw !== w };
  `);
  check('答对写入 FSRS 字段(stability)', right.stab > 0, right.stab);
  check('答对后自动翻到下一张', right.moved);
}

// ---------- 2b. 识别卡自评（认识 / 不认识） ----------
const selfBtns = await js(`
  return { know: !!document.getElementById('selfknow'), no: !!document.getElementById('selfno') };
`);
check('识别卡提供「认识 / 不认识」自评', selfBtns.know && selfBtns.no, selfBtns);

const selfNo = await js(`
  var w = document.querySelector('.word').firstChild.textContent.trim();
  document.getElementById('selfno').click();
  await new Promise(r => setTimeout(r, 300));
  var fb = document.getElementById('qfb');
  var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  var p = st.progress && st.progress[w];
  var res = fb.querySelector('.qres');
  return {
    word: w,
    bad: res ? res.classList.contains('bad') : false,
    mean: !!fb.querySelector('.meaning .dline'),
    stayed: document.querySelector('.word').firstChild.textContent.trim() === w,
    stateRow: !!document.getElementById('selfrow')
  };
`);
check('自评「不认识」→ 亮出释义并停在原地', selfNo.bad && selfNo.mean && selfNo.stayed, selfNo);
check('作答后自评按钮收起', !selfNo.stateRow);

// ---------- 2c. 上一个 / 下一个（评分回溯，可双向） ----------
const nav = await js(`
  var L = function () { return JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}'); };
  var wordNow = function () {
    var el = document.querySelector('.word');
    return el ? el.firstChild.textContent.trim() : '';
  };
  var w1 = wordNow();
  document.getElementById('qnext').click();
  await new Promise(r => setTimeout(r, 450));
  var g = { word: wordNow(), prev: !!document.getElementById('prevbtn'), wrong: (L().progress[w1] || {}).wrong };

  document.getElementById('prevbtn').click();
  await new Promise(r => setTimeout(r, 450));
  var u = { back: wordNow() === w1, next: !!document.getElementById('nextbtn'), cleared: !L().progress[w1] };

  document.getElementById('nextbtn').click();
  await new Promise(r => setTimeout(r, 450));
  var r = { word: wordNow(), wrong: (L().progress[w1] || {}).wrong };
  return { w1: w1, g: g, u: u, r: r };
`);
check('评分后出现「上一个」', nav.g.prev && nav.g.word !== nav.w1, nav.g);
check('「上一个」回滚评分并退回那张卡', nav.u.back && nav.u.cleared, nav.u);
check('「下一个」恢复评分并继续前进', nav.r.wrong >= 1 && nav.r.word === nav.g.word, nav.r);

// ---------- 2d. 自评「认识」 ----------
const selfYes = await js(`
  var w = document.querySelector('.word').firstChild.textContent.trim();
  var b = document.getElementById('selfknow');
  b.click();
  await new Promise(r => setTimeout(r, 300));
  var fb = document.getElementById('qfb');
  var res = fb.querySelector('.qres');
  return {
    ok: res ? res.classList.contains('ok') : false,
    mean: !!fb.querySelector('.meaning .dline'),
    stayed: document.querySelector('.word').firstChild.textContent.trim() === w
  };
`);
check('自评「认识」→ 亮出释义让人确认（不自动翻）', selfYes.ok && selfYes.mean && selfYes.stayed, selfYes);

// ---------- 3. 记忆留存率 ----------
const ret = await js(`
  return retrievability({ stability: 5, difficulty: 5, last: Date.now() - 5*86400000, state: 2, due: Date.now() });
`);
check('记忆留存率按 FSRS-6 曲线（t=S 应≈90%）', Math.abs(ret - 90) <= 2, ret);

// ---------- 4. 两种模式（顶栏分段控件直达；听音已下线） ----------
const modes = await js(`
  var out = {};
  out.segN = document.querySelectorAll('#modeseg button').length;
  var seg = function (m) {
    var b = document.querySelector('#modeseg button[data-mode="' + m + '"]');
    if (b) b.click();
  };
  seg('spell');
  await new Promise(r => setTimeout(r, 350));
  out.spell = !!document.getElementById('spell');
  out.hasKnow = !!document.getElementById('submit');
  out.hasSkip = !!document.getElementById('skip');
  out.hasPlay = !!document.getElementById('playw');
  out.spellOn = document.querySelector('#modeseg button[data-mode="spell"]').classList.contains('on');
  document.getElementById('skip').click();
  await new Promise(r => setTimeout(r, 250));
  out.spellFb = (document.getElementById('spellfb').innerText || '').length > 0;
  var nx = document.getElementById('next');
  if (nx) nx.click();
  await new Promise(r => setTimeout(r, 400));
  seg('recog');
  await new Promise(r => setTimeout(r, 400));
  out.backToRecog = document.querySelectorAll('#qopts .qopt').length === 4;
  return out;
`);
check('听音模式已下线（分段控件 2 项）', modes.segN === 2, modes.segN);
check('拼写模式有「认识 / 不认识」两个选项', modes.spell && modes.hasKnow && modes.hasSkip, modes);
check('拼写模式有听音按钮', modes.hasPlay, modes.hasPlay);
check('拼写「不认识」直接看答案', modes.spellFb, modes.spellFb);
check('分段控件高亮当前模式', modes.spellOn);
check('切回识别仍是四选一', modes.backToRecog);

// ---------- 4b. 数据：一义一例 ----------
const dataOk = await js(`
  var bk = null, ks = Object.keys(window.VD_DATA || {});
  for (var i = 0; i < ks.length; i++) if (!bk) bk = window.VD_DATA[ks[i]];
  if (!bk) return { n: 0, bad: 0, defs: 0, sents: 0 };
  var bad = 0, defs = 0, sents = 0;
  for (var j = 0; j < bk.words.length; j++) {
    var w = bk.words[j];
    if (!Array.isArray(w[6]) || w[6].length !== w[1].length) { bad++; continue; }
    defs += w[1].length;
    for (var k = 0; k < w[6].length; k++) if (w[6][k]) sents++;
  }
  return { n: bk.words.length, bad: bad, defs: defs, sents: sents };
`);
check('例句数组与释义一一对齐', dataOk.n > 0 && dataOk.bad === 0, dataOk);
check('释义例句覆盖率 ≥ 95%', dataOk.sents / Math.max(1, dataOk.defs) >= 0.95,
  Math.round(dataOk.sents * 1000 / Math.max(1, dataOk.defs)) / 10 + '%');

// ---------- 5. 四个页面 ----------
for (const [pg, sel] of [['books', '.bcard'], ['dict', '#dict-search'], ['list', '#list-tabs']]) {
  await js(`document.querySelector('[data-page="${pg}"]').click(); return 1;`);
  let ok = false;
  for (let i = 0; i < 50 && !ok; i++) {
    await wait(400);
    ok = await js(`return !!document.querySelector('${sel}');`);
  }
  check('页面 ' + pg, ok);
}

// ---------- 6. PWA（仅 http/https） ----------
if (!isFile) {
  const pwa = await js(`
    var l = document.querySelector('link[rel=manifest]');
    var mf = l ? (await (await fetch(l.href)).json()) : null;
    var reg = ('serviceWorker' in navigator) ? await navigator.serviceWorker.getRegistration() : null;
    await new Promise(r => setTimeout(r, 1500));
    var keys = await caches.keys();
    var shell = keys.find(function (k) { return k.indexOf('vd-shell-') === 0; }) || '';
    var n = 0;
    if (shell) { var c = await caches.open(shell); n = (await c.keys()).length; }
    return { icons: mf ? mf.icons.length : 0, display: mf && mf.display, sw: !!reg, cache: shell, entries: n };
  `);
  check('manifest 可读', pwa.icons >= 4 && pwa.display === 'standalone', pwa);
  check('Service Worker 已注册并预缓存外壳', pwa.sw && pwa.entries >= 8, pwa.entries);

  // 首次访问时页面尚未被 SW 接管，词库是直接走网络的；重载一次才会被 SWR 落进 data 缓存
  await send('Page.reload', {});
  let reOk = false;
  for (let i = 0; i < 25 && !reOk; i++) {
    await wait(400);
    reOk = await js(`return !!document.querySelector('.word');`);
  }
  check('第二次加载仍正常（已被 SW 接管）', reOk, await js(`return !!navigator.serviceWorker.controller;`));

  const offlineReady = await js(`
    var keys = await caches.keys();
    var dk = keys.find(function (k) { return k.indexOf('vd-data-') === 0; });
    if (!dk) return { files: [] };
    var c = await caches.open(dk);
    var ks = (await c.keys()).map(function (r) { return new URL(r.url).pathname.split('/').pop(); });
    return { files: ks, controller: !!navigator.serviceWorker.controller };
  `);
  check('词库已进入离线缓存', offlineReady.files.length >= 1, offlineReady.files);

  // 断网后重载，应仍能出卡片（SW 兜底）
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload', {});
  let offOk = false;
  for (let i = 0; i < 20 && !offOk; i++) {
    await wait(400);
    offOk = await js(`return !!document.querySelector('.word');`);
  }
  const offDetail = offOk ? await js(`return document.querySelector('.word').firstChild.textContent.trim();`) : '断网后无卡片';
  check('断网重载仍可用', offOk, offDetail);
}

// ---------- 7. 运行时无报错 ----------
check('无 JS 异常/console.error', errors.length === 0, errors.slice(0, 3));

const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');

ws.close();
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(failed.length ? 1 : 0);
