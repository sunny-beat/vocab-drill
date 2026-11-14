/* 验证云端 SDK 的加载链：优先自托管副本，挂了自动退到 CDN 镜像
 *
 * 背景：原来是硬编码单个 jsDelivr 地址，2026-11-09 实测该域名在国内直接 SSL 重置
 *      （curl exit 35，连 302 都拿不到），表现为「点登录没反应 / 提示网络错误」。
 *      现在改成 js/vendor/cloud-sdk.js 自托管 + 三个镜像兜底，这个探针验两件事：
 *        1) 本地副本能加载，且真的只走本地（不发外部请求）
 *        2) 把本地副本拦掉之后，能自动退到 CDN 镜像
 *
 *   node tools/probe-cloudsdk.mjs                      # 默认 http://127.0.0.1:8651
 *   node tools/probe-cloudsdk.mjs http://127.0.0.1:8651
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:8651').replace(/\/+$/, '');
const URL_ARG = BASE + '/index.html?cloud=1';
const PORT = 14760 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-sdk-'));
const BIN = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\chrome.exe'
].find(existsSync);
if (!BIN) { console.error('找不到 Edge/Chrome'); process.exit(2); }

const proc = spawn(BIN, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=900,760', 'about:blank'
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
await send('Network.enable');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
  ok ? pass++ : fail++;
};

async function boot() {
  for (let i = 0; i < 80; i++) {
    const st = await js("document.readyState + '|' + !!document.querySelector('.brand-name')");
    if (String(st).startsWith('complete|true')) return;
    await wait(400);
  }
  throw new Error('页面没起来，先确认本地服务在 ' + BASE);
}

console.log('== A. 加载链配置 ==');
await send('Page.navigate', { url: URL_ARG });
await boot();
const urls = await js('window.__vdCloud && window.__vdCloud.urls');
check('调试出口已挂上（?cloud=1）', Array.isArray(urls) && urls.length >= 2, urls);
check('第一顺位是自托管副本', Array.isArray(urls) && urls[0] === 'js/vendor/cloud-sdk.js', urls && urls[0]);
check('后面还有 CDN 兜底', Array.isArray(urls) && urls.slice(1).every(u => /^https:/.test(u)), urls && urls.slice(1));

console.log('\n== B. 正常情况下走本地副本 ==');
const local = await js(`(async function(){
  try {
    const c = await window.__vdCloud.load();
    const res = performance.getEntriesByType('resource')
      .filter(e => /cloud-sdk/.test(e.name))
      .map(e => ({ name: e.name, bytes: e.transferSize || e.decodedBodySize || 0 }));
    return { ok: !!c, hasDb: !!(c && c.database), res };
  } catch (e) { return { err: String(e.message || e) }; }
})()`);
check('SDK 加载成功并返回实例', local.ok === true && local.hasDb === true,
  { ok: local.ok, hasDb: local.hasDb, err: local.err });
check('只请求了本地副本（没走外网）',
  Array.isArray(local.res) && local.res.length >= 1 && local.res.every(r => !/^https?:/.test(r.name.replace(BASE, ''))),
  local.res);
check('本地副本体积正常（>60KB）',
  Array.isArray(local.res) && local.res.some(r => r.bytes > 60000), local.res && local.res.map(r => r.bytes));

console.log('\n== C. 本地副本挂掉时能退到 CDN 镜像 ==');
// 只拦本地这份，模拟「部署时漏传 / 文件被删」
await send('Network.setBlockedURLs', { urls: ['*js/vendor/cloud-sdk.js*'] });
await send('Page.reload', { ignoreCache: true });
await boot();
const fb = await js(`(async function(){
  try {
    const c = await window.__vdCloud.load();
    const names = performance.getEntriesByType('resource')
      .filter(e => /cloud-sdk/.test(e.name)).map(e => e.name);
    return { ok: !!c, hasDb: !!(c && c.database), names };
  } catch (e) { return { err: String(e.message || e) }; }
})()`);
const usedCdn = Array.isArray(fb.names) && fb.names.some(u => /jsdelivr|unpkg/.test(u));
check('本地被拦后仍加载成功', fb.ok === true && fb.hasDb === true, { ok: fb.ok, hasDb: fb.hasDb, err: fb.err });
check('确实退了 CDN（fastly/gcore/unpkg 之一）', usedCdn, fb.names);

await send('Network.setBlockedURLs', { urls: [] });

console.log('\n' + (fail === 0
  ? '全部通过：SDK 自托管可用，且 CDN 兜底生效'
  : pass + ' 通过 / ' + fail + ' 失败'));

ws.close(); proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
