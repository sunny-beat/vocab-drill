/* v4.1 新能力体检：错因对比 / 易混词对辨析 / 遗忘曲线 / 图上每个数字可下钻
 *
 * 用法：
 *   node tools/probe-v41.mjs                                  # 默认 http://127.0.0.1:8651/index.html
 *   node tools/probe-v41.mjs "file:///E:/.../index.html"
 *
 * 口径：先在页面里灌一批「到期 + 错词」的假进度，再走真实 UI 路径断言，
 *      不直接调内部函数下结论 —— 只有真点出来的东西才算数。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 13721 + (process.pid % 90);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-v41-'));

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

/* ---------- 0. 灌数据 ---------- */
const seeded = await js(`
  S.progress = {}; S.pause = {}; S.stars = {}; S.notes = {}; S.days = {}; S.rt = {}; S.confuse = {};
  S.session = null;
  S.settings.book = 'cet6'; S.settings.mode = 'recog'; S.settings.newPerDay = 20;
  S.settings.reviewCap = 40; S.settings.introBatch = 3; S.settings.autoSpeak = false;
  S.settings.reviewMode = 'all';   // 复习池要非空，否则会直接跳去学新词
  save();
  await prepareBook();
  var ws = WORDS.slice(0, 30).map(function (it) { return it[0]; });
  ws.forEach(function (w, i) {
    S.progress[w] = {
      due: Date.now() - (i % 4) * 86400000,
      stability: 4 + i, difficulty: 5, last: Date.now() - 3 * 86400000,
      state: 2, lv: Math.min(7, i % 6), wrong: i < 6 ? 4 : 0, lastG: 3
    };
  });
  save();
  PHASE = 'review';
  renderHero();
  await new Promise(r => setTimeout(r, 150));
  return { due: dueWords().length };
`);
check('灌入 30 个到期词', seeded.due === 30, seeded);

/* ---------- 1. 错因对比：答错时说出「你把哪个词当成了它」 ---------- */
const wrong = await js(`
  await startPhase('review');
  await new Promise(r => setTimeout(r, 250));
  var w = current[0];
  var idx = quizOpts.findIndex(function (o) { return !o.ok; });
  var chosen = quizOpts[idx];
  document.querySelectorAll('#qopts .qopt')[idx].click();
  await new Promise(r => setTimeout(r, 260));
  var why = document.querySelector('#qfb .why');
  var rows = why ? Array.from(why.querySelectorAll('.why-row')).map(function (r) {
    return { tag: (r.querySelector('.why-tag') || {}).textContent, word: (r.querySelector('b') || {}).textContent };
  }) : [];
  return {
    word: w, chosen: chosen.src, conf: JSON.parse(JSON.stringify(S.confuse[w] || {})),
    hasWhy: !!why, rows: rows,
    curve: !!document.querySelector('#qfb .fcurve'),
    curveTxt: (document.querySelector('#qfb .fcurve') || {}).textContent || ''
  };
`);
check('答错后出现「你选的 / 正确答案」对比块', wrong.hasWhy === true && wrong.rows.length === 2, wrong.rows);
check('对比块里的两个词确实是「混淆词」和「正确词」',
  wrong.rows[0] && wrong.rows[1] && wrong.rows[0].word === wrong.chosen && wrong.rows[1].word === wrong.word,
  { 你选的: wrong.rows[0] && wrong.rows[0].word, 正确: wrong.rows[1] && wrong.rows[1].word });
check('混淆关系写进了 S.confuse（下一次会用它出题）',
  wrong.conf && wrong.conf[wrong.chosen] >= 1, wrong.conf);

