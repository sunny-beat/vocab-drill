/* v4.0 新能力体检：语境模式 / 今日目标环 / 图表联动 / 顽固词 / 词族 / 自定义词库 / 自适应阈值
 *
 * 用法：
 *   node tools/probe-v4.mjs                                  # 默认 http://127.0.0.1:8642/index.html
 *   node tools/probe-v4.mjs "file:///E:/.../index.html"
 *
 * 和其它体检脚本一样：独立临时 profile + 禁缓存，不碰用户数据。
 * 会先往页面里灌一批「到期 + 错词」的假进度，否则空数据下测不出联动。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8642/index.html';
const PORT = 13651 + (process.pid % 120);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-v4-'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome'
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
async function until(expr, tries = 40, gap = 250) {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(gap); }
  return false;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
}

await send('Page.navigate', { url: URL_ARG });
await until('return !!document.getElementById("hero-start");', 60);

/* ---------- 0. 灌注一批「到期 + 错词」的假进度 ---------- */
const seeded = await js(`
  S.progress = {}; S.pause = {}; S.stars = {}; S.notes = {}; S.days = {}; S.rt = {};
  S.session = null;
  S.settings.book = 'cet6'; S.settings.mode = 'recog'; S.settings.newPerDay = 20; S.settings.reviewCap = 40;
  S.settings.introBatch = 3; save();
  await prepareBook();
  var ws = WORDS.slice(0, 30).map(function (it) { return it[0]; });
  ws.forEach(function (w, i) {
    S.progress[w] = {
      due: Date.now() - (i % 4) * 86400000,
      stability: 4 + i, difficulty: 5, last: Date.now() - 3 * 86400000,
      state: 2, lv: 3, wrong: i < 6 ? 5 : 0, lastG: i < 6 ? 1 : 3
    };
  });
  save();
  PHASE = 'review';
  renderHero();
  await new Promise(r => setTimeout(r, 200));
  return { due: dueWords().length, leech: leechWords().length };
`);
check('灌注 30 个到期词（含 6 个顽固词）', seeded.due === 30 && seeded.leech === 6, seeded);

/* ---------- 1. 今日进度之书（v5.1 由圆环改来：同一份进度，三个形状读） ---------- */
const book = await js(`
  var f = document.getElementById('book-fill');
  var pct = document.getElementById('book-pct');
  var sub = document.getElementById('book-sub');
  var mk = document.getElementById('book-mark');
  var wrap = document.getElementById('hero-book');
  var r = wrap ? wrap.getBoundingClientRect() : null;
  var p = pct ? parseInt(pct.textContent, 10) : -1;
  var h = f ? Number(f.getAttribute('height')) : -1;
  return {
    has: !!f && !!mk,
    inHero: !!document.querySelector('#hero #hero-book'),
    pct: pct ? pct.textContent : '', p: p,
    sub: sub ? sub.textContent : '',
    fillY: f ? Number(f.getAttribute('y')) : -1,
    fillH: h,
    /* 光柱高度 × 顶端位置必须自洽：h 等于 140×p%，底边钉在封面底 150 */
    geoOk: f ? (Math.abs(h - Math.round(140 * p / 100)) <= 1 &&
      Math.abs((Number(f.getAttribute('y')) + h) - 150) <= 1) : false,
    mark: mk ? mk.getAttribute('d') : '',
    size: r ? [Math.round(r.width), Math.round(r.height)] : null
  };
`);
check('封面有今日进度之书（书脊光柱 + 封面百分比 + 书签）',
  book.has && book.inHero && /^\d+%$/.test(book.pct) && /^\d+ \/ \d+$/.test(book.sub) &&
  book.geoOk && /^M96 10h9v\d+l/.test(book.mark) && !!book.size && book.size[0] > 60, book);

/* 书脊光柱要跟着进度长，而且不能长过头（越界会顶出封面外）
   注意：下面把进度临时推到 100%，量完必须原样还原，否则后面对「30 个到期词」的断言全废。
   另外 renderHero() 会重建 hero 的 innerHTML —— 每次都得重新取元素，拿旧引用读到的是已摘除的节点。 */
