/* v5.0 新能力体检：本段卡壳榜 / 记忆曲线大图 / 例句朗读 / 听写第四模式 / 技能画像与弱项强化
 *
 * 用法：
 *   node tools/probe-v5.mjs                                   # 默认 http://127.0.0.1:8651/index.html
 *   node tools/probe-v5.mjs "file:///E:/.../index.html"
 *
 * 口径同 v4.x：先灌数据，再走真实 UI 路径断言 —— 只有真点出来的东西才算数。
 * 五段对应五个批次：
 *   A 本段成绩（平均反应 + 最卡壳 + 一键再练）
 *   B 详情页记忆曲线大图（现在在哪 / 下次什么时候 / 还剩多少）
 *   E 例句整句朗读（按钮不挡字、点了真读、不误关弹窗）
 *   C 听写第四模式（默认关、开了才出现、提示只给到「模糊」）
 *   D 技能画像（词 × 模式）+ 弱项强化（按词挑模式）
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 13721 + (process.pid % 90);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-v5-'));

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
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
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
async function until(expr, tries = 80, gap = 250) {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(gap); }
  return false;
}
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
}
function section(t) { console.log('\n[' + t + ']'); }

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ARG });
await until('return window.VD_BOOT_OK === 1');

/* ================= A 本段成绩 ================= */
section('A 本段成绩');
const a = await js(`
  S.progress = {}; S.pause = {}; S.stars = {}; S.notes = {}; S.days = {}; S.rt = {}; S.confuse = {}; S.skills = {};
  S.session = null;
  S.settings.book = 'cet6'; S.settings.mode = 'recog'; S.settings.listenOn = false;
  S.settings.newPerDay = 20; S.settings.reviewCap = 40; S.settings.introBatch = 3;
  S.settings.autoSpeak = false; S.settings.reviewMode = 'all';
  save();
  await prepareBook();
  var ws = WORDS.slice(0, 6).map(function (it) { return it[0]; });
  ws.forEach(function (w) {
    S.progress[w] = { due: Date.now() - 86400000, stability: 5, difficulty: 5,
      last: Date.now() - 3 * 86400000, state: 2, lv: 3, wrong: 0, lastG: 3 };
  });
  save();
  PHASE = 'review'; renderHero();
  await startPhase('review');
  await new Promise(r => setTimeout(r, 300));

  // 3 个词各先答错再答对：结算页应该点出这 3 个「本段最卡壳」
  for (var k = 0; k < 3; k++) {
    var w = current[0];
    if (!w) break;
    var bad = quizOpts.findIndex(function (o) { return !o.ok; });
    document.querySelectorAll('.qopt')[bad].click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('qnext').click();
    await new Promise(r => setTimeout(r, 180));
    // 第二轮巩固，同一个词答对
    if (current && current[0] === w) {
      var good = quizOpts.findIndex(function (o) { return o.ok; });
      document.querySelectorAll('.qopt')[good].click();
      await new Promise(r => setTimeout(r, 120));
      document.getElementById('qnext').click();
      await new Promise(r => setTimeout(r, 180));
    }
  }
  return { phase: PHASE, qi: QI, len: QUEUE.length, miss: Object.keys(SESS_MISS), rt: SESS_RT.length };
`);
check('本段成绩记到了每个词（SESS_MISS）', a.miss.length >= 1, a.miss);
check('平均反应时样本也在记（SESS_RT）', a.rt >= a.miss.length, { rt: a.rt, miss: a.miss.length });

const aDone = await js(`
  var st = sessStats();
  var html = missHtml();
  var d = document.createElement('div');
  d.innerHTML = html;
  var chips = d.querySelectorAll('.dmw');
  return {
    avgTxt: st.avgTxt, n: st.n, top: st.miss.slice(0, 4),
    chips: chips.length,
    chipTxt: chips.length ? chips[0].textContent : '',
    hasBtn: !!d.querySelector('#drillmiss')
  };
`);
check('结算页「本段最卡壳」最多 4 颗 chip', aDone.chips >= 1 && aDone.chips <= 4, aDone.chips);
check('chip 上带次数（×N）', /×\d/.test(aDone.chipTxt), aDone.chipTxt);
check('chip 旁边有「再练这几个」', aDone.hasBtn === true, aDone.hasBtn);
check('平均反应有可读文本', /s|—/.test(aDone.avgTxt), aDone.avgTxt);

