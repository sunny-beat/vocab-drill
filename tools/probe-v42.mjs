/* v4.2 新能力体检：拼写逐字母差异（LCS 对齐）
 *
 * 用法：
 *   node tools/probe-v42.mjs                                  # 默认 http://127.0.0.1:8651/index.html
 *   node tools/probe-v42.mjs "file:///E:/.../index.html"
 *
 * 两部分：① 直接验对齐算法在各种错法下的输出；② 走真实拼写卡，验页面上真的
 *        摆出了两行、两行格子数相等（对齐）、且没把卡片撑出滚动条。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 13721 + (process.pid % 90);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-v42-'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
if (!bin) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

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
let seq = 0; const pending = new Map(); const errs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errs.push('[console] ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
async function js(expr) {
  const r = await send('Runtime.evaluate', {
    expression: '(async function(){' + expr + '})()', returnByValue: true, awaitPromise: true
  });
  const d = r.result;
  if (d?.exceptionDetails) throw new Error(d.exceptionDetails.exception?.description || d.exceptionDetails.text);
  return d?.result?.value;
}
async function until(expr, tries = 60, gap = 250) {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(gap); }
  return false;
}
function check(name, ok, detail) {
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ARG });
await until('return window.VD_BOOT_OK === 1', 80);

/* ---------- 1. 对齐算法：各种错法都要指出正确的位置 ---------- */
const algo = await js(`
  function probe(a, b) {
    var h = spellDiffHtml(a, b);
    var d = document.createElement('div');
    d.innerHTML = h;
    var rows = d.querySelectorAll('.sdiff-row');
    var idx = function (sel, row) {
      var out = [];
      if (!row) return out;
      Array.prototype.forEach.call(row.querySelectorAll('i'), function (el, k) {
        if (el.classList.contains(sel)) out.push(k);
      });
      return out;
    };
    return {
      html: h.length,
      missing: d.querySelectorAll('.dmiss').length,
      extra: d.querySelectorAll('.dbad').length,
      gaps: d.querySelectorAll('.dgap').length,
      rows: rows.length,
      cells0: rows.length ? rows[0].querySelectorAll('i').length : 0,
      cells1: rows.length > 1 ? rows[1].querySelectorAll('i').length : 0,
      badIdx: idx('dbad', rows[0]),
      missIdx: idx('dmiss', rows[1]),
      hint: (d.querySelector('.sdiff-hint') || {}).textContent || '',
      plain: !!d.querySelector('.sdiff.plain')
    };
  }
  return {
    drop:  probe('abilty', 'ability'),        // 漏了一个 i
    add:   probe('abandonn', 'abandon'),      // 多了一个 n
    swap:  probe('aband0n', 'abandon'),       // 把一个 a 写成 0
    same:  probe('ability', 'ability'),       // 全对
    upper: probe('Ability', 'ability'),       // 只差大小写
    empty: probe('', 'ability'),              // 没写
    long:  probe('antidisestablishmentarianismX', 'antidisestablishmentarianism')
  };
`);
check('漏一个字母 → 正确行标 1 个漏点、提示「漏了 i」',
  algo.drop.missing === 1 && algo.drop.extra === 0 && /漏了 i/.test(algo.drop.hint), algo.drop);
check('多一个字母 → 你写的行标 1 个错点、提示「多了 n」',
  algo.add.extra === 1 && algo.add.missing === 0 && /多了 n/.test(algo.add.hint), algo.add);
check('写错一个字母 → 错字与正确字落在同一列',
  algo.swap.extra === 1 && algo.swap.missing === 1 &&
  algo.swap.badIdx[0] === algo.swap.missIdx[0] &&
  /写成了/.test(algo.swap.hint), algo.swap);
check('拼对了就不出差异块', algo.same.html === 0, algo.same);
check('只差大小写不算拼错', algo.upper.html === 0, algo.upper);
check('空输入不出差异块', algo.empty.html === 0, algo.empty);
check('超长词退回一行原文（不铺格子）', algo.long.plain === true, algo.long);
check('两行格子数相等（对齐不靠字体，靠等宽格子）',
  algo.drop.rows === 2 && algo.drop.cells0 > 0 && algo.drop.cells0 === algo.drop.cells1,
  { a: algo.drop.cells0, b: algo.drop.cells1 });

