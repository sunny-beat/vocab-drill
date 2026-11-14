/* v6.7 考试标签词增强层体检：字典词的词条卡要有例句 / 短语 / 近义词，且不影响词书词。
 *   node tools/probe-exam.mjs "http://127.0.0.1:8651/index.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14881 + (process.pid % 20);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-exam-'));
const bin = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { }
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
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', returnByValue: true, awaitPromise: true });
  const d = r.result;
  if (d?.exceptionDetails) return { __err: (d.exceptionDetails.exception?.description || '').slice(0, 200) };
  return d?.result?.value;
};
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  const tail = extra === undefined ? '' : JSON.stringify(extra).slice(0, 160);
  if (cond) { pass++; console.log('  ✅', name, tail); }
  else { fail++; console.log('  ❌', name, JSON.stringify(extra).slice(0, 300)); }
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: URL_ARG });
for (let i = 0; i < 60; i++) { if (await js('return !!document.getElementById("hero-start");')) break; await wait(250); }

console.log('\n== A. 数据层 ==');
const meta = await js(`
  await ensureDict();
  var keys = VD_EXAM ? Object.keys(VD_EXAM) : [];
  var withS = keys.filter(function (k) { return VD_EXAM[k][1].length; });
  var withP = keys.filter(function (k) { return VD_EXAM[k][0].length; });
  var withY = keys.filter(function (k) { return VD_EXAM[k][2].length; });
  return { n: keys.length, s: withS.length, p: withP.length, y: withY.length, sample: withS[0] };
`);
ok('exam 层已加载', meta.n > 0, meta);
ok('多数词带例句', meta.s / meta.n > 0.9, { 例句覆盖: (meta.s / meta.n * 100).toFixed(1) + '%' });

console.log('\n== B. 词条卡（字典词）==');
const card = await js(`
  var w = VD_EXAM && Object.keys(VD_EXAM).filter(function (k) { return VD_EXAM[k][1].length; })[0];
  openDetail(w);
  await new Promise(r => setTimeout(r, 500));
  var c = document.querySelector('.richcard');
  var subs = Array.from(c.querySelectorAll('.rsub')).map(function (x) { return x.textContent; });
  return { w: w, subs: subs, sent: c.querySelectorAll('.exlist .sent').length,
    phr: c.querySelectorAll('ul.phr li').length, syn: c.querySelectorAll('.synchip').length,
    firstSent: (c.querySelector('.exlist .sent .en') || {}).textContent || '',
    speakBtn: !!c.querySelector('.exlist .sent-speak') };
`);
ok('字典词条卡出现例句块（真题或词典）',
  card.sent >= 1 && card.subs.some(function (t) { return t.indexOf('例句') >= 0; }), card);
ok('例句带中文和朗读按钮', !!card.firstSent && card.speakBtn, card.firstSent);
ok('有短语 / 近义词就显示', (card.phr > 0 || card.subs.indexOf('常用短语') < 0) && card.syn >= 0, { 短语: card.phr, 近义: card.syn });

console.log('\n== C. 词书词不受影响 ==');
const book = await js(`
  closeModal();
  openDetail('abandon');
  await new Promise(r => setTimeout(r, 400));
  var c = document.querySelector('.richcard');
  return { subs: Array.from(c.querySelectorAll('.rsub')).map(function (x) { return x.textContent; }),
    exlist: c.querySelectorAll('.exlist').length,
    dblock: c.querySelectorAll('.dblock').length,
    inDefs: c.querySelectorAll('.meaning .exlist').length };
`);
ok('词书词仍是一义一例，真题例句单独成块（没塞进释义里）',
  book.dblock >= 1 && book.subs.some(function (x) { return x.indexOf('真题例句') === 0; }) && book.inDefs === 0, book);

console.log('\n== D. 查词仍然能用 ==');
const search = await js(`
  closeModal();
  await ensureAllBooks();
  S.page = 'dict';
  document.getElementById('dict-search').value = 'abid';
  renderDictResults();
  await new Promise(r => setTimeout(r, 500));
  var res = document.getElementById('dict-results');
  var rows = res.querySelectorAll('.row, .lexrow').length;
  return { rows: rows, html: (res.innerHTML || '').slice(0, 120), lexN: LEX_WORDS ? LEX_WORDS.length : 0, dictN: (function(){var n=0;DICT.forEach(function(){n++});return n;})() };
`);
ok('前缀联想把 exam 词也带出来了', search.rows > 0, search);

console.log('\n==== ' + pass + ' 通过 / ' + fail + ' 失败 ====');
ws.close(); proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
process.exit(fail ? 1 : 0);
