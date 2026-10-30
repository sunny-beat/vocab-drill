/* 截图脚本：用 CDP 走一遍封面 / 识别答题 / 答错反馈 / 拼写，落到 _tmp/shots/。
 *
 * 用法（先起 http 服务器）：
 *   node tools/shots.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8642/index.html';
const OUT = path.resolve('_tmp/shots');
mkdirSync(OUT, { recursive: true });
const PORT = 9733 + (process.pid % 200);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-shot-'));

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
  '--force-device-scale-factor=2', '--window-size=900,1000', 'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
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
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
  return r.result?.result?.value;
}
async function shot(name, preWait) {
  await wait(preWait == null ? 400 : preWait);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const p = path.join(OUT, name + '.png');
  writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  console.log('  saved', p);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: URL_ARG });
for (let i = 0; i < 40; i++) { if (await js('return !!document.getElementById("hero-start");')) break; await wait(400); }

await shot('01-hero');
await js('document.getElementById("hero-start").click(); return 1;');
for (let i = 0; i < 30; i++) { if (await js('return !!document.querySelector("#qopts .qopt");')) break; await wait(300); }
await shot('02-recog');

await js(`
  var wi = quizOpts.findIndex(function (o) { return !o.ok; });
  document.querySelectorAll('#qopts .qopt')[wi].click();
  return 1;
`);
await shot('03-recog-wrong');

await js(`
  var nd = document.getElementById('qnext');
  if (nd) nd.click();
  await new Promise(r => setTimeout(r, 500));
  var wi = quizOpts.findIndex(function (o) { return o.ok; });
  document.querySelectorAll('#qopts .qopt')[wi].click();
  return 1;
`);
await shot('04-recog-right', 120);

// 答完 → 上一个：退回去那张卡，tagline 里应同时出现「下一个 ↪」
await js(`
  var nd = document.getElementById('qnext');
  if (nd) nd.click();
  await new Promise(r => setTimeout(r, 600));
  var pb = document.getElementById('prevbtn');
  if (pb) pb.click();
  return 1;
`);
await shot('05-recog-back');

await js(`
  var nd = document.getElementById('qnext');
  if (nd) nd.click();
  await new Promise(r => setTimeout(r, 500));
  document.querySelector('#modeseg button[data-mode="spell"]').click();
  return 1;
`);
await shot('06-spell');

await js('document.getElementById("skip").click(); return 1;');
await shot('07-spell-answer');

await js(`
  document.getElementById('next').click();
  await new Promise(r => setTimeout(r, 400));
  document.querySelector('[data-page="books"]').click();
  return 1;
`);
await wait(1600);
await shot('08-books');

ws.close();
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
