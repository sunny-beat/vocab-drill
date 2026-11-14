/* 启动导览体检（v6.11.1）：确认「产品全貌」写得全、结构在、按钮能用、手机上不溢出。
 *   node tools/probe-welcome.mjs "http://127.0.0.1:8651/index.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14200 + (process.pid % 40);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-welcome-'));
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
let fails = 0;
const check = (name, cond, info) => {
  if (!cond) fails++;
  console.log((cond ? '  ok    ' : '  FAIL  ') + name + (info === undefined ? '' : '  → ' + JSON.stringify(info)));
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: URL_ARG });
for (let i = 0; i < 120; i++) { if (await raw('window.VD_BOOT_OK===1')) break; await wait(250); }

/* 1. 首启弹窗本身 */
const w = await js(`
  return {
    shown: !!document.getElementById('welcome-panel') && !document.getElementById('modal').classList.contains('hidden'),
    title: (document.getElementById('welcome-title')||{}).textContent || '',
    kicker: (document.querySelector('.welcome-kicker')||{}).textContent || '',
    steps: document.querySelectorAll('.welcome-step').length,
    secs: Array.from(document.querySelectorAll('.welcome-sec')).map(e=>e.textContent),
    main: document.querySelectorAll('.welcome-grid article').length,
    more: document.querySelectorAll('.welcome-more > div').length,
    keysBtn: !!document.getElementById('welcome-keys'),
    doneBtn: !!document.getElementById('welcome-done')
  };
`);
check('首启弹出使用指南', w.shown === true, w);
check('标题是「欢迎使用唯单词」，标注完整功能', /欢迎使用唯单词/.test(w.title) && /完整功能/.test(w.kicker), { t: w.title, k: w.kicker });
check('只有两个分组（主要功能 / 还有这些），已去掉「怎么开始」',
  w.secs.length === 2 && w.secs.join('|').indexOf('主要功能') >= 0 &&
  w.secs.join('|').indexOf('还有这些') >= 0 && w.secs.join('|').indexOf('怎么开始') < 0, w.secs);
check('没有上手步骤卡，6 张主卡 + 10 条补充', w.steps === 0 && w.main === 6 && w.more === 10,
  { steps: w.steps, main: w.main, more: w.more });
check('有「全部快捷键」和「开始使用」按钮', w.keysBtn && w.doneBtn, w);

/* 2. 内容覆盖：主要功能 + 老功能，不只是一份更新日志 */
const text = await js(`return document.getElementById('welcome-panel').innerText;`);
const must = [
  '背新词', '复习', '复习旧词', '四选一', '拼写', '语境', '听写', '教学卡',
  'FSRS', '遗忘曲线', '撤销', '真题', '字典', '词根', '近义词', '词条',
  '单词本', '统计', '技能画像', '已掌握', '收藏', '章节', '导入', '导出',
  '发音', '有道', '同步', '备份', '边栏', '一屏', '快捷键', '桌面应用'
];
const missing = must.filter(k => text.indexOf(k) < 0);
check('覆盖 32 项主要功能（不缺老功能）', missing.length === 0, { missing: missing, len: text.length });
check('不是更新日志：没有版本号 / 「本次更新」字样', !/v6\.\d|本次更新|新增功能/.test(text), text.slice(0, 80));

/* 2b. 用户要求：今日任务台只讲背新词 / 复习旧词，别再堆设置项 */
const lane = await js(`return (document.querySelector('.welcome-grid article p')||{}).textContent || '';`);
check('「今日任务台」只讲背新词 / 复习旧词，不列设置项',
  /背新词/.test(lane) && /复习旧词/.test(lane) &&
  !/顺带过|预估用时|每轮上限|断点续背|复习范围|段末/.test(lane), lane);

/* 3. 按钮 */
const btn = await js(`
  document.getElementById('welcome-keys').click();
  await new Promise(r=>setTimeout(r,200));
  const openKeys = !document.getElementById('modal').classList.contains('hidden') &&
                   /快捷键/.test(document.getElementById('modal-body').innerText);
  openWelcome(false);
  await new Promise(r=>setTimeout(r,150));
  const back = !!document.getElementById('welcome-done');
  document.getElementById('welcome-done').click();
  await new Promise(r=>setTimeout(r,150));
  return { openKeys: openKeys, back: back, closed: document.getElementById('modal').classList.contains('hidden') };
`);
check('「全部快捷键」能打开键位表', btn.openKeys === true, btn);
check('「开始使用」能关掉导览', btn.closed === true, btn);

/* 4. 手机尺寸：弹窗在视口内、内容可滚到底、按钮可点 */
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
const mob = await js(`
  openWelcome(false);
  await new Promise(r=>setTimeout(r,250));
  const box = document.querySelector('.modal-box').getBoundingClientRect();
  const body = document.getElementById('modal-body');
  const overflowX = document.documentElement.scrollWidth - window.innerWidth;
  const cols = getComputedStyle(document.querySelector('.welcome-grid')).gridTemplateColumns.split(' ').length;
  body.scrollTop = body.scrollHeight;
  await new Promise(r=>setTimeout(r,120));
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
  const done = document.getElementById('welcome-done').getBoundingClientRect();
  const doneVisible = done.width > 0 && done.height > 0;
  return {
    inViewport: box.top >= -1 && box.bottom <= window.innerHeight + 1,
    overflowX: overflowX, cols: cols, scrollable: body.scrollHeight > body.clientHeight,
    atBottom: atBottom, doneVisible: doneVisible
  };
`);
check('390×780 弹窗不超出视口、不横向溢出', mob.inViewport && mob.overflowX <= 1, mob);
check('手机下改单列排布', mob.cols === 1, { cols: mob.cols });
check('内容能滚到底且「开始使用」可见', mob.scrollable && mob.atBottom && mob.doneVisible, mob);

/* 5. 深色主题下不是黑字压黑底 */
const dark = await js(`
  S.settings.theme='dark'; applyTheme();
  const sec = document.querySelector('.welcome-sec');
  const txt = document.querySelector('.welcome-more span');
  const cs = getComputedStyle(sec).color, ps = getComputedStyle(txt).color;
  S.settings.theme='auto'; applyTheme();
  return { sec: cs, txt: ps };
`);
const rgb = (v) => (v.match(/\d+/g) || []).slice(0, 3).map(Number);
const lum = (v) => { const a = rgb(v); return a.length === 3 ? (a[0] * .299 + a[1] * .587 + a[2] * .114) : -1; };
check('深色下分组标题/正文是亮色', lum(dark.sec) > 90 && lum(dark.txt) > 90, dark);

console.log(fails ? ('\n' + fails + ' 项未通过') : '\n全部通过');
try { ws.close(); } catch (e) { /* ignore */ }
proc.kill();
await wait(400);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fails ? 1 : 0);
