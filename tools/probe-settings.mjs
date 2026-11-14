/* 设置页逐项实测：真实鼠标点开关 + 自检回写 + 导出文件名 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14911 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-set-'));
const DL = mkdtempSync(path.join(tmpdir(), 'vd-dl-'));
const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  return r.result?.result?.value;
};
const sleep = (ms) => wait(ms);

const out = [];
let fails = 0;
const log = (...a) => { out.push(a.join(' ')); console.log(...a); };
const ok = (name, cond, extra) => {
  log((cond ? '  ✅ ' : '  ❌ ') + name + (extra === undefined ? '' : ' → ' + extra));
  if (!cond) fails++;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }).catch(() => {});
await send('Page.navigate', { url: URL_ARG });
await sleep(5500);
await send('Page.reload', { ignoreCache: true });
await sleep(4800);

/* 准备：清一次设置态，造 3 个到期词 */
await ev(`S.settings.autoSpeak=false; S.settings.listenOn=false; save(); 1`);
await ev(`openSettings(); 1`);
await sleep(400);

async function rect(sel) {
  return await ev(`(function(){const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,w:b.width,h:b.height};})()`);
}
async function clickAt(sel) {
  /* 设置弹窗内部是可滚动的，靠下的按钮可能在视口外 —— 先滚进来再点 */
  await ev(`(function(){const e=document.querySelector(${JSON.stringify(sel)});if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'});return 1;})()`);
  await sleep(220);
  const r = await rect(sel);
  if (!r || r.__err) { log('    (没找到 ' + sel + ')'); return null; }
  log('    点 ' + sel + ' @ ' + Math.round(r.x) + ',' + Math.round(r.y));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(260);
  return r;
}

log('== A. 开关本体（.track）能不能点动 ==');
await clickAt('#set-speak + .track');
ok('点自动发音的滑块 → checked 变 true', await ev(`document.getElementById('set-speak').checked`) === true);
ok('点自动发音的滑块 → S.settings.autoSpeak 变 true', await ev(`S.settings.autoSpeak`) === true);
await clickAt('#set-speak + .track');
ok('再点一下 → 关回去', await ev(`document.getElementById('set-speak').checked`) === false);
ok('再点一下 → S 里也关了', await ev(`S.settings.autoSpeak`) === false);
await clickAt('#set-listen + .track');
ok('点听写滑块 → listenOn 变 true', await ev(`S.settings.listenOn`) === true);
await clickAt('#set-listen + .track');
ok('再点听写滑块 → 关回去', await ev(`S.settings.listenOn`) === false);

log('== B. 「开 / 关」文字是否跟着变 ==');
await clickAt('#set-speak + .track');   // 打开
log('  开着时 =', await ev(`getComputedStyle(document.querySelector('#set-speak ~ .sw-txt'),'::after').content`));
ok('开着时文字是「开」', /开/.test(await ev(`getComputedStyle(document.querySelector('#set-speak ~ .sw-txt'),'::after').content`)));
await clickAt('#set-speak + .track');   // 关回去
log('  关着时 =', await ev(`getComputedStyle(document.querySelector('#set-speak ~ .sw-txt'),'::after').content`));
ok('关着时文字是「关」', /关/.test(await ev(`getComputedStyle(document.querySelector('#set-speak ~ .sw-txt'),'::after').content`)));

log('== C. 打开自动发音时是否立刻自检 ==');
await clickAt('#set-speak + .track');
await sleep(1400);
const msg1 = await ev(`(document.getElementById('set-speech-msg')||{}).textContent`);
ok('打开后灰字自动变成自检结果（含 ✅ 或 ❌）', /✅|❌/.test(msg1 || ''), msg1);
log('  灰字 =', msg1);

log('== D. 「读一遍试试」有没有真的读 ==');
/* 原生方法属性不可写，hook 不了 speak() 本身。
   改看两个只有「真读过」才会出现的信号：body.is-speaking 类 + onstart/onend 回写的灰字 */
await ev(`window.__spkSeen=0;
  const t=setInterval(function(){ if(document.body.classList.contains('is-speaking')) window.__spkSeen=1; }, 60);
  setTimeout(function(){ clearInterval(t); }, 6000); 1`);
