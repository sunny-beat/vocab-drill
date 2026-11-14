/* 学习卡「一屏装下」体检：量整页是否出现竖向滚动条，以及卡片内部有没有溢出。
 *
 * 用法：
 *   node tools/card-fit.mjs                                  # 默认 http://127.0.0.1:8642/index.html
 *   node tools/card-fit.mjs "file:///E:/.../index.html"
 *
 * 判定：pageOverflow = 0 且 cardOverflow = 0。非 0 说明要下拉才能看全，退出码 1。
 * 教学卡和「答错反馈」卡是两种最高的卡，两个都量。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8642/index.html';
/* 第三参数可选：只量指定尺寸，如 "390x780" 或 "900x720,1440x900"（逗号分隔）。
   六个尺寸一起跑要一分钟，单查某一档时用它。 */
const ONLY = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean)
  .map(s => s.split(/[x×]/).map(Number));
const SIZES = ONLY.length ? ONLY : [[1440, 900], [1280, 800], [1180, 760], [900, 760], [900, 720], [390, 780]];
const PORT = 13941 + (process.pid % 50);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-card-'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
if (!bin) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* wait */ }
    await wait(250);
  }
  throw new Error('devtools 未就绪');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', returnByValue: true, awaitPromise: true });
  const d = r.result;
  if (d?.exceptionDetails) throw new Error(d.exceptionDetails.exception?.description || d.exceptionDetails.text);
  return d?.result?.value;
}
async function until(expr, tries = 50, gap = 300) {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(gap); }
  return false;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

const MEAS = `
  var de = document.documentElement;
  var card = document.querySelector('.card');
  var r = card ? card.getBoundingClientRect() : null;
  var inner = card ? card.querySelector('.cardinner') : null;
  return {
    vh: innerHeight,
    pageOverflow: Math.max(0, Math.round(de.scrollHeight - innerHeight)),
    cardH: r ? Math.round(r.height) : 0,
    cardScroll: card ? Math.round(card.scrollHeight) : 0,
    cardClient: card ? Math.round(card.clientHeight) : 0,
    cardOverflow: card ? Math.max(0, Math.round(card.scrollHeight - card.clientHeight)) : 0,
    word: (document.querySelector('.word') || {}).textContent || '',
    parts: ['#topbar', '#hints', '#nav', 'main', '#page-study', '#study-main'].map(function (sel) {
      var e = document.querySelector(sel);
      return sel + ':' + (e ? Math.round(e.getBoundingClientRect().height) : -1);
    }).join(' '),
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    kids: card ? Array.from(card.children).map(function (c) {
      return (c.id || c.className || c.tagName) + ':' + Math.round(c.getBoundingClientRect().height);
    }).join(' | ') : '',
    fbkids: card ? Array.from(card.querySelectorAll('.qfb > *')).map(function (c) {
      return (c.id || c.className || c.tagName) + ':' + Math.round(c.getBoundingClientRect().height);
    }).join(' | ') : '',
    side: (function () {
      var e = document.getElementById('side'), sh = document.querySelector('.shell');
      if (!e) return 'none';
      var r = e.getBoundingClientRect(), sr = sh ? sh.getBoundingClientRect() : null;
      return 'side ' + Math.round(r.top) + '-' + Math.round(r.bottom) + ' h' + Math.round(r.height) +
        ' | shell ' + (sr ? Math.round(sr.top) + '-' + Math.round(sr.bottom) : '?') +
        ' | nav ' + Math.round(document.getElementById('nav').getBoundingClientRect().top);
    })(),
    cls: document.body.className, page: (window.S && S.page) || '?'
  };
`;

