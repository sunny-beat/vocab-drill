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
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8642/index.html';
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
  '--remote-debugging-port=0',
  '--user-data-dir=' + PROFILE,
  '--window-size=1280,900',
  'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const port = readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
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
const welcome = await js(`
  const shown = !!document.getElementById('welcome-panel') && !document.getElementById('modal').classList.contains('hidden');
  if (shown) document.getElementById('welcome-done').click();
  return shown && lsGet(WELCOME_KEY) === 'seen';
`);
check('首次启动显示导览，关闭后记住', welcome);

// 封面（今日任务）：首次进入应落地在这里
const hero = await js(`
  var h = document.getElementById('hero');
  if (!h || h.classList.contains('hidden')) return null;
  return {
    h1: (h.querySelector('h1') || {}).innerText || '',
    stats: Array.from(h.querySelectorAll('.hstat b')).map(b => b.innerText),
    forecast: h.querySelectorAll('.forecast .fc').length,
    fcempty: !!h.querySelector('.fcempty'),
    cta: (document.getElementById('hero-start') || {}).innerText || ''
  };
`);
check('封面页落地', !!hero, hero && { h1: hero.h1, cta: hero.cta });
check('首次使用默认复习所有到期词', await js("return S.settings.reviewMode === 'all';"));
if (hero) {
  check('封面三指标 + 7 天预测', hero.stats.length === 3 && (hero.forecast === 7 || hero.fcempty),
    { stats: hero.stats, fc: hero.forecast, empty: hero.fcempty });
}
// 从封面进入学习：新词段是「先教学后测验」
await js(`
  S.settings.introBatch = 6; S.settings.newPerDay = 6; save();
  var b = document.getElementById('hero-start');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 900));
  return 1;
`);
let cardReady = false;
for (let i = 0; i < 20 && !cardReady; i++) {
  await wait(300);
  cardReady = await js(`return !!document.querySelector('.card.intro');`);
}
const intro = await js(`
  var card = document.querySelector('.card');
  var w = card.querySelector('.word');
  return {
    intro: card.classList.contains('intro'),
    tag: (card.querySelector('.tagline') || {}).textContent || '',
    word: w ? w.firstChild.textContent.trim() : '',
    defs: card.querySelectorAll('.meaning .dblock').length,
    sents: card.querySelectorAll('.meaning .sent').length,
    noQuiz: document.querySelectorAll('#qopts .qopt').length === 0,
    wroteProgress: !!(window.S && w ? S.progress[w.firstChild.textContent.trim()] : false)
  };
`);
check('点击开始先出教学卡', cardReady && intro.intro && intro.noQuiz, intro);
check('教学卡带释义与例句', intro.defs >= 1 && intro.sents >= 1, { d: intro.defs, s: intro.sents });
check('教学卡不计分、不写进度', !intro.wroteProgress);

// 学习卡出现时整页锁成视口高：页面不要滚动条，卡片自己装下内容
const lock = await js(`
  var de = document.documentElement;
  var c = document.querySelector('.card');
  return {
    lock: document.body.classList.contains('study-lock'),
    pageOverflow: Math.max(0, Math.round(de.scrollHeight - innerHeight)),
    cardOverflow: c ? Math.max(0, Math.round(c.scrollHeight - c.clientHeight)) : -1
  };
`);
check('学习卡一屏装下（页面不出滚动条）', lock.lock && lock.pageOverflow === 0 && lock.cardOverflow === 0, lock);

// 首批教学时还没有测验队列，刷新也必须记住当前位置。
const introPos = await js(`
  document.getElementById('intro-next').click();
  return { w: current[0], pos: NEW.pos, queue: S.session.queue.length };
`);
let introResumed = true;
for (let attempt = 0; attempt < 2; attempt++) {
  await send('Page.reload', {});
  let restored = false;
  for (let i = 0; i < 30 && !restored; i++) {
    await wait(250);
    restored = await js(`return !!window.VD_BOOT_OK && !!NEW && NEW.mode === 'intro' &&
      NEW.pos === ${introPos.pos} && current[0] === ${JSON.stringify(introPos.w)};`);
  }
  introResumed = introResumed && restored;
}
check('首批教学连刷两次仍在同一张卡', introResumed && introPos.queue === 0, introPos);
if (introResumed) await js(`document.getElementById('intro-prev').click();`);

// 连点本批（6 个）→ 自动进测验
const toQuiz = await js(`
  for (var i = 0; i < 8; i++) {
    if (document.querySelectorAll('#qopts .qopt').length) break;
    var b = document.getElementById('intro-next');
    if (!b) break;
    b.click();
    await new Promise(r => setTimeout(r, 300));
  }
  return {
    opts: document.querySelectorAll('#qopts .qopt').length,
    intro: !!document.querySelector('.card.intro'),
    sub: document.getElementById('study-sub-text').textContent
  };
`);
check('学完本批自动转入四选一', toQuiz.opts === 4 && !toQuiz.intro, toQuiz);
const recall = await js(`
  const opts = document.getElementById('qopts');
  document.getElementById('recall-toggle').click();
  const hidden = opts.classList.contains('hidden') && S.settings.recallFirst;
  answerQuiz(0);
  const ungraded = !quizAnswered;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
  const revealed = !opts.classList.contains('hidden');
  document.getElementById('recall-toggle').click();
  return { hidden, ungraded, revealed };
`);
check('先回忆藏起选项，按空格展开且未作答', recall.hidden && recall.ungraded && recall.revealed, recall);

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