const bookGrow = await js(`
  var before = Number(document.getElementById('book-fill').getAttribute('height'));
  var snapP = JSON.stringify(S.progress), snapD = JSON.stringify(S.days);
  var snapN = S.settings.newPerDay;
  Object.keys(S.progress).forEach(function (w) { S.progress[w].due = Date.now() + 86400000 * 9; });
  S.settings.newPerDay = 0; S.days[todayStr()] = { n: 0, r: 0 };
  save(); renderHero();
  await new Promise(r => setTimeout(r, 60));
  var f2 = document.getElementById('book-fill');
  var after = Number(f2.getAttribute('height'));
  var pct = document.getElementById('book-pct').textContent;
  /* rect 的 y 是顶边、y+h 是底边：满格时顶边要顶到封面顶（10），底边始终钉在 150 */
  var top = Number(f2.getAttribute('y'));
  var bottom = top + after;
  S.progress = JSON.parse(snapP); S.days = JSON.parse(snapD);
  S.settings.newPerDay = snapN;
  save(); renderHero();
  await new Promise(r => setTimeout(r, 60));
  return { before: before, after: after, pct: pct, top: top, bottom: bottom,
    back: Number(document.getElementById('book-fill').getAttribute('height')) };
`);
check('书脊光柱随进度变长且不越界（满格 = 顶边到 10、底边钉 150，之后能还原）',
  bookGrow.after > bookGrow.before && bookGrow.pct === '100%' && bookGrow.after === 140 &&
  Math.abs(bookGrow.top - 10) <= 1 && Math.abs(bookGrow.bottom - 150) <= 1 &&
  bookGrow.back === bookGrow.before, bookGrow);

/* ---------- 2. 7 天预测柱 → 当日词表 → 直接开练（三级联动） ---------- */
await js(`
  var fc = document.querySelector('#hero .forecast .fc[data-d="0"]');
  if (fc) fc.click();
  await new Promise(r => setTimeout(r, 300));
  return 1;
`);
const dayModal = await js(`
  var m = document.getElementById('modal');
  if (!m || m.classList.contains('hidden')) return null;
  return {
    h2: (document.querySelector('#modal-body h2') || {}).textContent || '',
    rows: document.querySelectorAll('#modal-body .row').length,
    hasGo: !!document.getElementById('day-go')
  };
`);
check('点「今天」柱子弹出当日到期词表', !!dayModal && dayModal.rows > 0 && dayModal.hasGo, dayModal);

await js(`
  var g = document.getElementById('day-go');
  if (g) g.click();
  await new Promise(r => setTimeout(r, 900));
  return 1;
`);
await until('return !!document.querySelector("#card .word");', 30);
const dayDrill = await js(`
  return { phase: PHASE, n: QUEUE.length, label: DRILL ? DRILL.label : '', page: S.page,
           hasCard: !!document.querySelector('#card .word') };
`);
check('「现在练」把这批词排成专项练习（不动今日计划）',
  dayDrill.phase === 'drill' && dayDrill.n > 0 && dayDrill.hasCard && dayDrill.page === 'study', dayDrill);

/* ---------- 3. 语境模式：挖空例句 → 填词 → 判对 ---------- */
const ctx = await js(`
  S.settings.mode = 'ctx'; save();
  /* 挑一个确实有例句、能挖空的词单独成组，避免第一张落在没例句的词上 */
  var pick = null;
  for (var i = 0; i < 200 && !pick; i++) {
    var it = WORDS[i];
    if (it && ctxPrompt(it)) pick = it[0];
  }
  await startPhase('drill', { words: [pick], label: '语境测试' });
  await new Promise(r => setTimeout(r, 400));
  var card = document.querySelector('#card');
  return {
    isCtx: !!card.querySelector('.ctxq'),
    blank: (card.querySelector('.ctxsent .en') || {}).innerText || '',
    meta: (document.getElementById('ctxmeta') || {}).innerText || '',
    noMeaning: !card.querySelector('.meaning.prompt'),
    word: current ? current[0] : '', pick: pick
  };
`);
check('语境卡：只给挖空例句，不给中文释义',
  ctx.isCtx && /_____/.test(ctx.blank) && ctx.noMeaning, { blank: ctx.blank.slice(0, 70), word: ctx.word });
check('语境卡阶梯提示（词性 / 字母数）', /个字母/.test(ctx.meta), ctx.meta);

const ctxAns = await js(`
  var w = current[0];
  var inp = document.getElementById('spell');
  inp.value = w;
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  var fb = (document.getElementById('spellfb') || {}).innerText || '';
  var nx = document.getElementById('next');
  if (nx) nx.click();
  await new Promise(r => setTimeout(r, 400));
  var p = S.progress[w] || {};
  return { word: w, fbOk: /填对|拼对/.test(fb), fbHasMean: fb.length > 20, dueAfter: p.due || 0, lastG: p.lastG };
`);
check('语境填对 → 判定有反馈并给出释义', ctxAns.fbOk && ctxAns.fbHasMean, ctxAns);
check('语境答对写回 FSRS 的下次到期', ctxAns.dueAfter > Date.now(), {
  dueAfter: new Date(ctxAns.dueAfter).toISOString(), word: ctxAns.word
});