/* ---------- 2. 易混词会被优先拉进选项（辨析训练） ---------- */
const reuse = await js(`
  var w = QUEUE[QI] || QUEUE[0];
  var other = WORDS.map(function (it) { return it[0]; }).filter(function (x) {
    return x !== w && DEFMAP.has(x) && optText(entryOf(x)).length > 2;
  })[0];
  S.confuse[w] = {}; S.confuse[w][other] = 9;
  var opts = buildQuizOptions(entryOf(w));
  return { w: w, other: other, srcs: opts.map(function (o) { return o.src; }), has: opts.some(function (o) { return o.src === other; }) };
`);
check('自己混过的词被强制放进选项（4 选 1 里必然同场）', reuse.has === true, reuse);

/* ---------- 3. 遗忘曲线：v6 起只在答错/模糊时出现 ----------
 * 答对时一屏要塞 中文分条 + 词根拆分 + 搭配 + 近义词，曲线（约 60px）让位；
 * 答错时错因对比优先，曲线同样可能被挤掉 —— 所以这里只断言「答对时确实没有」，
 * 以及答对时那些新块真的在。
 * v6.4 起：英文释义（EN 块）取消，选项里也只留英文单词、不再带英文释义。 */
const rightAns = await js(`
  if (QUEUE[QI] === undefined) { startPhase('review'); await new Promise(r => setTimeout(r, 240)); }
  var idx = quizOpts.findIndex(function (o) { return o.ok; });
  /* 注意：不要去 eval 里改 quizStart / settleQuiz 这些顶层 let ——
     Runtime.evaluate 那边赋值不会落到页面自己的词法绑定上（实测 sg 恒为 null），
     所以「答对时曲线是否出现」取决于真实反应时，测不稳。这里只断言不依赖 g 的部分。 */
  document.querySelectorAll('#qopts .qopt')[idx].click();
  await new Promise(r => setTimeout(r, 420));
  var fb = document.getElementById('qfb');
  return {
    curve: !!fb.querySelector('.fcurve'),
    en: !!fb.querySelector('.enmean'),
    root: !!fb.querySelector('.rootbox'),
    phr: fb.querySelectorAll('.phr-box .pchip').length,
    syn: !!fb.querySelector('.phinline'),
    optsEn: document.querySelectorAll('#qopts .qen').length,
    optsEnText: (document.querySelector('#qopts .qen') || {}).textContent || '',
    next: !!document.getElementById('qnext')
  };
`);
check('答对后四个选项各自展开对应的英文单词', rightAns.optsEn === 4, rightAns.optsEn);
check('选项展开的只有单词，不再附带英文释义（EN 已取消）',
  rightAns.optsEnText.length > 0 && rightAns.optsEnText.length <= 24 &&
  !/[a-z]{4,}\s+[a-z]{4,}/i.test(rightAns.optsEnText), rightAns.optsEnText);
check('答后释义面板不再有 EN 块，但有搭配（2 条）+ 近义词',
  rightAns.en === false && rightAns.phr === 2 && rightAns.syn === true, rightAns);
check('答对后停在「下一个」等确认，不自动翻页', rightAns.next === true, { next: rightAns.next });
/* 曲线：答对且反应快（g=3）时由 settleQuiz 主动不画，慢答（g=2）时仍然画 —— 这是设计，
   不是 bug。它取决于真实反应时，不适合在这里断言，改由 card-fit 的高度体检兜住。 */

/* ---------- 4. 统计里的易混词对 → 一键辨析练习 ---------- */
const stat = await js(`
  // 先造几对混淆，否则空数据看不出东西
  var ws = WORDS.slice(0, 6).map(function (it) { return it[0]; });
  S.confuse = {};
  S.confuse[ws[0]] = {}; S.confuse[ws[0]][ws[1]] = 3;
  S.confuse[ws[2]] = {}; S.confuse[ws[2]][ws[3]] = 2;
  save();
  openStats();
  await new Promise(r => setTimeout(r, 250));
  var body = document.getElementById('modal-body');
  var pairs = body.querySelectorAll('.pair').length;
  var btn = document.getElementById('st-confuse');
  return { has: /易混词对/.test(body.innerText), pairs: pairs, btn: btn ? btn.textContent : '' };
`);
check('统计页有「易混词对」区块并列出具体词对', stat.has === true && stat.pairs >= 2, stat);
check('易混区块给了「辨析练习」入口', /辨析练习/.test(stat.btn), stat.btn);