// 内容从卡片顶部起排：上方留白应只有一个内边距，多余空间全部在下方（释义要长在那块空间里）
const align = await js(`
  var c = document.getElementById('card');
  var cr = c.getBoundingClientRect();
  // 空反馈块是 display:none，别拿它当"最后一个元素"
  var kids = Array.from(c.children).filter(function (e) { return e.offsetHeight > 0; });
  var first = kids[0].getBoundingClientRect();
  var last = kids[kids.length - 1].getBoundingClientRect();
  return {
    topGap: Math.round(first.top - cr.top),
    bottomGap: Math.round(cr.bottom - last.bottom),
    padTop: parseInt(getComputedStyle(c).paddingTop, 10)
  };
`);
check('卡片内容顶部起排（留白都在下方）',
  align.topGap <= align.padTop + 2 && align.bottomGap > align.topGap, align);

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
    var cr = document.getElementById('card').getBoundingClientRect();
    var opr = document.getElementById('qopts').getBoundingClientRect();
    var fr = fb.getBoundingClientRect();
    return {
      bad: !!document.querySelector('.qopt-bad'),
      okShown: !!document.querySelector('.qopt-ok'),
      res: !!fb.querySelector('.qres.bad'),
      mean: !!fb.querySelector('.meaning .dline'),
      sent: !!fb.querySelector('.meaning .sent'),
      next: !!document.getElementById('qnext'),
      here: document.querySelector('.word').firstChild.textContent.trim(),
      belowOpts: fr.top >= opr.bottom - 1,
      fullyVisible: fr.bottom <= cr.bottom + 1
    };
  `);
  check('答错高亮错误项与正确项', wrong.bad && wrong.okShown, wrong);
  check('答错显示释义 + 例句', wrong.res && wrong.mean && wrong.sent, wrong);
  check('释义接在选项下方（不进上方留白）', wrong.belowOpts, wrong);
  check('释义完整可见（不被卡片底部裁掉）', wrong.fullyVisible, { belowOpts: wrong.belowOpts, fullyVisible: wrong.fullyVisible });
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

  // 答对：写入 FSRS 字段；v3.5.1 起学新词段不再自动跳走，停在原地等「加入复习 / 还不熟」
  const right = await js(`
    var wi = quizOpts.findIndex(function (o) { return o.ok; });
    var w = document.querySelector('.word').firstChild.textContent.trim();
    document.querySelectorAll('#qopts .qopt')[wi].click();
    await new Promise(r => setTimeout(r, 1500));
    var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
    var p = st.progress && st.progress[w];
    var nw = document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '';
    var bn = document.getElementById('qnext');
    var qr = document.querySelector('.qres');
    return { word: w, stab: p ? p.stability : 0, moved: !!nw && nw !== w, stayed: nw === w,
      hold: !!document.getElementById('qhold'), nextLabel: bn ? bn.textContent : '',
      qres: qr ? qr.textContent : '', whenGone: !document.querySelector('.qwhen') };
  `);
  check('学新词答对不自动跳走（等你看完释义）', right.stayed, right.moved);
  check('还没「加入复习」就不写进度（可反悔）', !right.stab, right.stab);
  check('答对后是「加入复习」（空格推进）而不是「下一个」', /加入复习/.test(right.nextLabel), right.nextLabel);
  check('答对后给「还不熟」反悔选项', right.hold);
  check('答完不再甩「下次复习 · X 天后」这句（v6.6 删）', right.whenGone && !/下次/.test(right.qres), right);

  const joined = await js(`
    var w = document.querySelector('.word').firstChild.textContent.trim();
    document.getElementById('qnext').click();
    await new Promise(r => setTimeout(r, 500));
    var nw = document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '';
    var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
    var p = (st.progress && st.progress[w]) || {};
    return { before: w, moved: !!nw && nw !== w, stab: p.stability || 0, g: p.lastG,
      days: p.due ? Math.round((p.due - Date.now()) / 86400000) : -1 };
  `);
  check('点「加入复习」才推进到下一张', joined.moved, joined);
  check('「加入复习」写入 FSRS 进度（默认 3 天后）', joined.stab > 0 && joined.g === 3 && joined.days >= 2, joined);

  // 「还不熟」= 记 1 分：明天再考一次、进错词本
  const hold = await js(`
    var wi = quizOpts.findIndex(function (o) { return o.ok; });
    var w = document.querySelector('.word').firstChild.textContent.trim();
    document.querySelectorAll('#qopts .qopt')[wi].click();
    await new Promise(r => setTimeout(r, 260));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
    var p = (st.progress && st.progress[w]) || {};
    var nw = document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '';
    return { word: w, wrong: p.wrong, g: p.lastG,
      days: p.due ? Math.round((p.due - Date.now()) / 86400000) : -1, moved: !!nw && nw !== w };
  `);
  check('按 N「还不熟」→ 记为不熟并明天再考', hold.wrong >= 1 && hold.g === 1 && hold.days <= 1, hold);
  check('「还不熟」后进下一张', hold.moved, hold);
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

// ---------- 2c2. 答后的「↩ 上一个词」（v6.9.4）----------
const pv = await js(`
  var wordNow = function () {
    var el = document.querySelector('.word');
    return el ? el.firstChild.textContent.trim() : '';
  };
  var w0 = wordNow();
  var previous = QUEUE[QI - 1];
  var hasBtn0 = !!document.getElementById('qprev');        // 还没作答，不该有
  var sb = document.getElementById('selfknow');
  if (sb) sb.click();
  await new Promise(r => setTimeout(r, 320));
  var answered = wordNow();
  var btn = document.getElementById('qprev');
  var hasBtn1 = !!btn;
  var title = btn ? btn.title : '';
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 420));
  var after = wordNow();
  var fbGone = !document.querySelector('#qfb .qres');
  return { w0: w0, hasBtn0: hasBtn0, answered: answered, hasBtn1: hasBtn1, title: title,
           after: after, previous: previous, fbGone: fbGone };
