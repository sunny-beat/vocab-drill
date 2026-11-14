/* 单文件版体检：确认「拷到别的地方、双击就能用」。
 *
 * 断言：没有外链资源 / 两本词库都在内存里 / 封面 → 教学卡 → 四选一 全链路可走 / 切词书有效 / 无 JS 异常。
 *
 *   node tools/smoke-standalone.mjs                 # 默认测根目录「唯单词.html」（file:// 直开）
 *   node tools/smoke-standalone.mjs "D:/x.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE = process.argv[2] || path.resolve('唯单词.html');
if (!existsSync(FILE)) { console.error('找不到单文件版：' + FILE + '（先跑 node tools/build_standalone.mjs）'); process.exit(2); }
const URL_ARG = pathToFileURL(path.resolve(FILE)).href;
const PORT = 13700 + (process.pid % 90);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-standalone-'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
if (!bin) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const proc = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1280,860', 'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* 没起来 */ }
    await wait(250);
  }
  throw new Error('devtools 未就绪');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pending = new Map();
const errs = [], failed = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errs.push('[console] ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Network.loadingFailed') {
    failed.push(m.params.errorText + ' @' + (m.params.requestId || ''));
  }
});
function send(method, params = {}) {
  const id = ++n; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}
async function js(expr) {
  const r = await send('Runtime.evaluate', {
    expression: '(async function(){' + expr + '})()', returnByValue: true, awaitPromise: true
  });
  const d = r.result;
  if (d?.exceptionDetails) throw new Error(d.exceptionDetails.exception?.description || d.exceptionDetails.text);
  return d?.result?.value;
}
async function until(expr, tries = 60) {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(250); }
  return false;
}
function check(name, cond, info) {
  console.log((cond ? '  ok    ' : '  FAIL  ') + name + (info === undefined ? '' : '  → ' + JSON.stringify(info)));
  if (!cond) process.exitCode = 1;
}

await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ARG });

const booted = await until('return !!document.getElementById("hero-start");', 80);
if (booted) await js('if (document.getElementById("welcome-done")) document.getElementById("welcome-done").click();');
check('单文件双击能起来（file:// 直开）', booted, { url: URL_ARG, kb: Math.round(statSync(FILE).size / 1024) });
if (!booted) {
  console.log('ERRS', JSON.stringify(errs));
  ws.close(); proc.kill(); process.exit(1);
}

/* 1. 没有任何外链资源 */
const ext = await js(`
  return {
    css: document.querySelectorAll('link[rel="stylesheet"]').length,
    scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src')),
    manifest: !!document.querySelector('link[rel="manifest"]'),
    ico: (document.querySelector('link[rel="icon"]') || {}).href || ''
  };
`);
check('没有外链 CSS / 脚本（拷走也不缺文件）',
  ext.css === 0 && ext.scripts.length === 0 && !ext.manifest, ext);
check('favicon 是内联 data URI', ext.ico.indexOf('data:image/svg+xml') === 0, ext.ico.slice(0, 40) + '…');

/* 2. 两本词库都内联在内存里 */
const books = await js(`
  return {
    ids: Object.keys(window.VD_DATA || {}),
    cet6: (window.VD_DATA && VD_DATA.cet6) ? VD_DATA.cet6.words.length : 0,
    kaoyan: (window.VD_DATA && VD_DATA.kaoyan) ? VD_DATA.kaoyan.words.length : 0,
    standalone: !!window.VD_STANDALONE,
    sw: !!navigator.serviceWorker.controller
  };
`);
check('两本词库都在文件里', books.cet6 > 4000 && books.kaoyan > 4000, books);
check('标记为单文件版（不去注册 Service Worker）', books.standalone === true && books.sw === false, books);

/* 3. 封面 → 教学卡 → 四选一 */
const start = await js(`
  document.getElementById('hero-start').click();
  await new Promise(r => setTimeout(r, 900));
  var c = document.getElementById('card');
  return {
    intro: !!document.querySelector('.card.intro'),
    word: document.querySelector('.word') ? document.querySelector('.word').firstChild.textContent.trim() : '',
    defs: c.querySelectorAll('.meaning .dline').length,
    sents: c.querySelectorAll('.meaning .sent').length
  };
`);
check('点开始能出教学卡（词库真的读到了）',
  start.intro && !!start.word && start.defs >= 1 && start.sents >= 1, start);

const quiz = await js(`
  for (var i = 0; i < 10; i++) {
    if (document.querySelectorAll('#qopts .qopt').length) break;
    var b = document.getElementById('intro-next');
    if (!b) break;
    b.click();
    await new Promise(r => setTimeout(r, 260));
  }
  return {
    opts: document.querySelectorAll('#qopts .qopt').length,
    okN: (typeof quizOpts !== 'undefined') ? quizOpts.filter(function (o) { return o.ok; }).length : -1
  };
`);
check('四选一正常（4 项、恰好 1 个正确）', quiz.opts === 4 && quiz.okN === 1, quiz);

/* 4. 切词书：考研那本也能用 */
const switched = await js(`
  var sel = document.getElementById('book');
  sel.value = 'kaoyan';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  return {
    book: S.settings.book,
    total: (VD_DATA.kaoyan ? VD_DATA.kaoyan.words.length : 0),
    heading: document.querySelector('#hero h1') ? document.querySelector('#hero h1').textContent.trim() : ''
  };
`);
check('切到考研词书正常', switched.book === 'kaoyan' && switched.total > 4000, switched);

/* 5. 进度能存（file:// 下的 localStorage） */
const store = await js(`
  S.progress['__probe__'] = { due: Date.now(), stability: 1, difficulty: 5, last: Date.now(), state: 1, lv: 0, wrong: 0, lastWrong: 0, lastG: null };
  save();
  var raw = localStorage.getItem('vocabdrill.v2') || '';
  delete S.progress['__probe__']; save();
  return { saved: raw.indexOf('__probe__') >= 0, bytes: raw.length };
`);
check('进度能写进 localStorage', store.saved, { bytes: store.bytes });

check('无 JS 异常', errs.length === 0, errs.slice(0, 3));
check('无失败的网络请求（说明没有漏拷文件）', failed.length === 0, failed.slice(0, 3));

ws.close();
proc.kill();
await wait(400);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
