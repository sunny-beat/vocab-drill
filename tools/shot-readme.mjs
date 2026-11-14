/* 给 README 拍一组截图（CDP，零依赖，用本机 Edge）
 *
 * 为什么单独写一个：`--window-size` 在 headless 里不等于真实视口（Edge 有最小窗口宽度），
 * 必须用 Emulation.setDeviceMetricsOverride 才是真手机 / 真桌面尺寸，
 * 否则裁出来的图会被误判成「CSS 溢出」。
 *
 * 输出：docs/shots/*.png（deviceScaleFactor=2，Retina 清晰度）
 *
 *   node tools/shot-readme.mjs                    # 默认 http://127.0.0.1:8651
 *   node tools/shot-readme.mjs http://127.0.0.1:8651
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'shots');
mkdirSync(OUT, { recursive: true });

const BASE = (process.argv[2] || 'http://127.0.0.1:8651').replace(/\/+$/, '');
const URL_ARG = BASE + '/index.html';
const PORT = 14870 + (process.pid % 20);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-shot-'));
const BIN = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\chrome.exe'
].find(existsSync);
if (!BIN) { console.error('找不到 Edge/Chrome'); process.exit(2); }

const proc = spawn(BIN, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--force-color-profile=srgb', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  'about:blank'
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
const send = (method, params = {}) => {
  const id = ++n;
  ws.send(JSON.stringify({ id, method, params }));
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

async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 2, mobile: w < 500
  });
}

async function boot(theme) {
  const ready = async () => {
    for (let i = 0; i < 90; i++) {
      const st = await js("document.readyState + '|' + !!document.querySelector('.brand-name')");
      if (String(st).startsWith('complete|true')) return;
      await wait(400);
    }
  };
  await send('Page.navigate', { url: URL_ARG });
  await ready();
  /* 首启导览是「进来就弹」的，光在页面加载后写 key 已经晚了（弹窗已经出来了）。
     先写 key 再重载一次，镜头才干净。主题同理，改完也得重载。 */
  await js(`(function(){
    const raw = JSON.parse(localStorage.getItem('vocabdrill.v2') || '{}');
    raw.settings = raw.settings || {};
    raw.settings.theme = ${theme ? `'${theme}'` : `'light'`};
    /* 造一份「学了两周」的进度：封面有到期量、有连续打卡、今日已学一半，
       比 0/0/0 的初始状态好看得多，也更能说明这是一套跑得起来的系统。 */
    const DAY = 86400000, now = Date.now();
    const words = ((window.VD_DATA && window.VD_DATA.cet6 && window.VD_DATA.cet6.words) || [])
      .map(function (w) { return w[0]; });
    raw.progress = raw.progress || {};
    /* 取中段常见词，别一上来就是 a / abandon 这种太素的例子 */
    words.slice(1200, 1230).forEach(function (w, i) {
      raw.progress[w] = {
        lv: 1 + (i % 4),
        due: i < 20 ? now - (20 - i) * 3 * 3600000 : now + (i - 19) * DAY,
        wrong: i % 7 === 0 ? 2 : 0,
        lastG: 3
      };
    });
    raw.days = raw.days || {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(now - i * DAY);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      raw.days[k] = i === 0 ? { n: 12, r: 8 } : { n: 20, r: 14 };
    }
    raw.meta = raw.meta || {};
    raw.meta.changedAt = now;
    delete raw.session;
    localStorage.setItem('vocabdrill.v2', JSON.stringify(raw));
    localStorage.setItem('vocabdrill.welcome', 'seen');
  })()`);
  await send('Page.reload', { ignoreCache: false });
  await ready();
  /* 上次停在查词页会被恢复（page 是持久化字段），拍封面之前先掰回学习页 */
  await js(`(function(){
    const b = document.querySelector('#nav [data-page="study"]') ||
      [].find.call(document.querySelectorAll('#nav button'), function (x) { return /学习/.test(x.textContent); });
    if (b) b.click();
  })()`);
  await wait(700);
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(r.result.data, 'base64');
  writeFileSync(path.join(OUT, name + '.png'), buf);
  console.log('  ' + name + '.png  ' + (buf.length / 1024).toFixed(0) + ' KB');
}

const click = async sel => {
  const ok = await js(`(function(){
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click(); return true;
  })()`);
  await wait(700);
  return ok;
};

console.log('拍图 ->', OUT);

console.log('1) 桌面封面（浅色）');
await viewport(1280, 820);
await boot(null);
await shot('01-hero-light');

console.log('2) 识别卡（四选一）');
await click('#hero-start');
await wait(700);
await shot('02-card-recog');

console.log('3) 查词卡（abandon · 真题例句）');
await js(`(function(){
  const b = document.querySelector('#nav [data-page="dict"]') ||
            [].find.call(document.querySelectorAll('#nav button'), x => /查/.test(x.textContent));
  if (b) b.click();
})()`);
await wait(500);
await js(`(function(){
  const i = document.getElementById('dict-search');
  i.value = 'abandon';
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(1600);
await shot('03-dict');

console.log('4) 词书章节页');
await js(`(function(){
  const b = document.querySelector('#nav [data-page="books"]') ||
    [].find.call(document.querySelectorAll('#nav button'), function (x) { return /词书/.test(x.textContent); });
  if (b) b.click();
})()`);
await wait(1200);
await shot('04-books');

console.log('5) 深色封面');
await viewport(1280, 820);
await boot('dark');
await shot('05-hero-dark');

console.log('6) 手机识别卡（390×844 真视口）');
await viewport(390, 844);
await boot(null);
await click('#hero-start');
await wait(900);
await shot('06-mobile');

console.log('\n完成，共 6 张：' + OUT);
ws.close(); proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(0);