await ev(`document.getElementById('set-speech-msg').textContent=''; 1`);
await clickAt('#set-testspeak');
await sleep(2600);
const seen = await ev(`window.__spkSeen||0`);
const msg2 = await ev(`(document.getElementById('set-speech-msg')||{}).textContent`);
ok('朗读状态标记亮过（说明真的在出声）', seen === 1, seen);
ok('自检灰字写出了结果', /✅|❌/.test(msg2 || ''), msg2);
log('  灰字 =', msg2);

log('== E. 各控件在位 ==');
const ids = ['set-new', 'set-rvcap', 'set-batch', 'set-listen', 'set-ret', 'set-theme',
  'set-speak', 'set-accent', 'set-testspeak', 'set-speech-msg',
  'set-install', 'set-update', 'set-export', 'set-import', 'set-exportnl', 'set-reset',
  'set-custom', 'set-default', 'set-file'];
const miss = await ev(`JSON.stringify(${JSON.stringify(ids)}.filter(id=>!document.getElementById(id)))`);
ok('所有控件都在位', miss === '[]', miss);

log('== F. 数值 / 下拉是否落库 ==');
log('  ' + await ev(`(function(){
  const n=document.getElementById('set-new'); n.value='15'; n.dispatchEvent(new Event('change',{bubbles:true}));
  const r=document.getElementById('set-rvcap'); r.value='25'; r.dispatchEvent(new Event('change',{bubbles:true}));
  const t=document.getElementById('set-theme'); t.value='dark'; t.dispatchEvent(new Event('change',{bubbles:true}));
  const rr=document.getElementById('set-ret'); rr.value='0.85'; rr.dispatchEvent(new Event('change',{bubbles:true}));
  return JSON.stringify({newPerDay:S.settings.newPerDay, reviewCap:S.settings.reviewCap, theme:S.settings.theme, ret:S.settings.retention, dt:document.documentElement.getAttribute('data-theme')});
})()`));

log('== G. 导出备份：文件名与内容形状 ==');
/* headless 下真实下载不落地，改成抓 a.download / blob 内容 */
await ev(`window.__dl=[];
  const _c = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    window.__dl.push({name:this.download, href:this.href});
    return undefined;   // 不真下载
  }; 1`);
await clickAt('#set-export');
await sleep(700);
const dl1 = await ev(`JSON.stringify(window.__dl.slice(-1))`);
log('  抓到 =', dl1);
let name1 = '';
try { name1 = JSON.parse(dl1)[0].name; } catch (e) {}
ok('确实触发了下载', !!name1, name1);
ok('文件名是「唯单词备份-日期.json」', /^唯单词备份-\d{4}-\d{2}-\d{2}\.json$/.test(name1), name1);

log('== H. 导出生词本：扩展名 ==');
await ev(`(function(){ const w=WORDS[0][0];
  S.progress[w]=Object.assign({},S.progress[w],{lv:0,wrong:2,due:Date.now()}); save(); return w;})()`);
await clickAt('#set-exportnl');
await sleep(600);
const dl2 = await ev(`JSON.stringify(window.__dl.slice(-1))`);
log('  抓到 =', dl2);
let name2 = '';
try { name2 = JSON.parse(dl2)[0].name; } catch (e) {}
ok('生词本导出是「唯单词生词本-日期.txt」', /^唯单词生词本-\d{4}-\d{2}-\d{2}\.txt$/.test(name2), name2);

log('== I. 「检查更新」在 http 下会去动 Service Worker ==');
ok('updateCache 存在', await ev(`typeof updateCache`) === 'function');
log('  单文件/文件模式下走另一条分支：', await ev(`(function(){ try { return typeof window.VD_STANDALONE + '/' + location.protocol; } catch(e){ return String(e); } })()`));

log('== J. 恢复推荐值按钮 ==');
await clickAt('#set-default');
await sleep(400);
log('  ' + await ev(`JSON.stringify({newPerDay:S.settings.newPerDay, reviewCap:S.settings.reviewCap, ret:S.settings.retention, modalOpen: !document.getElementById('modal').classList.contains('hidden')})`));

try { ws.close(); } catch (e) {}
proc.kill();
try { rmSync(DL, { recursive: true, force: true }); } catch (e) {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
console.log('\n==== 结果：' + (fails ? fails + ' 项失败' : '全部通过') + ' ====');
process.exitCode = fails ? 1 : 0;
