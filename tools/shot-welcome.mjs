/* 首启导览视觉复核（v6.11.1）
 * 用 CDP 的 Emulation.setDeviceMetricsOverride 真实模拟手机视口再截图。
 * 坑：headless 只给 --window-size=390,780 是没用的 —— Edge 有最小窗口宽度，
 *     页面会按 ~500px+ 布局，截图只裁到左边 390px，看起来像「右侧被切」。
 *   node tools/shot-welcome.mjs "http://127.0.0.1:8651/index.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14280 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-shot-welcome-'));
// v6.11.1 清理：_tmp/ 已删除，截图落到 tools/shots/（不存在就建）
const OUT = path.resolve(process.cwd(), 'tools', 'shots');
mkdirSync(OUT, { recursive: true });
const BIN = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\chrome.exe'
].find(existsSync);
if (!BIN) { console.error('找不到 Edge/Chrome'); process.exit(2); }

const proc = spawn(BIN, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1280,900', 'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await wait(250);
  }
  throw new Error('devtools not ready');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => { const id = ++n; ws.send(JSON.stringify({ id, method, params })); return new Promise(r => pend.set(id, r)); };
async function raw(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
const js = (b) => raw('(async function(){' + b + '})()');

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ARG });
for (let i = 0; i < 120; i++) { if (await raw('window.VD_BOOT_OK===1')) break; await wait(250); }

async function shot(name, metrics) {
  await send('Emulation.setDeviceMetricsOverride', metrics);
  await wait(350);
  const info = await js(`
    openWelcome(false);
    await new Promise(r=>setTimeout(r,350));
    const box = document.querySelector('.modal-box').getBoundingClientRect();
    const body = document.getElementById('modal-body');
    const done = document.getElementById('welcome-done').getBoundingClientRect();
    const keys = document.getElementById('welcome-keys').getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      box: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)],
      done: [Math.round(done.left), Math.round(done.top), Math.round(done.right), Math.round(done.bottom)],
      keys: [Math.round(keys.left), Math.round(keys.top), Math.round(keys.right), Math.round(keys.bottom)],
      scrollable: body.scrollHeight > body.clientHeight
    };
  `);
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  console.log(name + '  ' + JSON.stringify(info));
}

await shot('welcome-desktop.png', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await shot('welcome-mobile.png', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });

try { ws.close(); } catch (e) { /* ignore */ }
proc.kill();
await wait(400);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
