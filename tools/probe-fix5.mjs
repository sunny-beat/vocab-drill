/* v6.5 三件事的体检：
 *   A. 查词卡顺序：释义/例句在前，收藏与「已掌握/删除」在后
 *   B. 近义词点击：词书里没有、通用字典里有的词，点了要能打开详情（不再「未收录」）
 *   C. 发音兜底：没有 speechSynthesis 时（微信内置浏览器就是这样）要发出在线音频请求
 *
 *   node tools/probe-fix5.mjs "http://127.0.0.1:8651/index.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14821 + (process.pid % 20);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-fix5-'));
const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
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
let seq = 0; const pending = new Map();
const reqs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
});
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', returnByValue: true, awaitPromise: true });
  const d = r.result;
  if (d?.exceptionDetails) return { __err: (d.exceptionDetails.exception?.description || d.exceptionDetails.text || '').slice(0, 300) };
  return d?.result?.value;
};

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra === undefined ? '' : ' → ' + extra));
  if (!cond) fails++;
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ARG });
await wait(5000);

console.log('== A. 查词卡：内容在前，操作在后 ==');
const order = await js(`
  await ensureAllBooks();
  S.page = 'dict';
  document.getElementById('dict-search').value = 'abandon';
  renderDictResults();
  await new Promise(r => setTimeout(r, 400));
  var card = document.querySelector('.richcard');
  if (!card) return {err: 'no card'};
  var nodes = Array.prototype.slice.call(card.querySelectorAll('.meaning, .actions, .parkrow, .notebox, .phr, .syns'));
  return {
    seq: nodes.map(function (n) { return n.className; }),
    meaningFirst: nodes.length > 0 && nodes[0].className.indexOf('meaning') >= 0,
    meaningBeforeStar: !!(card.querySelector('.meaning') &&
      card.querySelector('.meaning').compareDocumentPosition(card.querySelector('#dc-star1')) & Node.DOCUMENT_POSITION_FOLLOWING),
    starBeforeNote: !!(card.querySelector('#dc-star1').compareDocumentPosition(card.querySelector('#dc-note')) & Node.DOCUMENT_POSITION_FOLLOWING)
  };
`);
ok('词条卡渲染出来了', !!(order && order.seq), '原样：' + JSON.stringify(order).slice(0, 300));
ok('释义块排在第一个（收藏/已掌握都在它后面）', !!(order && order.meaningFirst), order && order.seq && order.seq[0]);
ok('释义在「⭐ 收藏」之前', !!(order && order.meaningBeforeStar), '');
ok('收藏在「写我的释义」之前', !!(order && order.starBeforeNote), '');

console.log('\n== B. 近义词：词书没有、字典有，点了要能打开 ==');
const syn = await js(`
  await ensureAllBooks();
  /* 找一个近义词不在词书里的词，模拟用户点它 */
  var target = null, pick = null;
  for (var i = 0; i < WORDS.length && !target; i++) {
    var it = WORDS[i], sy = it[7] || [];
    for (var j = 0; j < sy.length; j++) {
      var s = String(sy[j]).toLowerCase();
      if (s === it[0]) continue;
      if (DICT.has(s)) continue;                 // 词书里有的不算，那个本来就通
      target = it[0]; pick = s; break;
    }
  }
  if (!target) return {err: '没有可测的样本'};
  await ensureDict();                            // 字典是懒加载的，先等它到位
  openDetail(target);
  await new Promise(r => setTimeout(r, 500));
  var chip = null;
  document.querySelectorAll('#modal-body .synchip').forEach(function (b) {
    if (!chip && b.dataset.w.toLowerCase() === pick) chip = b;
  });
  if (!chip) return {err: '卡片里没有这个近义词 chip', target: target, pick: pick};
  var dim = chip.classList.contains('dim');
  chip.click();
  await new Promise(r => setTimeout(r, 600));
  var body = document.getElementById('modal-body');
  var head = body.querySelector('.word');
  return {
    target: target, pick: pick, dimmed: dim,
    opened: !document.getElementById('modal').classList.contains('hidden'),
    shown: head ? head.textContent.replace(/\\s+/g, ' ').trim() : '',
    inLex: !!(LEX && LEX[pick])
  };
`);
ok('找到「近义词不在词书」的样本', !!(syn && syn.target), '原样：' + JSON.stringify(syn).slice(0, 300));
ok('这个近义词在通用字典里（所以应该能查）', !!(syn && syn.inLex), syn && JSON.stringify(syn.inLex));
ok('chip 没有被置灰', !!(syn && syn.dimmed === false), syn && String(syn.dimmed));
ok('点下去真的打开了详情，不是弹「未收录」', !!(syn && syn.opened && syn.shown.toLowerCase().indexOf(syn.pick) === 0),
  syn && syn.shown);

console.log('\n== C. 发音：一律走有道在线音频（v6.9.4 起不再用 speechSynthesis）==');
const noApi = await js(`
  /* 模拟微信内置浏览器：把 speechSynthesis 整个拿掉，看发音还能不能走 */
  try {
    Object.defineProperty(window, 'speechSynthesis', { get: function () { return undefined; }, configurable: true });
  } catch (e) { return {err: 'defineProperty 失败: ' + e.message}; }
  return { api: typeof window.speechSynthesis,
           usesSynth: /speechSynthesis|SpeechSynthesisUtterance/.test(String(speak) + String(speakAudio)) };
`);
ok('发音代码已经不碰 speechSynthesis（拿掉也不影响）', noApi && noApi.usesSynth === false, JSON.stringify(noApi));

const before = reqs.length;
await js(`
  S.page = 'study';
  document.querySelectorAll('.modal, #modal').forEach(function (m) { m.classList.add('hidden'); });
  speak('abandon');
  await new Promise(r => setTimeout(r, 1200));
  return 1;
`);
await wait(600);
const audioReqs = reqs.slice(before).filter(u => u.indexOf('dict.youdao.com') >= 0);
ok('发出了在线音频请求（有声音了，不是只弹提示）', audioReqs.length > 0,
  audioReqs.length ? audioReqs[0].slice(0, 90) : '（没有请求）');
ok('请求里带着要读的单词', audioReqs.some(u => u.indexOf('abandon') >= 0), '');

console.log('\n==== ' + (fails ? '失败 ' + fails + ' 项' : '全部通过') + ' ====');
try { ws.close(); } catch (e) { /* ignore */ }
try { proc.kill(); } catch (e) { /* ignore */ }
setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ } process.exit(fails ? 1 : 0); }, 300);