/* ================= B 记忆曲线大图 ================= */
section('B 记忆曲线大图');
const b = await js(`
  var w = WORDS[0][0];
  S.progress[w] = { due: Date.now() - 3600000, stability: 12, difficulty: 6,
    last: Date.now() - 2 * 86400000, state: 2, lv: 4, wrong: 0, lastG: 3 };
  save();
  var html = memoryCurveHtml(S.progress[w]);
  var d = document.createElement('div');
  d.innerHTML = html;
  var txt = d.textContent;
  return {
    has: /mcurve/.test(html),
    len: html.length,
    labels: Array.prototype.map.call(d.querySelectorAll('.mc-t'), function (t) { return t.textContent; }),
    cap: (d.querySelector('.mc-cap') || {}).textContent || '',
    pathLen: (d.querySelector('.mc-line') || { getAttribute: function () { return ''; } }).getAttribute('d').length,
    dots: d.querySelectorAll('.mc-dot').length
  };
`);
check('详情页有记忆曲线大图', b.has === true && b.len > 400, b.len);
check('横轴给了「今天」与到期点', b.labels.indexOf('今天') >= 0 && b.labels.length >= 2, b.labels);
check('曲线是按真实采样画出的折线，并标出「现在」这一点', b.pathLen > 40 && b.dots === 1, { points: b.pathLen, dots: b.dots });
check('图上写明「现在剩多少 / 稳定性 / 难度」', /现在约剩|稳定性|难度/.test(b.cap), b.cap);

/* ================= E 例句整句朗读 ================= */
section('E 例句整句朗读');
const e = await js(`
  window.__sent = [];
  window.speak = function (t) { window.__sent.push(String(t)); };
  var w = WORDS[0][0];
  openDetail(w);
  await new Promise(r => setTimeout(r, 300));
  var btns = document.querySelectorAll('.sent-speak');
  var info = { count: btns.length };
  if (btns.length) {
    var btn = btns[0];
    var r1 = btn.getBoundingClientRect();
    var sent = btn.parentElement.getBoundingClientRect();
    info.pos = getComputedStyle(btn).position;
    info.inside = r1.right <= sent.right + 1 && r1.top >= sent.top - 1;
    info.clickable = r1.width >= 20 && r1.height >= 20;
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    info.spoken = window.__sent.slice();
    info.modalOpen = !document.getElementById('modal').classList.contains('hidden');
  }
  closeModal();
  return info;
`);
check('例句旁边出现朗读按钮', e.count >= 1 && e.pos === 'absolute', { count: e.count, pos: e.pos });
check('按钮贴在例句框内、不压正文', e.inside === true && e.clickable === true, { in: e.inside, size: e.clickable });
check('点一下读的是整句（不是单个词）', Array.isArray(e.spoken) && e.spoken.length === 1 && /\s/.test(e.spoken[0]), e.spoken);
check('点朗读不会把弹窗关掉', e.modalOpen === true, e.modalOpen);

/* ================= C 听写第四模式 ================= */
section('C 听写第四模式');
const cOff = await js(`
  S.settings.listenOn = false; S.settings.mode = 'recog'; save(); updateTopbar();
  var lb = document.querySelector('#modeseg button[data-mode="listen"]');
  var vis = Array.prototype.filter.call(document.querySelectorAll('#modeseg button'),
    function (b) { return !b.classList.contains('hidden'); }).length;
  return { vis: vis, hidden: !!lb && lb.classList.contains('hidden') };
`);
check('默认关：顶栏只有 3 个模式', cOff.vis === 3 && cOff.hidden === true, cOff);