`);
check('未作答时没有「上一个词」按钮', pv.hasBtn0 === false, pv);
check('答完出现「↩ 上一个词」', pv.hasBtn1 === true && /上一个词/.test(pv.title), pv.title);
check('答后只退回相邻的上一个词', pv.after === pv.previous && pv.after !== pv.answered, pv);
check('退回去之后卡片回到未作答状态', pv.fbGone === true, pv);

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

// ---------- 4. 三种模式（顶栏分段控件直达；听音已下线，v4 加语境） ----------
const modes = await js(`
  var out = {};
  // 听写是 v5.0 的可选第四模式：默认 hidden，所以这里数「看得见的那几段」
  out.segN = Array.prototype.filter.call(document.querySelectorAll('#modeseg button'),
    function (b) { return !b.classList.contains('hidden'); }).length;
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
  seg('ctx');
  await new Promise(r => setTimeout(r, 400));
  out.ctx = !!document.querySelector('#card .ctxq');
  out.ctxMeta = (document.querySelector('#ctxmeta') || {}).innerText || '';
  out.ctxInput = !!document.getElementById('spell');
  out.ctxOn = document.querySelector('#modeseg button[data-mode="ctx"]').classList.contains('on');
  out.ctxBlanked = (document.querySelector('.ctxsent .en') || {}).innerText || '';
  seg('recog');
  await new Promise(r => setTimeout(r, 400));
  out.backToRecog = document.querySelectorAll('#qopts .qopt').length === 4;
  return out;
`);
check('三种常驻答题模式（识别 / 拼写 / 语境）', modes.segN === 3, modes.segN);
check('拼写模式有「认识 / 不认识」两个选项', modes.spell && modes.hasKnow && modes.hasSkip, modes);
check('拼写模式有听音按钮', modes.hasPlay, modes.hasPlay);
check('拼写「不认识」直接看答案', modes.spellFb, modes.spellFb);
check('分段控件高亮当前模式', modes.spellOn);
check('语境模式：挖空例句 + 输入框（不直接给释义）', modes.ctx && modes.ctxInput && /_____/.test(modes.ctxBlanked),
  { ctx: modes.ctx, blank: modes.ctxBlanked.slice(0, 60) });
check('语境卡给词性 / 字母数提示', /个字母/.test(modes.ctxMeta), modes.ctxMeta);
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

// ---------- 8. 今日任务台：复习 / 新词 / 顺带过 ----------
// 注入「40 个到期词，其中 12 个是错词」，再刷新看封面怎么算
await js(`
  var bk = window.VD_DATA[Object.keys(window.VD_DATA)[0]];
  var now = Date.now();
  for (var i = 0; i < 40; i++) {
    var w = bk.words[i][0];
    S.progress[w] = {
      due: now - (i + 1) * 3600e3, stability: 3 + i, difficulty: 5,
      last: now - 86400e3, state: 2, lv: 1,
      wrong: i < 12 ? 2 : 0, lastWrong: i < 12 ? now - 86400e3 : 0, lastG: i < 12 ? 1 : 3
    };
  }
  S.settings.reviewMode = 'wrong';
  S.session = null; S.page = 'study'; save();
  return 40;
