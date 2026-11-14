/* 手机端发音体检：模拟 iPhone / Android，验设备判定、文案、热区、一屏装下 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const PORT = 14721 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-mob-'));
const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

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
ws.addEventListener('message', ev2 => {
  const m = JSON.parse(ev2.data);
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

const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_AND = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

async function loadAs(ua, w, h, label) {
  await send('Emulation.setUserAgentOverride', { userAgent: ua, platform: label === 'iOS' ? 'iPhone' : 'Linux armv8l' });
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ARG });
  await sleep(5200);
  await ev(`(async()=>{try{const rs=await navigator.serviceWorker.getRegistrations();for(const r of rs)await r.unregister();const ks=await caches.keys();for(const k of ks)await caches.delete(k);}catch(e){}return 1})()`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(4800);
  /* 触摸模式下 pointerdown 会触发 unlockSpeech；这里先真点一下页面，模拟用户第一次触摸 */
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: w / 2, y: h / 2 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
}

console.log('\n########## iPhone ##########');
await loadAs(UA_IOS, 390, 844, 'iOS');
log('== 1. 设备判定 ==');
log('  ' + await ev(`JSON.stringify({ios:IS_IOS, android:IS_ANDROID, touch:IS_TOUCH, ua:/iPhone/.test(navigator.userAgent)})`));
ok('IS_IOS 为 true（靠 UA，不靠 hover 查询）', await ev(`IS_IOS`) === true);
ok('IS_ANDROID 为 false', await ev(`IS_ANDROID`) === false);
ok('IS_TOUCH 为 true', await ev(`IS_TOUCH`) === true);

log('== 2. speechStatus 给的是 iPhone 的说法 ==');
const st = await ev(`JSON.stringify(speechStatus())`);
log('  ' + st);
ok('不再给 iPhone 用户指 Windows 的路径', !/Windows/.test(st || ''), st);

log('== 3. 发音帮助弹窗（v6.9.4 起统一讲网络 / 有道音频）==');
await ev(`showVoiceHelp(); 1`);
await sleep(400);
const helptext = await ev(`document.getElementById('modal-body').textContent`);
ok('讲清「音频靠联网取」', /联网|网络/.test(helptext || ''));
ok('提了有道，不是本地合成', /有道|dict\.youdao/.test(helptext || ''));
ok('讲了静音开关 + 自动播放限制', /静音/.test(helptext || '') && /手指点下去|自动播放/.test(helptext || ''));
ok('不再教用户装系统语音包', !/Add-WindowsCapability|朗读内容|文字转语音输出/.test(helptext || ''));
await ev(`openSettings(); 1`);
await sleep(300);

log('== 4. 🔊 按钮热区够手指点 ==');
await ev(`closeModal(); 1`);   // 上一步把设置弹窗开着，它会盖住卡片，点击全落在它身上
await sleep(200);
await ev(`S.settings.newPerDay=3; save(); document.getElementById('set-new') && (document.getElementById('set-new').value=3); startSession && startSession(); 1`);
await sleep(200);
/* 进一张识别卡 */
await ev(`(function(){
  const ws=WORDS.slice(0,3); const now=Date.now();
  ws.forEach(function(w){ S.progress[w[0]]=Object.assign({},S.progress[w[0]],{due:now-1000,ivl:1,rep:1,g:1,last:'recog',seen:1}); });
  save(); startPhase('review',{}); return 1;
})()`);
await sleep(900);
const box = await ev(`(function(){const b=document.getElementById('speak');if(!b)return null;const r=b.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};})()`);
log('  🔊 热区 =', JSON.stringify(box));
ok('🔊 热区宽 ≥ 42 且高 ≥ 42', !!box && box.w >= 42 && box.h >= 42, JSON.stringify(box));

log('== 5. 点 🔊 是不是真的去取了有道音频（v6.9.4）==');
const hook = await ev(`(function(){
  window.__calls=[];
  try {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ window.__calls.push({t: Math.round(performance.now()), src: String(this.src||'')}); return orig.apply(this, arguments); };
    return 'hooked';
  } catch(e){ return 'fail:' + e.message; }
})()`);
log('  hook =', hook);
const b2 = await ev(`(function(){const b=document.getElementById('speak');const r=b.getBoundingClientRect();
  const hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2), hit: hit? (hit.id||hit.className||hit.tagName) : null};})()`);
log('  点击点 =', JSON.stringify(b2));
/* headless 下 dispatchTouchEvent 不一定合成 click，鼠标事件在移动模拟里同样会走 touch→click 链 */
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b2.x, y: b2.y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b2.x, y: b2.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b2.x, y: b2.y, button: 'left', clickCount: 1 });
await sleep(500);
const calls = await ev(`JSON.stringify(window.__calls||[])`);
log('  speak 调用 =', calls);
ok('点 🔊 真的去播有道音频了', (await ev(`(window.__calls||[]).some(c=>/dict\\.youdao\\.com/.test(c.src))`)) === true, calls);
ok('已经不再有浏览器语音合成这条路', (await ev(`typeof speechSynthesis === 'undefined' || !/speechSynthesis/.test(String(speak))`)) === true);

log('== 6. 一屏装下（手机尺寸无滚动条）==');
const fit = await ev(`JSON.stringify({pageOver: document.documentElement.scrollHeight - window.innerHeight, cardOver: (function(){const c=document.getElementById('card');return c? Math.round(c.scrollHeight-c.clientHeight):0;})()})`);
log('  ' + fit);
const fo = JSON.parse(fit || '{}');
ok('页面不出现纵向滚动', fo.pageOver <= 2, 'pageOver=' + fo.pageOver);
ok('卡片内部不溢出', fo.cardOver <= 2, 'cardOver=' + fo.cardOver);

console.log('\n########## Android ##########');
await loadAs(UA_AND, 412, 915, 'Android');
log('== 7. 设备判定 ==');
ok('IS_ANDROID 为 true', await ev(`IS_ANDROID`) === true);
ok('IS_IOS 为 false', await ev(`IS_IOS`) === false);
log('== 8. speechStatus 给的是安卓的说法 ==');
const st2 = await ev(`JSON.stringify(speechStatus())`);
log('  ' + st2);
ok('不再给安卓用户指 Windows 的路径', !/Windows/.test(st2 || ''), st2);
log('== 9. 帮助弹窗（安卓同样讲网络）==');
await ev(`showVoiceHelp(); 1`);
await sleep(400);
const h2 = await ev(`document.getElementById('modal-body').textContent`);
ok('讲联网 / 有道', /联网|网络/.test(h2 || '') && /有道|dict\.youdao/.test(h2 || ''));
ok('提醒微信内置浏览器可换浏览器打开', /微信/.test(h2 || '') && /浏览器打开/.test(h2 || ''));
ok('不教用户装系统语音包', !/Add-WindowsCapability|文字转语音输出/.test(h2 || ''));

try { ws.close(); } catch (e) {}
proc.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
console.log('\n==== 结果：' + (fails ? fails + ' 项失败' : '全部通过') + ' ====');
process.exitCode = fails ? 1 : 0;