/* ---------- 4. 顽固词：统计页入口 → 攻坚队列 ---------- */
const leech = await js(`
  openStats();
  await new Promise(r => setTimeout(r, 250));
  var btn = document.getElementById('st-leech');
  var txt = btn ? btn.textContent : '';
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 900));
  return { txt: txt, phase: PHASE, n: QUEUE.length, label: DRILL ? DRILL.label : '' };
`);
check('统计页给出顽固词入口并一键攻坚',
  /6/.test(leech.txt) && leech.phase === 'drill' && leech.n === 6 && /顽固/.test(leech.label), leech);

/* ---------- 5. 单词本多选 → 练选中的词 ---------- */
const selDrill = await js(`
  show('list');
  await new Promise(r => setTimeout(r, 500));
  renderListTabs(); renderList();
  setSelMode(true);
  var rows = Array.from(document.querySelectorAll('#list-results .row')).slice(0, 5);
  rows.forEach(function (r) { r.click(); });
  var before = selSet.size;
  var b = document.querySelector('#sel-acts button[data-act="drill"]');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 900));
  return { picked: before, phase: PHASE, n: QUEUE.length, page: S.page, hasBtn: !!b };
`);
check('单词本勾 5 个 → 直接开练 5 个',
  selDrill.hasBtn && selDrill.picked === 5 && selDrill.phase === 'drill' && selDrill.n === 5, selDrill);

/* ---------- 6. 侧栏数字 → 单词本对应分组 ---------- */
const sideJump = await js(`
  show('study'); renderHero();
  await new Promise(r => setTimeout(r, 300));
  var b = document.querySelector('#side .sg[data-list="wrong"]');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 600));
  return { hasBtn: !!b, page: S.page, tab: listTab, rows: document.querySelectorAll('#list-results .row').length };
`);
check('点边栏「错词」跳到单词本错词分组',
  sideJump.hasBtn && sideJump.page === 'list' && sideJump.tab === 'wrong' && sideJump.rows > 0, sideJump);

/* ---------- 7. 词族（同根词） ---------- */
const fam = await js(`
  await ensureAllBooks();
  var f = familyOf('abandon');
  var html = familyHtml('abandon');
  return { fam: f, hasChip: html.indexOf('famchip') > 0, n: f.length };
`);
check('同根词能按共同词根捞出来（abandon → abandonment …）',
  fam.n > 0 && fam.fam.some(function (x) { return /abandon/i.test(x); }) && fam.hasChip, fam);

/* ---------- 8. 自定义词库：解析 + 挂成词书 + 能开始学 ---------- */
const custom = await js(`
  var r = parseWordList('abandon v. 放弃；抛弃\\nallocate, v. 分配\\nbogusline\\ndeliberate adj. 深思熟虑的');
  var parsed = { n: r.words.length, skipped: r.skipped };
  saveCustom({ name: '测试词库', words: r.words });
  var bookOk = !!BOOKS.custom && !!VD_DATA.custom;
  S.settings.book = 'custom'; save();
  await prepareBook();
  var w = WORDS.length;
  await startPhase('new', { count: 2 });
  await new Promise(r => setTimeout(r, 400));
  var cardWord = (document.querySelector('#card .word') || {}).innerText || '';
  return { parsed: parsed, bookOk: bookOk, w: w, cardWord: cardWord.trim(),
           first: WORDS[0] ? WORDS[0][0] : '', phase: PHASE };
`);
check('自定义词表解析（3 条有效 / 1 行缺释义被跳过）',
  custom.parsed.n === 3 && custom.parsed.skipped === 1, custom.parsed);
check('自定义词库挂成词书并能开始学',
  custom.bookOk && custom.w === 3 && custom.cardWord.length > 0, { w: custom.w, word: custom.cardWord });

const customClean = await js(`
  removeCustomBook();
  S.settings.book = 'cet6'; save();
  await prepareBook();
  return { book: S.settings.book, w: WORDS.length, hasCustom: !!BOOKS.custom };
`);
check('删除自定义词库后回到内置词书', customClean.book === 'cet6' && !customClean.hasCustom, customClean);

/* ---------- 9. 自适应评分阈值 ---------- */
const adapt = await js(`
  S.rt = {}; var base = slowMs('recog');
  S.rt = { recog: new Array(20).fill(3000) };
  var fast = slowMs('recog');
  S.rt = { recog: new Array(20).fill(9000) };
  var slow = slowMs('recog');
  return { base: base, fast: fast, slow: slow };
`);
check('反应时自适应：手快的人阈值收紧、手慢的人放宽',
  adapt.base === 6000 && adapt.fast < adapt.base && adapt.slow > adapt.base, adapt);

/* ---------- 10. 收尾 ---------- */
check('无 JS 异常/console.error', errors.length === 0, errors.slice(0, 3));

ws.close();
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }

const bad = results.filter(r => !r.ok).length;
console.log('\n' + (results.length - bad) + '/' + results.length + ' 通过');
process.exit(bad ? 1 : 0);