`);
await send('Page.reload', {});
for (let i = 0; i < 40; i++) { if (await js('return !!document.getElementById("hero-start");')) break; await wait(400); }

const board = await js(`
  var t = function (id) { var e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
  return {
    tasks: document.querySelectorAll('#hero .task').length,
    modes: document.querySelectorAll('#rv-mode button').length,
    caps: document.querySelectorAll('#rv-cap button').length,
    hasNum: !!document.getElementById('nw-input'),
    rvN: t('rv-n'), rvNote: t('rv-note'),
    cta: t('hero-start'),
    browse: !document.getElementById('task-browse').classList.contains('hidden'),
    bwN: t('bw-n')
  };
`);
check('封面拆成三块可配置任务', board.tasks === 3 && board.modes === 2 && board.hasNum, board);
check('保留已保存的「只练错词」（12 / 40）', /12 词/.test(board.rvN) && /错词 12/.test(board.rvNote), board.rvN + ' | ' + board.rvNote);
check('顺带过 = 到期但非错词的 28 个', board.browse && /28/.test(board.bwN), board.bwN);

const allMode = await js(`
  document.querySelector('#rv-mode button[data-m="all"]').click();
  await new Promise(r => setTimeout(r, 200));
  return { rvN: document.getElementById('rv-n').textContent, cta: document.getElementById('hero-start').textContent,
    h1: document.querySelector('#hero h1').textContent };
`);
check('切「到期都练」→ 数量变 40', /40 词/.test(allMode.rvN) && /40/.test(allMode.cta), allMode);
check('切换档位后大标题同步（不再写「错词」）', /40 个到期词/.test(allMode.h1), allMode.h1);

const capCut = await js(`
  document.querySelector('#rv-cap button[data-c="20"]').click();
  await new Promise(r => setTimeout(r, 200));
  return { rvN: document.getElementById('rv-n').textContent, note: document.getElementById('rv-note').textContent };
`);
check('每轮上限 20 → 提示尚待复习的余量', /20 词/.test(capCut.rvN) && /另有 20 个待复习/.test(capCut.note), capCut);

// ---------- 7b. 右侧进度边栏（v3.7） ----------
const side0 = await js(`
  var el = document.getElementById('side');
  var t = function (id) { var e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
  return {
    shown: !!el && el.offsetParent !== null,
    due: t('s-due'), sub: t('s-duesub'), plan: t('s-plan'),
    rd: t('s-rdone'), nd: t('s-ndone'),
    cards: document.querySelectorAll('#side .s-card').length,
    leftover: ['s-cap', 's-new', 's-fc', 's-set'].filter(function (id) { return !!document.getElementById(id); }),
    go: t('s-go'),
    grid: document.querySelectorAll('#side .s-grid b').length
  };
`);
check('宽屏常驻右侧边栏（待复习 / 今日进度）', side0.shown && side0.due === '40' && /错词 12/.test(side0.sub), side0);
/* v6 精简：数量输入、7 天迷你图、设置按钮从边栏撤掉（封面/顶栏/设置页各有一份，边栏再放就是三份） */
check('边栏只留 3 块卡，重复入口已撤（数量输入 / 7 天图 / 设置按钮）',
  side0.cards === 3 && side0.leftover.length === 0, { cards: side0.cards, leftover: side0.leftover });
check('边栏保留词库状态 5 格（暂缓格已删）+ 一键开始',
  side0.grid === 5 && /复习 20 个/.test(side0.go), { grid: side0.grid, go: side0.go });

// ---------- 7c. 设置面板：数字直填 + 说明 + 恢复推荐值 ----------
const setPanel = await js(`
  document.getElementById('btn-settings').click();
  await new Promise(r => setTimeout(r, 260));
  var q = function (id) { return document.getElementById(id); };
  var r = {
    types: ['set-new', 'set-rvcap', 'set-batch'].map(function (id) { var e = q(id); return e ? e.type : ''; }),
    hints: document.querySelectorAll('#modal-body .s-hint').length,
    hasDefault: !!q('set-default'),
    hasOldSelect: !!document.querySelector('#modal-body .form-row')
  };
  var inp = q('set-rvcap');
  inp.value = '35'; inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  r.after = S.settings.reviewCap;
  var over = q('set-rvcap');
  over.value = '9999'; over.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  r.clamped = S.settings.reviewCap;
  q('set-default').click();
  await new Promise(r => setTimeout(r, 320));
  r.def = [S.settings.reviewCap, S.settings.newPerDay, S.settings.introBatch, S.settings.retention];
  return r;
`);
check('设置里三个数量都能直填数字（不再是固定下拉）',
  setPanel.types.every(function (t) { return t === 'number'; }) && !setPanel.hasOldSelect, setPanel.types);
check('设置改数字即时生效，每项带一行说明', setPanel.after === 35 && setPanel.hints >= 4, { after: setPanel.after, hints: setPanel.hints });
check('越界数字自动夹紧（复习量上限 999）', setPanel.clamped === 999, setPanel.clamped);
const sideCol = await js(`
  var vis = function (id) { var e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; };
  document.getElementById('s-close').click();
  await new Promise(r => setTimeout(r, 260));
  var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  var out = {
    collapsed: document.body.classList.contains('side-collapsed'),
    saved: !!(st.settings && st.settings.sideCollapsed),
    sideHidden: !vis('side'),
    tabShown: vis('side-tab')
  };
  document.getElementById('side-tab').click();
  await new Promise(r => setTimeout(r, 260));
  out.restored = !document.body.classList.contains('side-collapsed') && vis('side');
  out.tabHidden = !vis('side-tab');
  out.memSaved = !!(JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}').settings || {}).sideCollapsed === false;
  return out;
`);
check('边栏能收起（» 收起 → 右边留「‹ 进度」把手）',
  sideCol.collapsed && sideCol.saved && sideCol.sideHidden && sideCol.tabShown, sideCol);
check('点把手恢复边栏，并记住「没折叠」', sideCol.restored && sideCol.tabHidden && sideCol.memSaved, sideCol);

check('「恢复推荐值」回到 新词 20 / 复习 40 / 教学 5 / 90%',
  setPanel.hasDefault && setPanel.def[0] === 40 && setPanel.def[1] === 20 && setPanel.def[2] === 5 && setPanel.def[3] === 0.9, setPanel.def);

// 只留 3 个复习词，方便把一段走完
const reviewGo = await js(`
  document.querySelector('#rv-mode button[data-m="wrong"]').click();
  document.querySelector('#rv-cap button[data-c="20"]').click();
  await new Promise(r => setTimeout(r, 150));
  S.settings.reviewCap = 3; save(); refreshHero();
  await new Promise(r => setTimeout(r, 120));
  document.getElementById('hero-start').click();
  await new Promise(r => setTimeout(r, 1500));
  return {
    introCard: !!document.querySelector('.card.intro'),
    opts: document.querySelectorAll('#qopts .qopt').length,
    sub: document.getElementById('study-sub-text').textContent
  };
`);
check('开始复习直接进四选一（不插教学卡）', reviewGo.opts === 4 && !reviewGo.introCard, reviewGo);
check('复习段副标题标明是复习', /复习/.test(reviewGo.sub), reviewGo.sub);

const reviewEnd = await js(`
  var guard = 0;
  while (guard++ < 60) {
    var nd = document.getElementById('qnext');
    if (nd) { nd.click(); await new Promise(r => setTimeout(r, 240)); }
    var opts = document.querySelectorAll('#qopts .qopt');
    if (opts.length && !document.querySelector('.qres')) {
      var wi = quizOpts.findIndex(function (o) { return o.ok; });
      opts[wi].click();
      await new Promise(r => setTimeout(r, 340));
      continue;
    }
    if (document.querySelector('.done')) break;
    await new Promise(r => setTimeout(r, 160));
  }
  var done = document.querySelector('.done');
  return {
    h2: done ? done.querySelector('h2').textContent : '',
    btns: done ? Array.from(done.querySelectorAll('.actions button')).map(function (b) { return b.textContent; }) : []
  };
`);
check('复习段收尾出「复习完成」小结算', reviewEnd.h2 === '复习完成', reviewEnd);
check('结算页引导去学新词', reviewEnd.btns.some(function (s) { return /新词/.test(s); }), reviewEnd.btns);

// ---------- 8b. 新词：先教学后测验 ----------
const newFlow = await js(`
  S.settings.introBatch = 3; S.settings.newPerDay = 10; save();
  await startPhase('new', { count: 10 });
  await new Promise(r => setTimeout(r, 900));
  var w = NEW ? NEW.list[0] : '';
  var before = !!S.progress[w];
  var card = document.querySelector('.card');
  return {
    intro: card.classList.contains('intro'),
    tag: (card.querySelector('.tagline') || {}).textContent || '',
    word: w, wroteProgress: before,
    noQuiz: document.querySelectorAll('#qopts .qopt').length === 0,
    means: card.querySelectorAll('.meaning .dblock').length,
    sents: card.querySelectorAll('.meaning .sent').length
  };
`);
check('新词段第一张是教学卡（无选项）', newFlow.intro && newFlow.noQuiz, newFlow);
check('教学卡展示释义 + 例句', newFlow.means >= 1 && newFlow.sents >= 1, { d: newFlow.means, s: newFlow.sents });
check('教学卡不计分、不写进度', !newFlow.wroteProgress, newFlow.wroteProgress);

const batchFlow = await js(`
  for (var i = 0; i < 3; i++) {
    var b = document.getElementById('intro-next');
    if (b) b.click();
    await new Promise(r => setTimeout(r, 320));
  }
  return {
    opts: document.querySelectorAll('#qopts .qopt').length,
    intro: !!document.querySelector('.card.intro'),
    sub: document.getElementById('study-sub-text').textContent,
    listN: NEW ? NEW.list.length : 0
  };
`);
check('学满本批（3 个）自动转入测验', batchFlow.opts === 4 && !batchFlow.intro, batchFlow);

// ---------- 8c. 顺带过：只看不测 ----------
const browseFlow = await js(`
  PHASE = 'review'; show('study'); renderHero();
  await new Promise(r => setTimeout(r, 700));
  var w0 = null;
  var bw = browseWords();
  if (bw.length) w0 = bw[0];
  var before = w0 ? JSON.stringify(S.progress[w0] || null) : '';
  document.getElementById('browse-go').click();
  await new Promise(r => setTimeout(r, 1500));
  var card = document.querySelector('.card');
  var tag = (card.querySelector('.tagline') || {}).textContent || '';
  document.getElementById('intro-next').click();
  await new Promise(r => setTimeout(r, 350));
  return {
    intro: card.classList.contains('intro'),
    tag: tag,
    noQuiz: tag.indexOf('顺带过') >= 0,
    untouched: JSON.stringify(S.progress[w0] || null) === before,
    word: w0
  };
`);
check('顺带过是教学卡、标明只看不测', browseFlow.intro && browseFlow.noQuiz, browseFlow);
check('顺带过不动记忆曲线', browseFlow.untouched, browseFlow.word);

// ---------- 8d. 单词本：多选 / 已掌握 / 删除 / 备注 ----------
const lb = await js(`
  show('list');
  await initListPage();
  await new Promise(r => setTimeout(r, 700));
  var tabs = Array.from(document.querySelectorAll('#list-tabs button')).map(function (b) { return b.dataset.t; });
  return { tabs: tabs, rows: document.querySelectorAll('#list-results .row').length,
    selBtn: !!document.getElementById('sel-toggle') };
`);
check('单词本分组只剩「已掌握」，暂缓 tab 已删（v6.6）',
  lb.tabs.indexOf('paused') < 0 && lb.tabs.indexOf('mastered') >= 0, lb.tabs);
check('单词本列出词条与「多选」入口', lb.rows > 0 && lb.selBtn, lb);

const multi = await js(`
  document.querySelector('#list-tabs button[data-t="all"]').click();
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('sel-toggle').click();
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('sel-all').click();
  await new Promise(r => setTimeout(r, 250));
  return { selected: document.querySelectorAll('#list-results .row.sel').length,
    acts: !document.getElementById('sel-acts').classList.contains('hidden'),
    count: document.getElementById('sel-count').textContent };
`);
check('多选模式：全选勾上可见词条', multi.selected > 0 && multi.acts, multi);

const bulk = await js(`
  document.getElementById('sel-toggle').click();          // 退出，清空选择
  await new Promise(r => setTimeout(r, 250));
  document.getElementById('sel-toggle').click();          // 再进多选
  await new Promise(r => setTimeout(r, 250));
  var rows = Array.from(document.querySelectorAll('#list-results .row')).slice(0, 3);
  var picked = [];
  rows.forEach(function (r) { r.click(); picked.push(r.dataset.w); });
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('#sel-acts button[data-act="master"]').click();
  await new Promise(r => setTimeout(r, 450));
  var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  return {
    picked: picked,
    zeros: picked.filter(function (w) { return st.pause && st.pause[w] === 0; }).length,
    inReview: picked.filter(function (w) { return reviewPlan().list.indexOf(w) >= 0; }).length,
    inNew: picked.filter(function (w) { return newWords(50).indexOf(w) >= 0; }).length
  };
`);
check('批量「已掌握」→ pause=0', bulk.zeros === 3, bulk);
check('已掌握的词不再进复习 / 新词队列', bulk.inReview === 0 && bulk.inNew === 0, bulk);

const menu = await js(`
  var r = document.querySelector('#list-results .row');
  var w = r.dataset.w;
  r.querySelector('.rowmore').click();
  await new Promise(r => setTimeout(r, 260));
  var m = document.getElementById('rowmenu');
  var items = m ? Array.from(m.querySelectorAll('button')).map(function (b) { return b.textContent.trim(); }) : [];
  var hasPause = items.some(function (t) { return t.indexOf('暂缓') >= 0; });
  if (m) m.querySelector('button[data-act="master"]').click();
  await new Promise(r => setTimeout(r, 450));
  var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  var zeros = !!(st.pause && st.pause[w] === 0);
  document.querySelector('#list-tabs button[data-t="mastered"]').click();
  await new Promise(r => setTimeout(r, 450));
  var inMastered = Array.from(document.querySelectorAll('#list-results .row'))
    .some(function (x) { return x.dataset.w === w; });
  document.querySelector('#list-tabs button[data-t="all"]').click();
  await new Promise(r => setTimeout(r, 350));
  return { word: w, items: items, hasPause: hasPause, zeros: zeros, inMastered: inMastered };
`);
check('行内「⋯」菜单只剩 已掌握 / 改释义 / 删除（暂缓已删）',
  !menu.hasPause && /改释义/.test(menu.items.join(' ')) && menu.items.length <= 4, menu.items);
check('单行「已掌握」→ pause=0 并进「已掌握」分组', menu.zeros && menu.inMastered, menu);

const noteDel = await js(`
  var w = document.querySelector('#list-results .row').dataset.w;
  openDetail(w, true);
  await new Promise(r => setTimeout(r, 500));
  var ta = document.getElementById('dt-note');
  ta.value = '我自己记的：先记住这个用法';
  document.getElementById('dt-notesave').click();
  await new Promise(r => setTimeout(r, 450));
  var st = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  var saved = st.notes && st.notes[w];
  closeModal();
  var anchor = document.querySelector('.row[data-w="' + w + '"] .rowmore');
  if (anchor) { anchor.click(); await new Promise(r => setTimeout(r, 220)); }
  var del = anchor ? Array.from(document.querySelectorAll('#rowmenu button')).filter(function (b) { return /删除/.test(b.textContent); })[0] : null;
  if (del) del.click();
  await new Promise(r => setTimeout(r, 400));
  var st2 = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  return { word: w, note: saved || '',
    gone: !(st2.progress && st2.progress[w]) && !(st2.notes && st2.notes[w]) };
`);
check('我的释义能保存', /先记住这个用法/.test(noteDel.note), noteDel.note);
check('「删除」清掉该词的进度与备注', noteDel.gone, noteDel);

// ---------- 8e. 章节入口：点第 1 章就必须学第 1 章 ----------
const A1 = `.ch[data-i="0"]`;

// (1) 第一章已经全学完：应变成「复习本章」，而不是偷偷跳到第二章
const chReview = await js(`
  S.progress = {}; S.pause = {}; S.session = null;
  var a1 = CHAPTERS[0].words;
  a1.forEach(function (w) {
    S.progress[w] = { due: Date.now() + 86400e3, stability: 6, difficulty: 5, last: Date.now(),
      state: 2, lv: 2, wrong: 0, lastWrong: 0, lastG: 3 };
  });
  S.settings.introBatch = 3; S.settings.newPerDay = 20; save();
  show('study'); PHASE = 'review'; renderHero();
  await new Promise(r => setTimeout(r, 300));
  show('books');
  await new Promise(r => setTimeout(r, 900));
  document.querySelector('${A1}').click();
  await new Promise(r => setTimeout(r, 400));
  var btn = document.getElementById('ch-study').textContent.trim();
  document.getElementById('ch-study').click();
  await new Promise(r => setTimeout(r, 1000));
  return {
    btn: btn, phase: PHASE, chapterReview: CHAPTER_REVIEW, curCh: CUR_CH,
    chapter: CHAPTERS[CUR_CH].label,
    qn: QUEUE.length,
    allInA1: QUEUE.every(function (w) { return a1.indexOf(w) >= 0; }),
    sub: document.getElementById('study-sub-text').textContent,
    opts: document.querySelectorAll('#qopts .qopt').length,
    page: S.page
  };
`);
check('第一章学完了 → 按钮变「复习本章」', /复习本章/.test(chReview.btn) && chReview.page === 'study', chReview.btn);
check('点已学完的第 1 章 → 复习第 1 章（不再跳第 2 章）',
  chReview.chapterReview && chReview.curCh === 0 && chReview.qn === 40 && chReview.allInA1 &&
  /复习本章 · List A1/.test(chReview.sub) && chReview.opts === 4, chReview);

// (2) 整章复习收尾 → 给「学下一章 List A2 / 再刷一遍本章」，而不是会串章的中性按钮
const chDone = await js(`
  QUEUE.length = 2; QI = 0; sessionGrades = {}; renderCard();
  await new Promise(r => setTimeout(r, 350));
  for (var i = 0; i < 8; i++) {
    if (document.getElementById('go-nextch')) break;
    var opts = document.querySelectorAll('#qopts .qopt');
    if (opts.length) {
      opts[quizOpts.findIndex(function (o) { return o.ok; })].click();
      await new Promise(r => setTimeout(r, 400));
    }
    var nx = document.getElementById('qnext');
    if (nx) { nx.click(); await new Promise(r => setTimeout(r, 400)); }
  }
  return {
    h2: (document.querySelector('.done h2') || {}).textContent || '',
    btns: Array.from(document.querySelectorAll('#card button')).map(function (b) { return b.textContent.trim(); })
  };
`);
check('整章复习收尾写明「本章复习完成」', /本章复习完成/.test(chDone.h2), chDone.h2);
check('收尾给「学下一章 List A2 / 再刷一遍本章」两个明确出口',
  chDone.btns.some(function (t) { return /学下一章 List A2/.test(t); }) &&
  chDone.btns.some(function (t) { return /再刷一遍本章/.test(t); }) &&
  !chDone.btns.some(function (t) { return /开始学 \d+ 个新词/.test(t); }), chDone.btns);

const chNext = await js(`
  document.getElementById('go-nextch').click();
  await new Promise(r => setTimeout(r, 1000));
  return { curCh: CUR_CH, label: CHAPTERS[CUR_CH].label,
    first: NEW ? NEW.list[0] : null, a2head: CHAPTERS[1].words[0],
    sub: document.getElementById('study-sub-text').textContent };
`);
check('点「学下一章」才真的切到 A2', chNext.curCh === 1 && chNext.first === chNext.a2head && /List A2/.test(chNext.sub), chNext);

// (3) 第一章只剩 3 个没学：只学这 3 个，不夹带第二章的词
const chPart = await js(`
  S.progress = {}; S.pause = {}; S.session = null;
  var a1 = CHAPTERS[0].words;
  a1.slice(3).forEach(function (w) {
    S.progress[w] = { due: Date.now() + 86400e3, stability: 6, difficulty: 5, last: Date.now(),
      state: 2, lv: 2, wrong: 0, lastG: 3 };
  });
  save();
  show('books');
  await new Promise(r => setTimeout(r, 900));
  document.querySelector('${A1}').click();
  await new Promise(r => setTimeout(r, 350));
  var btn = document.getElementById('ch-study').textContent.trim();
  document.getElementById('ch-study').click();
  await new Promise(r => setTimeout(r, 900));
  return {
    btn: btn, n: NEW ? NEW.list.length : -1,
    allInA1: NEW ? NEW.list.every(function (w) { return a1.indexOf(w) >= 0; }) : false,
    first: NEW ? NEW.list[0] : null, a1first: a1[0],
    sub: document.getElementById('study-sub-text').textContent
  };
`);
check('第一章剩 3 个没学 → 只取这 3 个，不夹带第二章',
  chPart.n === 3 && chPart.allInA1 && chPart.first === chPart.a1first && /List A1/.test(chPart.sub), chPart);
check('还有词没学 → 按钮是「学习本章」', /学习本章/.test(chPart.btn), chPart.btn);

// ---------- 5f. 考试标签词：查词也能看到例句 / 搭配（v6.7） ----------
const exam = await js(`
  await ensureAllBooks();
  await ensureDict();
  var keys = window.VD_EXAM ? Object.keys(VD_EXAM) : [];
  var withS = keys.filter(function (k) { return VD_EXAM[k][1].length; });
  var w = withS[0];
  S.page = 'dict';
  document.getElementById('dict-search').value = w;
  renderDictResults();
  await new Promise(r => setTimeout(r, 400));
  var card = document.querySelector('.richcard');
  return {
    n: keys.length, s: withS.length,
    sent: card ? card.querySelectorAll('.exlist .sent').length : -1,
    subs: card ? Array.from(card.querySelectorAll('.rsub')).map(function (x) { return x.textContent; }) : [],
    w: w
  };
`);
check('通用字典挂上了考试标签词增强层（例句/搭配）', exam.n > 5000 && exam.s > exam.n * 0.9, { n: exam.n, 有例句: exam.s });
check('查一个考试标签词：词条卡直接给出例句块（真题优先）', exam.sent >= 1 && exam.subs.some(function (x) { return x === '例句' || x.indexOf('真题例句') === 0; }), { w: exam.w, sent: exam.sent, subs: exam.subs });

const context = await js(`
  await ensurePaper();
  const entry = WORDS.find(function (item) {
    const q = ctxPrompt(item);
    return q && q.sentence[3] && q.sentence[1];
  });
  await startPhase('drill', { words: [entry[0]], mode: 'ctx' });
  const source = contextQuestion.sentence;
  const clean = blankOut('A capability is different from a capital.', 'capable') === null &&
    blankOut("I can't say.", 'can') === null && blankOut('Can we test it?', 'can') === '_____ we test it?';
  document.getElementById('ctx-hint').click();
  document.getElementById('spell').value = entry[0];
  checkSpell();
  const answer = document.querySelector('.ctx-answer');
  return {
    clean: clean, hint: ATTEMPT.hint && pendingSpell === 2,
    same: answer.querySelector('.en').textContent === source[0],
    mark: answer.querySelector('.target-word').textContent.toLowerCase() === entry[0],
    url: answer.querySelector('a.ssrc').href === source[3],
    translation: !answer.querySelector('details').open && answer.querySelector('summary').textContent.includes('机翻')
  };
`);
check('语境填空排除词形误匹配，提示按较低评分', context.clean && context.hint, context);
check('语境反馈复用原句，标出目标词、原文和机翻', context.same && context.mark && context.url && context.translation, context);

const extraNew = await js(`
  S.settings.newPerDay = 0;
  S.settings.reviewMode = 'wrong';
  S.session = null;
  S.studyPaused = {};
  for (const p of Object.values(S.progress)) p.due = Date.now() + DAY;
  renderHero();
  document.querySelector('#hero-switch [data-lane="review"]').click();
  const reviewDisabled = document.getElementById('hero-start').disabled;
  await startSession('review');
  const reviewStayed = !document.getElementById('hero').classList.contains('hidden');
  document.querySelector('#hero-switch [data-lane="new"]').click();
  const btn = document.getElementById('hero-start');
  const label = btn.textContent;
  btn.click();
  await new Promise(r => setTimeout(r, 250));
  return { label: label, actual: NEW && NEW.mode === 'intro' ? NEW.list.length : 0, reviewDisabled, reviewStayed };
`);
check('达到每日目标后仍可手动再学 10 个', /再学 10 个/.test(extraNew.label) && extraNew.actual === 10, extraNew);
check('复习无待办时停在复习入口', extraNew.reviewDisabled && extraNew.reviewStayed);

const separate = await js(`
  introNext();
  const newWord = current[0];
  const candidates = WORDS.filter(it => !NEW.list.includes(it[0]) && !isParked(it[0])).slice(0, 3);
  S.settings.reviewMode = 'all';
  for (const [i, [w]] of candidates.entries()) {
    S.progress[w] = { lv: 2, wrong: 0, due: Date.now() - (4 - i) * 10000 };
  }
  const switchTo = async function (lane) {
    document.querySelector('#study-switch [data-lane="' + lane + '"]').click();
    await new Promise(r => setTimeout(r, 180));
  };
  await switchTo('review');
  const reviewStarted = PHASE === 'review' && cardKind === 'recog' && QI === 0;
  selfAssess(true);
  document.getElementById('qnext').click();
  const reviewWord = current[0];
  await switchTo('new');
  const newResumed = PHASE === 'new' && NEW.pos === 1 && current[0] === newWord;
  await switchTo('review');
  const reviewResumed = PHASE === 'review' && QI === 1 && current[0] === reviewWord;
  document.getElementById('sub-today').click();
  return { reviewStarted, newResumed, reviewResumed, bothPaused: !!pausedStudy('new') && !!pausedStudy('review') };
`);
check('学新词和复习可独立切换并分别保留位置', Object.values(separate).every(Boolean), separate);

const guide = await js(`
  openSettings();
  document.getElementById('set-welcome-auto').click();
  const enabled = lsGet(WELCOME_KEY) === 'always';
  document.getElementById('set-welcome').click();
  const manual = !!document.getElementById('welcome-panel');
  document.getElementById('welcome-back').click();
  const remembered = document.getElementById('set-welcome-auto').checked;
  closeModal();
  return enabled && manual && remembered;
`);
await send('Page.reload', {});
let autoGuide = false;
for (let i = 0; i < 30 && !autoGuide; i++) {
  await wait(250);
  autoGuide = await js("return !!document.getElementById('welcome-done');");
}
check('设置可打开导览，也可开启下次启动显示', guide && autoGuide);
const pausedReload = await js(`
  closeModal();
  const saved = pausedStudy('new');
  const kept = saved && pausedStudy('review');
  if (kept) {
    document.querySelector('#hero-switch [data-lane="new"]').click();
    await startSession();
  }
  openSettings();
  document.getElementById('set-welcome-auto').click();
  closeModal();
  return !!kept && PHASE === 'new' && NEW.pos === saved.nw.pos && lsGet(WELCOME_KEY) === 'seen';
`);
check('两组暂停位置能跨刷新保留', pausedReload);

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
    return { icons: mf ? mf.icons.length : 0, display: mf && mf.display, sw: !!reg, cache: shell, entries: n, version: APP_VER };
  `);
  check('manifest 可读', pwa.icons >= 4 && pwa.display === 'standalone', pwa);
  check('Service Worker 预缓存与应用版本一致', pwa.sw && pwa.entries >= 8 && pwa.cache === 'vd-shell-' + pwa.version, pwa.cache);

  // 首次访问时页面尚未被 SW 接管，词库是直接走网络的；重载一次才会被 SWR 落进 data 缓存
  // 注意：只断言「应用正常起来了」——此刻可能停在封面（没有 .word），也可能续背（有 .word）
  const BOOTED = `return !!(document.querySelector('.word') || document.getElementById('hero-start'));`;
  await send('Page.reload', {});
  let reOk = false;
  for (let i = 0; i < 25 && !reOk; i++) {
    await wait(400);
    reOk = await js(BOOTED);
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

  // 断网后重载，应仍能正常启动（SW 兜底）
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload', {});
  let offOk = false;
  for (let i = 0; i < 20 && !offOk; i++) {
    await wait(400);
    offOk = await js(BOOTED);
  }
  const offDetail = offOk
    ? await js(`var w = document.querySelector('.word'); return w ? w.firstChild.textContent.trim() : (document.getElementById('hero-start') || {}).textContent || '封面';`)
    : '断网后没起来';
  check('断网重载仍可用', offOk, offDetail);
}

// ---------- 9. 运行时无报错 ----------
check('无 JS 异常/console.error', errors.length === 0, errors.slice(0, 3));

const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');

ws.close();
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(failed.length ? 1 : 0);