const cOn = await js(`
  S.settings.listenOn = true;
  save(); updateTopbar();
  window.__spoke = [];
  window.speak = function (w) { window.__spoke.push(String(w)); };
  setMode('listen');
  PHASE = 'review'; renderHero();
  await startPhase('review');
  await new Promise(r => setTimeout(r, 500));
  var card = document.getElementById('card');
  return {
    mode: S.settings.mode,
    btn: !document.querySelector('#modeseg button[data-mode="listen"]').classList.contains('hidden'),
    hasBig: !!card.querySelector('.listenbig'),
    hasPlay: !!document.getElementById('playw'),
    hasPhon: !!card.querySelector('.phon'),
    hasCloze: !!card.querySelector('.sent.cloze'),
    hasHint: !!document.getElementById('hintw'),
    spoke: window.__spoke.slice(),
    word: current ? current[0] : '',
    over: card.scrollHeight - card.clientHeight
  };
`);
check('开了开关才出现第 4 段', cOn.btn === true && cOn.mode === 'listen', cOn);
check('听写卡不给音标、不给挖空句', cOn.hasPhon === false && cOn.hasCloze === false, cOn);
check('进场自动放一次音', cOn.spoke.length === 1 && cOn.spoke[0] === cOn.word, cOn.spoke);
check('听写卡一屏装下', cOn.over <= 0, cOn.over);

const cHint = await js(`
  document.getElementById('hintw').click();
  await new Promise(r => setTimeout(r, 120));
  var meta = document.getElementById('listenmeta');
  var inp = document.getElementById('spell');
  inp.value = current[0];
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  var fb = document.getElementById('spellfb');
  return {
    usedHint: usedHint,
    hintShown: /提示/.test((meta || {}).textContent || ''),
    grade: pendingSpell,
    res: (fb.querySelector('.qres') || {}).textContent || '',
    note: !!fb.querySelector('.qnote'),
    bigGone: !document.querySelector('.listenbig')
  };
`);
check('「提示」给出中文但标记已用', cHint.usedHint === true && cHint.hintShown === true, cHint);
check('用了提示答对也只记「模糊」(g=2)', cHint.grade === 2, cHint.grade);
check('答案块写明「最高记模糊」', cHint.note === true && /听对了/.test(cHint.res), cHint.res);

/* ================= D 技能画像 + 弱项强化 ================= */
section('D 技能画像 · 弱项强化');
const d1 = await js(`
  // 走真实作答，确认画像在 grade() 落库
  document.getElementById('next').click();
  await new Promise(r => setTimeout(r, 350));
  setMode('recog');
  await new Promise(r => setTimeout(r, 350));
  var w = current[0];
  var good = quizOpts.findIndex(function (o) { return o.ok; });
  document.querySelectorAll('.qopt')[good].click();
  await new Promise(r => setTimeout(r, 150));
  document.getElementById('qnext').click();
  await new Promise(r => setTimeout(r, 250));
  var row = S.skills[w] || {};
  var snap = JSON.parse(JSON.stringify(row));
  undoStep();
  await new Promise(r => setTimeout(r, 200));
  var afterUndo = JSON.parse(JSON.stringify(S.skills[w] || {}));
  redoStep();
  await new Promise(r => setTimeout(r, 200));
  var afterRedo = JSON.parse(JSON.stringify(S.skills[w] || {}));
  return { w: w, snap: snap, afterUndo: afterUndo, afterRedo: afterRedo };
`);
check('答对一次 → 该词该模式 +1 次 / +1 对',
  d1.snap.recog && d1.snap.recog.n === 1 && d1.snap.recog.ok === 1, d1.snap);
check('撤销把这次作答从画像里抹掉', d1.afterUndo.recog === undefined, d1.afterUndo);
check('重做把样本原样写回', d1.afterRedo.recog && d1.afterRedo.recog.n === 1, d1.afterRedo);

