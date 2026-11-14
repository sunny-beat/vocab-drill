/* 首屏体检：量封面高度，看「开始」按钮在常见窗口尺寸下是否需要滚动才能点到。
 * 改封面结构 / 加任务块之后跑一遍，比对着截图目测靠谱。
 *
 * 用法：
 *   node tools/hero-fit.mjs                                  # 默认 http://127.0.0.1:8642/index.html
 *   node tools/hero-fit.mjs "file:///E:/.../index.html"
 *
 * 判定标准：ctaVisible 应该是 true。false 说明笔记本矮窗口（720–800）里主按钮掉到首屏下面了。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8642/index.html';
const SIZES = [[1440, 900], [1280, 800], [900, 760], [900, 720], [390, 780]];
const PORT = 13911 + (process.pid % 70);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-fit-'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
if (!bin) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });

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
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', returnByValue: true, awaitPromise: true });
  const d = r.result;
  if (d?.exceptionDetails) throw new Error(d.exceptionDetails.exception?.description || d.exceptionDetails.text);
  return d?.result?.value;
}
async function until(expr, tries = 40, gap = 300) {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(gap); }
  return false;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

let bad = 0;
for (const [W, H] of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
  await send('Page.navigate', { url: URL_ARG });
  await until('return !!document.getElementById("hero-start");', 50);

  /* 灌 40 个到期词（12 错词），否则封面是空的，量不出真实高度 */
  await js(`
    var bk = window.VD_DATA[Object.keys(window.VD_DATA)[0]];
    var ws = bk.words.slice(0, 60).map(function (w) { return w[0]; });
    var now = Date.now();
    for (var i = 0; i < 40; i++) {
      var w = ws[i], isW = i < 12;
      S.progress[w] = { due: now - (i + 1) * 3600e3, stability: 3 + i, difficulty: 5, last: now - 86400e3,
        state: 2, lv: 1, wrong: isW ? 2 : 0, lastWrong: isW ? now - 86400e3 : 0, lastG: isW ? 1 : 3 };
    }
    save(); renderHero(); return 1;
  `);
  await wait(420);

  const m = await js(`
    var h = document.getElementById('hero').getBoundingClientRect();
    var c = document.getElementById('hero-start').getBoundingClientRect();
    return { hero: Math.round(h.height), ctaBottom: Math.round(c.bottom),
      needScroll: Math.max(0, Math.round(c.bottom - innerHeight)),
      ctaVisible: c.bottom <= innerHeight && c.top >= 0 };
  `);
  if (!m.ctaVisible) bad++;
  console.log((W + 'x' + H).padEnd(9), 'hero', String(m.hero).padStart(4) + 'px',
    '| 按钮底边', String(m.ctaBottom).padStart(4), '|', m.ctaVisible ? '首屏可见 ✅' : '要滚 ' + m.needScroll + 'px ❌');
}

ws.close();
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log(bad ? bad + ' 种尺寸主按钮不在首屏' : '全部尺寸主按钮都在首屏');
process.exit(bad ? 1 : 0);
