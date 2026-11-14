/* 验证「App 壳直接加载线上地址」这条路走不走得通（v6.11.4 侦察用）
 *
 * 目的：APK / 桌面版如果 loadUrl 线上链接（而不是 file:// 单文件版），
 *      Origin 就变成发布域名 → 云端登录/同步可用；Service Worker 会把 20MB 词库
 *      缓存下来 → 之后断网也能用。本脚本用 CDP 把这两件事都验一遍。
 *
 *   node tools/probe-appmode.mjs
 *   node tools/probe-appmode.mjs "https://vocab-drill-12129.app.workbuddy.host/?sharecode=XXXX"
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] ||
  'https://vocab-drill-12129.app.workbuddy.host/?sharecode=46MZWZWZMD';
const PORT = 14620 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-appmode-'));
const BIN = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\chrome.exe'
].find(existsSync);
if (!BIN) { console.error('找不到 Edge/Chrome'); process.exit(2); }

const proc = spawn(BIN, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=420,900', 'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'js error');
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
  ok ? pass++ : fail++;
};

console.log('== A. 线上地址本身 ==');
await send('Page.navigate', { url: URL_ARG });
for (let i = 0; i < 80; i++) {
  const st = await js("document.readyState + '|' + !!document.querySelector('.brand-name')");
  if (String(st).startsWith('complete|true')) break;
  await wait(400);
}
const env = await js(`(function(){
  return { origin: location.origin, host: location.host, proto: location.protocol,
    ver: (typeof APP_VER!=='undefined'?APP_VER:''), standalone: !!window.VD_STANDALONE,
    sw: (typeof navigator.serviceWorker !== 'undefined') };
})()`);
check('页面真的打开了（Origin 是发布域名）', env.origin === 'https://vocab-drill-12129.app.workbuddy.host', env);
check('线上版不是单文件模式（VD_STANDALONE 未定义）', env.standalone === false, env.standalone);

console.log('\n== B. Service Worker 能否接管（离线前提）==');
const swReady = await js(`(async function(){
  try {
    if (!('serviceWorker' in navigator)) return { ok:false, why:'不支持 SW' };
    if (document.readyState !== 'complete') await new Promise(r=>window.addEventListener('load',r,{once:true}));
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('ready 超时 20s')), 20000))
    ]);
    const regs = await navigator.serviceWorker.getRegistrations();
    const cacheKeys = await caches.keys();
    let total = 0; const per = {};
    for (const k of cacheKeys) {
      const c = await caches.open(k);
      const ks = await c.keys();
      per[k] = ks.length; total += ks.length;
    }
    return { ok:true, scope: reg.scope, active: !!reg.active, n: regs.length, cacheKeys, total, per };
  } catch (e) { return { ok:false, why:String(e.message||e) }; }
})()`);
check('Service Worker 已激活', swReady.ok === true && swReady.active === true, swReady);

console.log('\n== C. 词库是否进了缓存（SW 接管后再加载一次）==');
// 首次访问时页面资源先于 SW 激活，词库请求没被拦截；真实用户路径是「联网用一会儿再断网」，
// 所以这里 reload 一次，让 SW 接管后重新请求词库，再看 DATA 缓存。
await send('Page.reload', { ignoreCache: false });
await wait(1500);
for (let i = 0; i < 40; i++) {
  const ok = await js("document.readyState + '|' + !!document.querySelector('.brand-name')");
  if (String(ok).startsWith('complete|true')) break;
  await wait(400);
}
await wait(2500);   // 给 stale-while-revalidate 的 put 一点时间
const cached = await js(`(async function(){
  const keys = await caches.keys(); const hit = []; const per = {};
  for (const k of keys) { const c = await caches.open(k); const reqs = await c.keys();
    per[k] = reqs.length;
    for (const req of reqs) {
      const u = req.url;
      if (/data\\/(cet6|kaoyan|dict|paper|exam)\\.js/.test(u)) hit.push(u.split('/').pop());
    } }
  return { hit: [...new Set(hit)], per };
})()`);
check('核心词库已在 SW 缓存里', Array.isArray(cached.hit) && cached.hit.length >= 2, cached);

console.log('\n== D. 云端 SDK 与登录前置条件 ==');
// SDK 现在是「自托管副本优先 + CDN 兜底」。自托管那条要线上部署 6.11.4 之后才为 true，
// 所以分开断言，别把「还没发布」误报成「功能坏了」。
const sdk = await js(`(async function(){
  const out = { local: null, cdn: null };
  try {
    const r = await fetch('js/vendor/cloud-sdk.js', { cache: 'no-store' });
    const t = await r.text();
    out.local = { status: r.status, bytes: t.length, hasFactory: /createWorkBuddyCloud/.test(t) };
  } catch (e) { out.local = { err: String(e.message||e) }; }
  try {
    const r = await fetch('https://fastly.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js');
    const t = await r.text();
    out.cdn = { status: r.status, bytes: t.length, hasFactory: /createWorkBuddyCloud/.test(t) };
  } catch (e) { out.cdn = { err: String(e.message||e) }; }
  return out;
})()`);
check('自托管 SDK 可下载（部署 6.11.4 后应为 true）',
  !!(sdk.local && sdk.local.status === 200 && sdk.local.hasFactory), sdk.local);
check('CDN 镜像兜底可用',
  !!(sdk.cdn && sdk.cdn.status === 200 && sdk.cdn.hasFactory), sdk.cdn);
const gate = await js(`(function(){
  try { return { ok: /[?&]cloud=1/.test(location.search) || location.origin === 'https://vocab-drill-12129.app.workbuddy.host' }; }
  catch(e) { return { ok:false, err:String(e) }; }
})()`);
check('cloudOriginOk() 判定为可用', gate.ok === true, gate);

console.log('\n== E. 断网后还能不能用（离线能力）==');
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1
});
await send('Page.reload', { ignoreCache: false });
await wait(1200);
for (let i = 0; i < 40; i++) {
  const ok = await js("document.readyState + '|' + !!document.querySelector('.brand-name')");
  if (String(ok).startsWith('complete|true')) break;
  await wait(400);
}
const off = await js(`(function(){
  const b = document.querySelector('.brand-name');
  const books = (window.VD_DATA && Object.keys(window.VD_DATA)) || [];
  let words = 0;
  try { if (books.length && window.VD_DATA[books[0]].words) words = window.VD_DATA[books[0]].words.length; } catch(e){}
  return { ready: document.readyState, brand: b ? b.textContent.trim() : '',
    books, words,
    start: !!document.querySelector('.hero-start, #btn-start, .big') };
})()`);
check('断网重载后页面仍渲染（走 SW 缓存）', off.brand === '唯单词' && off.ready === 'complete', off);
check('断网后词库仍可用（能读到词表）', off.words > 3000, { books: off.books, words: off.words });
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
});

console.log('\n' + (fail === 0
  ? '全部通过：壳直接加载线上地址可行（Origin 正确 + 离线可用 + 云端可登录）'
  : pass + ' 通过 / ' + fail + ' 失败'));

ws.close(); proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