/* ---------- 2. 真拼写卡：走 UI 把词拼错 ---------- */
const seeded = await js(`
  S.progress = {}; S.pause = {}; S.stars = {}; S.notes = {}; S.days = {}; S.rt = {}; S.confuse = {};
  S.session = null;
  S.settings.book = 'cet6'; S.settings.mode = 'spell'; S.settings.newPerDay = 20;
  S.settings.reviewCap = 40; S.settings.introBatch = 3; S.settings.autoSpeak = false;
  S.settings.reviewMode = 'all';
  save();
  await prepareBook();
  var ws = WORDS.slice(0, 30).map(function (it) { return it[0]; });
  ws.forEach(function (w, i) {
    S.progress[w] = {
      due: Date.now() - (i % 4) * 86400000,
      stability: 4 + i, difficulty: 5, last: Date.now() - 3 * 86400000,
      state: 2, lv: Math.min(7, i % 6), wrong: 0, lastG: 3
    };
  });
  save();
  PHASE = 'review';
  renderHero();
  await startPhase('review');
  await new Promise(r => setTimeout(r, 300));
  return { page: S.page, hasInput: !!document.getElementById('spell'), word: current ? current[0] : '' };
`);
check('进入拼写模式并出现输入框', seeded.hasInput && !!seeded.word, seeded);

const typed = await js(`
  var w = current[0];
  // 造一个「漏掉中间一个字母」的错法；词太短就补一个字母
  var bad = w.length > 3 ? (w.slice(0, 2) + w.slice(3)) : (w + 'x');
  var inp = document.getElementById('spell');
  inp.value = bad;
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  var fb = document.getElementById('spellfb');
  var d = fb.querySelector('.sdiff');
  var rows = d ? d.querySelectorAll('.sdiff-row') : [];
  var card = document.getElementById('card');
  return {
    word: w, typed: bad,
    hasDiff: !!d,
    rows: rows.length,
    cells0: rows.length ? rows[0].querySelectorAll('i').length : 0,
    cells1: rows.length > 1 ? rows[1].querySelectorAll('i').length : 0,
    miss: d ? d.querySelectorAll('.dmiss').length : 0,
    extra: d ? d.querySelectorAll('.dbad').length : 0,
    hint: d && d.querySelector('.sdiff-hint') ? d.querySelector('.sdiff-hint').textContent : '',
    cardOver: card.scrollHeight - card.clientHeight,
    pageOver: document.documentElement.scrollHeight - window.innerHeight
  };
`);
check('拼错后卡片上出现逐字母差异块', typed.hasDiff && typed.rows === 2, typed);
check('差异块两行格子数相等（严格对齐）',
  typed.cells0 > 0 && typed.cells0 === typed.cells1, { a: typed.cells0, b: typed.cells1 });
check('差异块指出了漏掉的字母', typed.miss >= 1 && /漏了/.test(typed.hint), { miss: typed.miss, hint: typed.hint });
check('加了差异块后卡片仍在一屏内', typed.cardOver <= 0 && typed.pageOver <= 0,
  { cardOver: typed.cardOver, pageOver: typed.pageOver });

/* ---------- 3. 拼对时不该出现差异块 ---------- */
const right = await js(`
  var nx = document.getElementById('next');
  if (nx) nx.click();
  await new Promise(r => setTimeout(r, 450));
  var w = current[0];
  var inp = document.getElementById('spell');
  inp.value = w;
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  var fb = document.getElementById('spellfb');
  return {
    word: w,
    hasDiff: !!fb.querySelector('.sdiff'),
    okLine: (fb.querySelector('.qres') || {}).className || '',
    cardOver: document.getElementById('card').scrollHeight - document.getElementById('card').clientHeight
  };
`);
check('拼对了不显示差异块', right.hasDiff === false, right);
check('拼对仍是「✓ 拼对了」判定', /ok/.test(right.okLine), right.okLine);

/* ---------- 4. 单词本：混过的词带「混N」标记，点一下看对手 ---------- */
const listCf = await js(`
  S.confuse = {};
  bumpConfuse('ability', 'abandon');
  bumpConfuse('ability', 'abandon');
  save();
  listTab = 'all';
  show('list');
  renderList();
  await new Promise(r => setTimeout(r, 250));
  var mark = document.querySelector('.row[data-w="ability"] .cfmark');
  var info = {
    hasMark: !!mark,
    text: mark ? mark.textContent : '',
    vs: mark ? mark.dataset.vs : '',
    title: mark ? mark.getAttribute('title') : ''
  };
  if (mark) mark.click();
  await new Promise(r => setTimeout(r, 300));
  var mod = document.getElementById('modal');
  info.modalOpen = mod ? !mod.classList.contains('hidden') : false;
  info.detail = (document.querySelector('#modal-body .word') || {}).innerText || '';
  closeModal();
  return info;
`);
check('单词本里混过的词带「混N」标记', listCf.hasMark && /混\d/.test(listCf.text), listCf);
check('「混N」的 title 写出了具体对手', /abandon/.test(listCf.title), listCf.title);
check('点「混N」直接打开对手的详情', listCf.modalOpen && /abandon/.test(listCf.detail), listCf);

check('全程无 JS 异常 / console.error', errs.length === 0, errs.slice(0, 3));

console.log('\nv4.2 专项体检结束');

ws.close(); proc.kill();
await wait(300); process.exit(0);
