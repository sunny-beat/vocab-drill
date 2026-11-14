/* 设置页第二批：音色 / 帮助弹窗 / 导入备份 / 清空进度 / 安装到桌面 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14771 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-set2-'));
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
let dialogs = 0;
ws.addEventListener('message', ev2 => {
  const m = JSON.parse(ev2.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs++;
    ws.send(JSON.stringify({ id: ++seq, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  }
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

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: URL_ARG });
await sleep(5500);
await send('Page.reload', { ignoreCache: true });
await sleep(4800);
await ev(`openSettings(); 1`);
await sleep(400);

log('== K. 发音：美音 / 英音切换是否记住、是否真的换 type（v6.9.4 起走有道音频） ==');
const acc = await ev(`(function(){
  const sel=document.getElementById('set-accent');
  const opts = sel ? Array.from(sel.options).map(o=>o.textContent) : [];
  sel.value='uk'; sel.dispatchEvent(new Event('change',{bubbles:true}));
  const after = { saved: S.settings.accent,
                  msg: (document.getElementById('set-speech-msg')||{}).textContent.slice(0,40) };
  speak('vocabulary', null);
  return JSON.stringify({ opts: opts, after: after, ukUrl: String(_audioUrl||'') });
})()`);
const A = JSON.parse(acc || '{}');
log('  选项 =', JSON.stringify(A.opts), '· 切英音后 =', JSON.stringify(A.after));
ok('发音只有美音 / 英音两项，且写明有道', (A.opts||[]).length === 2 && A.opts.every(t => /有道/.test(t)), JSON.stringify(A.opts));
ok('切英音写进 S.settings.accent 并回显', A.after && A.after.saved === 'uk' && /英音/.test(A.after.msg || ''), A.after);
ok('英音取的是 type=1', /&type=1$/.test(A.ukUrl || ''), A.ukUrl);
const usUrl = await ev(`(function(){ S.settings.accent='us'; save(); speak('vocabulary', null); return String(_audioUrl||''); })()`);
ok('切回美音取 type=2', /&type=2$/.test(usUrl || ''), usUrl);

log('== L. 发音排查弹窗（讲网络，不讲装语音包） ==');
await ev(`showVoiceHelp(); 1`);
await sleep(400);
const head = await ev(`(document.getElementById('modal-body').querySelector('h2')||{}).textContent`);
const bodyTxt = await ev(`document.getElementById('modal-body').textContent`);
ok('排查弹窗打开了', /发音/.test(head || ''), head);
ok('讲的是网络 / 有道，而不是系统语音包', /联网|网络|有道/.test(bodyTxt || '') && !/Add-WindowsCapability|Samantha|文字转语音/.test(bodyTxt || ''), head);
await ev(`document.getElementById('vh-back').click(); 1`);
await sleep(300);
ok('「回到设置」能回设置页', (await ev(`(document.getElementById('modal-body').querySelector('h2')||{}).textContent`)) === '⚙️ 设置');

log('== M. 导入备份：好的能收、坏的会拒 ==');
const good = await ev(`(function(){
  const s = JSON.parse(JSON.stringify(S));
  s.progress = { 'zzztest': { due: Date.now(), lv: 2, wrong: 1 } };
  s.settings.newPerDay = 33;
  return JSON.stringify(s);
})()`);
await ev(`window.__alerted=''; window.alert=function(m){window.__alerted=String(m);}; 1`);
/* 先喂一个坏文件 */
await ev(`(function(){
  const f = new File(['{"foo":1}'], 'bad.json', {type:'application/json'});
  importData(f); return 1;
})()`);
await sleep(700);
ok('坏备份被拒并 alert', /无效/.test(await ev(`window.__alerted`)), await ev(`window.__alerted`));

/* 再喂一个好文件 —— 它会写 LS 然后 location.reload()，所以只验写入 */
await ev(`window.__before = lsGet(LS_KEY) ? lsGet(LS_KEY).length : 0; 1`);
await ev(`(function(){
  window.__reloaded = 0;
  const _r = location.reload.bind(location);
  try { Object.defineProperty(location, 'reload', { value: function(){ window.__reloaded = 1; }, configurable: true }); } catch(e) {}
  const f = new File([${JSON.stringify(good)}], 'good.json', {type:'application/json'});
  importData(f); return 1;
})()`);
await sleep(900);
const wrote = await ev(`(function(){ try { const s=JSON.parse(localStorage.getItem(LS_KEY)); return JSON.stringify({newPerDay:s.settings&&s.settings.newPerDay, hasZzz: !!(s.progress&&s.progress.zzztest)}); } catch(e){ return String(e); } })()`);
log('  写入后 =', wrote);
ok('好备份被接受并写进本地存储', /33/.test(wrote || '') && /true/.test(wrote || ''), wrote);

log('== N. 清空本书进度（要过 confirm）==');
await send('Page.navigate', { url: URL_ARG });
await sleep(5000);
await ev(`(function(){ const w=WORDS[0][0];
  S.progress[w]={due:Date.now(),lv:3,rep:2,wrong:1,g:2,last:'recog',seen:5}; save(); return 1; })()`);
const before = await ev(`Object.keys(S.progress).length`);
await ev(`openSettings(); 1`);
await sleep(300);
await ev(`document.getElementById('set-reset').click(); 1`);
await sleep(700);
const after = await ev(`Object.keys(S.progress).length`);
const dlg = dialogs;
ok('点了之后有确认框（已自动确认）', dlg > 0, 'dialogs=' + dlg);
ok('本书进度被清空', after < before, before + ' → ' + after);
ok('清空后回到封面', await ev(`!document.getElementById('page-study').classList.contains('hidden')`));

log('== O. 安装到桌面（无 PWA 环境时的兜底文案）==');
await ev(`openSettings(); 1`);
await sleep(300);
await ev(`window.__toast=''; 1`);
const t0 = await ev(`(function(){ try { installApp(); return 1; } catch(e){ return String(e); } })()`);
await sleep(500);
const toastTxt = await ev(`(document.querySelector('.toast')||{}).textContent || ''`);
ok('installApp() 不抛错', t0 === 1, t0);
log('  提示 =', toastTxt || '(无 toast)');

try { ws.close(); } catch (e) {}
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
console.log('\n==== 结果：' + (fails ? fails + ' 项失败' : '全部通过') + ' ====');
process.exitCode = fails ? 1 : 0;