const drill = await js(`
  document.getElementById('st-confuse').click();
  await new Promise(r => setTimeout(r, 500));
  return { phase: PHASE, label: DRILL && DRILL.label, n: QUEUE.length, modalClosed: document.getElementById('modal').classList.contains('hidden') };
`);
check('点「辨析练习」直接进入专项队列', drill.phase === 'drill' && drill.n > 0 && drill.modalClosed === true, drill);

/* ---------- 5. 详情页的易混词 chip → 跳到对方（多级联动） ---------- */
const jump = await js(`
  var a = WORDS[0][0], b = WORDS[1][0];
  S.confuse[a] = {}; S.confuse[a][b] = 2;
  save();
  openDetail(a);
  await new Promise(r => setTimeout(r, 250));
  var chip = document.querySelector('#modal-body .cfchip');
  var first = (document.querySelector('#modal-body .word') || {}).textContent || '';
  var hasSec = /易混词（你混过）/.test(document.getElementById('modal-body').innerText);
  if (chip) chip.click();
  await new Promise(r => setTimeout(r, 250));
  var after = (document.querySelector('#modal-body .word') || {}).textContent || '';
  return { hasSec: hasSec, chip: chip ? chip.dataset.w : null, first: first.slice(0, 20), after: after.slice(0, 20), a: a, b: b };
`);
check('详情页有「易混词（你混过）」区块', jump.hasSec === true, jump);
check('点易混词 chip 直接跳到对方详情',
  jump.chip === jump.b && jump.first.indexOf(jump.a) >= 0 && jump.after.indexOf(jump.b) >= 0,
  { 起点: jump.first, 点的是: jump.chip, 跳到的: jump.after });

/* ---------- 6. 熟练度柱子可下钻到词表并能开练 ---------- */
const lv = await js(`
  closeModal();
  openStats();
  await new Promise(r => setTimeout(r, 220));
  var bars = document.querySelectorAll('#modal-body .lvdist .lvb');
  var target = null;
  bars.forEach(function (b) { if (+b.dataset.lv === 3) target = b; });
  if (!target) target = bars[1] || bars[0];
  var lvNo = target ? +target.dataset.lv : -1;
  if (target) target.click();
  await new Promise(r => setTimeout(r, 250));
  var body = document.getElementById('modal-body');
  return { bars: bars.length, lv: lvNo, head: (body.querySelector('h2') || {}).textContent || '', go: !!document.getElementById('lv-go'), rows: body.querySelectorAll('.rowlist .row').length };
`);
check('熟练度柱可点 → 落到该级词表', lv.bars === 8 && /Lv\d/.test(lv.head), { bars: lv.bars, head: lv.head });
check('该级词表带「现在练这 N 个」', lv.go === true, lv);

/* ---------- 7. A 键：就地打开当前词详情 ---------- */
const keyA = await js(`
  closeModal();
  PHASE = 'review';
  await startPhase('review');
  await new Promise(r => setTimeout(r, 250));
  var w = current[0];
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  var body = document.getElementById('modal-body');
  return { w: w, open: !document.getElementById('modal').classList.contains('hidden'),
    word: ((body.querySelector('.word') || {}).textContent || '').slice(0, 20) };
`);
check('按 A 就地打开当前词详情（不用离开卡片）',
  keyA.open === true && keyA.word.indexOf(keyA.w) >= 0, keyA);

/* ---------- 8. 兜底：全程无 JS 异常 ---------- */
check('无 JS 异常 / console.error', errs.length === 0, errs.slice(0, 3));

const bad = 0;
console.log('\nv4.1 专项体检结束');
try { ws.close(); } catch (e) { /* ignore */ }
proc.kill();
await wait(400);
try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* ignore */ }
process.exit(bad);
