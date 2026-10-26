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
  return {
    card: w ? w.firstChild.textContent.trim() : '',
    grades: Array.from(document.querySelectorAll('.grade')).map(b => b.textContent.trim())
  };
`);
check('学习卡已渲染', !!first.card, first.card);
check('间隔预览来自 FSRS（非兜底表）', first.grades.some(t => /认识/.test(t)), first.grades);

// ---------- 2. 评分推进 ----------
const canGrade = await js(`return !!document.getElementById('reveal') && !!document.querySelector('[data-g="3"]');`);
if (!canGrade) {
  check('评分交互可用', false, '没有评分按钮（词库加载失败？）');
} else {
  const progressed = await js(`
  document.getElementById('reveal').click();
  var w = document.querySelector('.word').firstChild.textContent.trim();
  document.querySelector('[data-g="3"]').click();
  await new Promise(r => setTimeout(r, 300));
  var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  var p = st.progress && st.progress[w];
  return { word: w, next: document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '',
           hasStability: !!(p && p.stability > 0), n: (st.days ? Object.values(st.days)[0].n : 0) };
`);
  check('评分写入 FSRS 字段(stability)', progressed.hasStability, progressed);
  check('进入下一张卡', progressed.next && progressed.next !== progressed.word, progressed.next);
}

// ---------- 3. 记忆留存率 ----------
const ret = await js(`
  return retrievability({ stability: 5, difficulty: 5, last: Date.now() - 5*86400000, state: 2, due: Date.now() });
`);
check('记忆留存率按 FSRS-6 曲线（t=S 应≈90%）', Math.abs(ret - 90) <= 2, ret);

// ---------- 4. 三模式（顶栏分段控件直达） ----------
const modes = await js(`
  var out = {};
  var seg = function (m) { document.querySelector('#modeseg button[data-mode="' + m + '"]').click(); };
  seg('spell');
  await new Promise(r => setTimeout(r, 350));
  out.spell = !!document.getElementById('spell');
  out.spellOn = document.querySelector('#modeseg button[data-mode="spell"]').classList.contains('on');
  document.getElementById('skip').click();
  await new Promise(r => setTimeout(r, 250));
  out.spellFb = (document.getElementById('spellfb').innerText || '').length > 0;
  var nx = document.getElementById('next') || document.getElementById('lnext');
  if (nx) nx.click();
  await new Promise(r => setTimeout(r, 300));
  seg('listen');
  await new Promise(r => setTimeout(r, 500));
  out.listen = document.querySelectorAll('#lopts .lopt').length;
  seg('recog');
  await new Promise(r => setTimeout(r, 350));
  out.backToRecog = !!document.querySelector('.grade');
  return out;
`);
check('拼写模式可用', modes.spell && modes.spellFb, modes.spellFb);
check('分段控件高亮当前模式', modes.spellOn);
check('听音辨意 4 选项', modes.listen === 4, modes.listen);
check('模式切回识别', modes.backToRecog);

// ---------- 5. 四个页面 ----------
for (const [pg, sel] of [['books', '.bcard'], ['dict', '#dict-search'], ['list', '#list-tabs']]) {
  await js(`document.querySelector('[data-page="${pg}"]').click(); return 1;`);
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
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

  const offlineReady = await js(`
    var keys = await caches.keys();
    var dk = keys.find(function (k) { return k.indexOf('vd-data-') === 0; });
    if (!dk) return { files: [] };
    var c = await caches.open(dk);
    var ks = (await c.keys()).map(function (r) { return new URL(r.url).pathname.split('/').pop(); });
    return { files: ks };
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
