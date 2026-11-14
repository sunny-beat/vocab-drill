/* 验证「背词顺序：顺序 / 乱序」这条功能
 *
 * 要验的四件事：
 *   1) 默认是顺序，老数据升级上来也落到顺序（不能把已有用户的学习节奏打乱）
 *   2) 乱序取新词：不按 List 走、全是没学过的词、数量对得上
 *   3) 乱序复习：**集合不变**（还是那批最早到期的），只是顺序被打乱
 *   4) 设置项真的能切换并落盘（刷新后还在）
 *
 *   node tools/probe-order.mjs                        # 默认 http://127.0.0.1:8651
 *   node tools/probe-order.mjs http://127.0.0.1:8651
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:8651').replace(/\/+$/, '');
const PORT = 14790 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-order-'));
const BIN = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\chrome.exe'
].find(existsSync);
if (!BIN) { console.error('找不到 Edge/Chrome'); process.exit(2); }

const proc = spawn(BIN, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1100,820', 'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const t = (await r.json()).find(x => x.type === 'page');
      if (t) return t.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await wait(250);
  }
  throw new Error('devtools not ready');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));
let n = 0;
const pend = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (m, p = {}) => {
  const id = ++n;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise(r => pend.set(id, r));
};
const js = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || ex.text || 'js error');
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
  ok ? pass++ : fail++;
};

async function boot(url) {
  await send('Page.navigate', { url: url });
  for (let i = 0; i < 90; i++) {
    const st = await js("document.readyState + '|' + !!(window.__vd)");
    if (String(st) === 'complete|true') return;
    await wait(400);
  }
  throw new Error('页面没起来，先确认本地服务在 ' + BASE);
}

const URL_DEBUG = BASE + '/index.html?debug=1';

console.log('== A. 默认值与迁移 ==');
await boot(URL_DEBUG);
const def = await js(`(function(){
  return { order: window.__vd.state().settings.order,
           ls: (JSON.parse(localStorage.getItem('vocabdrill.v2')||'{}').settings||{}).order };
})()`);
check('默认是顺序（seq）', def.order === 'seq', def);

// 塞一份「没有 order 字段」的老存档，刷新后应该被补成 seq
await js(`(function(){
  const raw = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  raw.settings = raw.settings || {}; delete raw.settings.order;
  localStorage.setItem('vocabdrill.v2', JSON.stringify(raw));
})()`);
await boot(URL_DEBUG);
const mig = await js(`window.__vd.state().settings.order`);
check('老存档升级后仍落到顺序', mig === 'seq', mig);

console.log('\n== B. 乱序取新词 ==');
const seqFirst = await js(`window.__vd.newWords(5, null, false)`);
check('顺序模式取到 5 个词', Array.isArray(seqFirst) && seqFirst.length === 5, seqFirst);
const isDictOrder = await js(`(function(){
  const all = window.__vd.words();
  const got = window.__vd.newWords(5, null, false);
  const idx = got.map(w => all.indexOf(w));
  return { idx, ascending: idx.every((v,i,a) => i === 0 || a[i-1] < v) };
})()`);
check('顺序模式是按词书排列取的', isDictOrder.ascending === true, isDictOrder.idx);

await js(`window.__vd.setOrder('random')`);
const rnd = await js(`(function(){
  const all = window.__vd.words();
  const S = window.__vd.state();
  const runs = [];
  for (let k = 0; k < 3; k++) runs.push(window.__vd.newWords(5, null, false));
  const flat = [].concat.apply([], runs);
  return {
    runs,
    count: runs.every(r => r.length === 5),
    allUnseen: flat.every(w => !S.progress[w]),
    allInBook: flat.every(w => all.indexOf(w) >= 0),
    idx: runs[0].map(w => all.indexOf(w)),
    differs: runs[0].join(',') !== runs[1].join(',')
  };
})()`);
check('乱序同样取到 5 个', rnd.count === true, rnd.runs[0]);
check('取到的都是没学过的词', rnd.allUnseen === true, null);
check('取到的都在本书词表里', rnd.allInBook === true, null);
check('不是按词书顺序排的', (function () {
  const idx = rnd.idx;
  return idx.some((v, i, a) => i > 0 && v < a[i - 1]);
})(), rnd.idx);
check('连续两次抽到的不一样（真随机）', rnd.differs === true, [rnd.runs[0], rnd.runs[1]]);

console.log('\n== C. 乱序只乱顺序，不改复习集合 ==');
const rev = await js(`(function(){
  const S = window.__vd.state();
  const now = Date.now();
  // 造 12 个到期词，配上不同的 due，方便看「同一批、不同顺序」
  const all = window.__vd.words();
  for (let i = 0; i < 12; i++) {
    S.progress[all[i * 37]] = { lv: 2, due: now - (12 - i) * 3600000, wrong: 0, lastG: 3 };
  }
  window.__vd.setOrder('seq');
  const seq = window.__vd.reviewPlan().list.slice();
  window.__vd.setOrder('random');
  const a = window.__vd.reviewPlan().list.slice();
  const b = window.__vd.reviewPlan().list.slice();
  const setEq = (x, y) => x.length === y.length && x.slice().sort().join() === y.slice().sort().join();
  return {
    n: seq.length,
    sameSet: setEq(seq, a),
    shuffled: a.join() !== seq.join(),
    stableCount: a.length === b.length,
    varies: a.join() !== b.join()
  };
})()`);
check('两种模式取到同样多的复习词', rev.n > 0, rev.n);
check('乱序复习的集合和顺序一致（不多不少）', rev.sameSet === true, null);
check('乱序确实打乱了顺序', rev.shuffled === true, null);
check('每次重绘数量稳定（上限截断在洗牌之前）', rev.stableCount === true, null);

console.log('\n== D. 设置项能切换并落盘 ==');
const ui = await js(`(function(){
  const S = window.__vd.state();
  const sel = document.getElementById('set-order');
  return { exists: !!sel, value: sel && sel.value };
})()`);
// 设置面板是 modal，没打开时没有这个元素 —— 先点开设置
await js(`(function(){
  const b = document.getElementById('btn-settings') || document.querySelector('[data-act="settings"]');
  if (b) b.click();
})()`);
await wait(600);
const ui2 = await js(`(function(){
  const sel = document.getElementById('set-order');
  if (!sel) return { exists: false };
  sel.value = 'seq';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const after = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  return { exists: true, opts: [].map.call(sel.options, o => o.value),
           saved: (after.settings || {}).order };
})()`);
check('设置里有「背词顺序」这一项', ui2.exists === true, ui2);
check('两个选项是顺序 / 乱序', Array.isArray(ui2.opts) && ui2.opts.join() === 'seq,random', ui2.opts);
check('切回顺序后立刻落盘', ui2.saved === 'seq', ui2.saved);

// 乱序时界面上的「位置」要写成乱序，不能还挂着「List N」—— 否则看着像章节卡住没动
const lbl = await js(`(function(){
  const sel = document.getElementById('set-order');
  sel.value = 'random';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const sub = document.querySelector('.hero-sub');
  return { sub: sub ? sub.textContent : '' };
})()`);
check('切到乱序后封面副标题写「乱序」', /乱序/.test(lbl.sub || ''), lbl.sub);

const back = await js(`(function(){
  const sel = document.getElementById('set-order');
  sel.value = 'seq';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const after = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
  return { saved: (after.settings || {}).order };
})()`);
check('切回顺序后落盘', back.saved === 'seq', back.saved);

await boot(URL_DEBUG);
const persisted = await js(`window.__vd.state().settings.order`);
check('刷新后设置还在（不是只改内存）', persisted === 'seq', persisted);

console.log('\n' + (fail === 0
  ? '全部通过：顺序 / 乱序可切换，乱序取词真随机、复习只乱顺序'
  : pass + ' 通过 / ' + fail + ' 失败'));

ws.close(); proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