let bad = 0;
const rows = [];
for (const [W, H] of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
  await send('Page.navigate', { url: URL_ARG });
  if (!await until('return !!window.VD_BOOT_OK && typeof CHAPTERS !== "undefined" && CHAPTERS.length > 0;', 60)) {
    throw new Error('应用未启动，无法测量 ' + W + 'x' + H);
  }

  /* 干净状态：只学新词，先出教学卡 */
  await js(`
    S.progress = {}; S.pause = {}; S.session = null;
    S.settings.introBatch = 3; S.settings.newPerDay = 20; save();
    renderHero();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('hero-start').click();
    return 1;
  `);
  if (!await until('return !!document.querySelector(".card.intro")', 30, 250)) {
    throw new Error('未进入教学卡，无法测量 ' + W + 'x' + H);
  }
  await wait(300);

  /* 连看 10 张教学卡 + 连答错 6 张，取最差的一张（长释义 / 三条例句才是真考验） */
  const worst = { page: 0, card: 0, word: '' };
  const take = async (label) => {
    const m = await js(MEAS);
    if (!m) return;
    if (Math.max(m.pageOverflow, m.cardOverflow) > Math.max(worst.page, worst.card)) {
      worst.page = m.pageOverflow; worst.card = m.cardOverflow; worst.word = m.word.slice(0, 18) || label;
      worst.info = m;
    }
  };
  for (let i = 0; i < 10; i++) {
    await take('intro' + i);
    const more = await js(`
      if (document.querySelectorAll('#qopts .qopt').length) return 0;
      var b = document.getElementById('intro-next');
      if (!b) return 0;
      b.click();
      return 1;
    `);
    if (!more) break;
    await wait(260);
  }
  for (let i = 0; i < 6; i++) {
    const ok = await js(`
      var opts = document.querySelectorAll('#qopts .qopt');
      if (!opts.length) { var b = document.getElementById('intro-next'); if (b) b.click(); return 0; }
      if (!document.querySelector('.qres')) {
        opts[quizOpts.findIndex(function (o) { return !o.ok; })].click();
        return 1;
      }
      return 0;
    `);
    await wait(430);
    if (!ok) { await wait(300); continue; }
    await take('quiz' + i);
    await js(`
      var n = document.getElementById('qnext');
      if (n) n.click();
      return 1;
    `);
    await wait(420);
  }

  /* v6 新场景：答对后的「完整释义卡」—— 中文分条 + 例句 + EN 英文释义 + 搭配 + 近义词全在那，
     是这套界面里最高的一张卡。专挑最难装的词来试，装不下说明 fitFeedback 的降级顺序要调。 */
  await js(`
    var best = null, bestScore = 0;
    for (var i = 0; i < WORDS.length; i++) {
      var it = WORDS[i];
      if (!it[1] || it[1].length < 2) continue;
      if ((it[2] || []).length < 2) continue;
      if ((it[7] || []).length < 2) continue;
      var ss = (it[6] || []).filter(function (x) { return x && x[0]; });
      if (!ss.length) continue;
      var sc = it[1].join('').length + ss[0][0].length * 1.3 +
        ((it[9] && it[9][0] && it[9][0][0]) ? it[9][0][0].length : 0);
      if (sc > bestScore) { bestScore = sc; best = it[0]; }
    }
    if (!best) return 0;
    S.page = 'study';
    PHASE = 'review';
    QUEUE = [best]; QI = 0;
    renderCard(3);
    await new Promise(r => setTimeout(r, 320));
    var idx = quizOpts.findIndex(function (o) { return o.ok; });
    var b = document.querySelectorAll('#qopts .qopt')[idx];
    if (b) b.click();
    await new Promise(r => setTimeout(r, 520));
    return best;
  `);
  await wait(200);
  await take('answer');

  const badThis = worst.page > 0 || worst.card > 0;
  if (badThis) bad++;
  rows.push({ size: W + 'x' + H, worst });
  console.log((W + 'x' + H).padEnd(9),
    '页溢', String(worst.page).padStart(3), '· 卡内溢', String(worst.card).padStart(3),
    '|', badThis ? '还要滚 ❌ ' + worst.word : '一屏装下 ✅ ' + worst.word);
  if (badThis) console.log('   明细', JSON.stringify(worst));
}

ws.close();
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log(bad ? bad + ' 种尺寸需要滚动' : '全部尺寸学习卡都在一屏内');
process.exit(bad ? 1 : 0);