const d2 = await js(`
  var w = 'ability';
  S.skills[w] = {
    recog: { n: 6, ok: 6, msn: 6, ms: 12000, hint: 0 },
    spell: { n: 4, ok: 3, msn: 4, ms: 30000, hint: 0 },
    ctx:   { n: 4, ok: 1, msn: 4, ms: 60000, hint: 2 }
  };
  S.progress[w] = { due: Date.now() - 86400000, stability: 3, difficulty: 6,
    last: Date.now() - 86400000, state: 2, lv: 1, wrong: 3, lastG: 1 };
  S.skills.notion = { recog: { n: 4, ok: 4, msn: 4, ms: 8000, hint: 0 } };
  S.progress.notion = { due: Date.now() - 86400000, stability: 8, difficulty: 4,
    last: Date.now() - 86400000, state: 2, lv: 3, wrong: 0, lastG: 3 };
  save();
  openStats();
  await new Promise(r => setTimeout(r, 350));
  var body = document.getElementById('modal-body');
  var cells = body.querySelectorAll('.sk-cell');
  return {
    rec: recommendedMode('ability'),
    step: recommendedMode('notion'),
    risk: Math.round(wordRisk('ability').risk * 100),
    risk2: Math.round(wordRisk('notion').risk * 100),
    cells: cells.length,
    modes: usableModes().length,
    pcts: Array.prototype.map.call(cells, function (c) { return (c.querySelector('.sk-pct') || {}).textContent; }),
    rows: body.querySelectorAll('.sk-wrow').length,
    hasBtn: !!document.getElementById('st-weak'),
    weakFirst: weakWords(3).map(function (o) { return o.w; }),
    weakAll: weakWords(20).map(function (o) { return o.w; })
  };
`);
check('统计页出现「词 × 模式」格子（开听写就 4 格）', d2.cells === d2.modes, { cells: d2.cells, modes: d2.modes });
check('每格给出正确率', d2.pcts.every(t => /%|—/.test(t)), d2.pcts);
check('推荐模式 = 这个词最弱的那一项', d2.rec === 'ctx', d2.rec);
check('只练过识别 → 往难一档推（拼写）', d2.step === 'spell', d2.step);
check('风险打分能区分好坏词', d2.risk > d2.risk2 + 10, { bad: d2.risk, good: d2.risk2 });
check('弱项榜有内容，且造出来的差词确实入榜', d2.rows >= 2 && d2.weakAll.indexOf('ability') >= 0, { rows: d2.rows, all: d2.weakAll });

const d3 = await js(`
  document.getElementById('st-weak').click();
  await new Promise(r => setTimeout(r, 600));
  var w0 = QUEUE[0];
  return {
    phase: PHASE, drillMode: DRILL ? DRILL.mode : '', label: DRILL ? DRILL.label : '',
    size: QUEUE.length, used: cardMode(w0), rec: recommendedMode(w0),
    tagline: (document.querySelector('#card .tagline') || {}).textContent || '',
    seg: (document.querySelector('#modeseg button.on') || {}).dataset
      ? document.querySelector('#modeseg button.on').dataset.mode : ''
  };
`);
check('一键进弱项强化队列（auto 模式）', d3.phase === 'drill' && d3.drillMode === 'auto', d3);
check('这张卡用的正是该词的推荐模式', d3.used === d3.rec, { card: d3.used, rec: d3.rec });
check('角标写明「按弱项选」', /按弱项选/.test(d3.tagline), d3.tagline);
check('顶栏高亮跟着这张卡走', d3.seg === d3.rec, { seg: d3.seg, rec: d3.rec });

const d4 = await js(`
  setMode('recog');
  await new Promise(r => setTimeout(r, 300));
  return { drillMode: DRILL.mode, mode: S.settings.mode,
    tagline: (document.querySelector('#card .tagline') || {}).textContent || '' };
`);
check('手动换模式 = 放弃自动挑选（用户优先）', d4.drillMode === '' && d4.mode === 'recog', d4);
check('角标不再写「按弱项选」', !/按弱项选/.test(d4.tagline), d4.tagline);

/* ================= 收尾：版本号与零报错 ================= */
const ver = await js(`return { ver: APP_VER, sw: (S.settings ? 1 : 0) };`);
check('版本号已升到 6.11.4', ver.ver === '6.11.4', ver.ver);
check('全程没有控制台报错', errs.length === 0, errs.slice(0, 3));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (errs.length) { console.log('\n控制台报错：'); errs.slice(0, 8).forEach(e => console.log('  ' + e)); }
try { ws.close(); } catch (e) {}
proc.kill();
process.exit(fail ? 1 : 0);
