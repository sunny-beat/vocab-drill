/* 发音体检（v6.9.4 起）：发音只有一条路 —— 有道词典的在线 mp3。
 *
 *   1) 真的能取到音频并开始播（playing 事件 / currentTime 前进）
 *   2) 点下去立刻有「正在读」的视觉反馈
 *   3) 同一个词连点两次不重复下载（复用同一个 src，回到 0 秒）
 *   4) 美音 type=2 / 英音 type=1，跟着设置走
 *   5) 断网时不发请求，直接给一句人话
 *   6) 设置页的「发音」下拉 + 试听 + 排查弹窗都在位
 *   7) 代码里彻底没有 speechSynthesis（不再有浏览器合成那条路）
 *
 *   node tools/probe-voice.mjs                 # 默认打 唯单词.html
 *   node tools/probe-voice.mjs "D:/x.html"
 *   node tools/probe-voice.mjs http://127.0.0.1:8651/index.html
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ARG = process.argv[2] || '唯单词.html';
const isUrl = /^https?:\/\//i.test(ARG);
if (!isUrl && !existsSync(ARG)) { console.error('找不到文件：' + ARG); process.exit(2); }
const URL_ARG = isUrl ? ARG : pathToFileURL(path.resolve(ARG)).href;
const PORT = 13900 + (process.pid % 60);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-voice-'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
if (!bin) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const proc = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1280,860', 'about:blank'
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* 没起来 */ }
    await wait(250);
  }
  throw new Error('devtools 未就绪');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => { const id = ++n; ws.send(JSON.stringify({ id, method, params })); return new Promise(r => pending.set(id, r)); };
async function raw(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
const js = (body) => raw('(async function(){' + body + '})()');
let fails = 0;
const check = (name, cond, info) => {
  if (!cond) fails++;
  console.log((cond ? '  ok    ' : '  FAIL  ') + name + (info === undefined ? '' : '  → ' + JSON.stringify(info)));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL_ARG });
for (let i = 0; i < 120; i++) { if (await raw('window.VD_BOOT_OK===1')) break; await wait(250); }

/* 1. 真的能从有道取到音频并开始播 */
const say = await js(`
  const t0 = performance.now();
  const out = await new Promise(function (resolve) {
    speak('vocabulary', null, {
      onState: function (st, why) {
        if (st === 'start') resolve({ started: Math.round(performance.now() - t0), src: _audioUrl });
        else if (st === 'fail') resolve({ fail: why || 'fail' });
      }
    });
    setTimeout(function () { resolve({ timeout: true, src: _audioUrl }); }, 15000);
  });
  out.url = String(_audioUrl || '').slice(0, 120);
  out.paused = _audio ? _audio.paused : null;
  return out;
`);
console.log('  有道 url：' + (say.url || '(空)'));
check('能从有道取到音频并开始播', typeof say.started === 'number' && say.started > 0, say);
check('请求的是 dict.youdao.com 的 dictvoice', /dict\.youdao\.com\/dictvoice\?audio=vocabulary/.test(say.url), say.url);
check('默认美音（type=2）', /&type=2$/.test(say.url), say.url);

/* 2. 点下去立刻有「正在读」反馈 */
const ind = await js(`
  markSpeaking(false);
  speak('vocabulary', null);
  const on = document.body.classList.contains('is-speaking');
  return { on: on };
`);
check('点发音立刻有「正在读」反馈', ind.on === true, ind);

/* 3. 同一个词连点：不换 src（不重复下载） */
const again = await js(`
  await new Promise(r => setTimeout(r, 900));
  const before = _audioUrl;
  const c0 = _audioTok;
  speak('vocabulary', null);
  await new Promise(r => setTimeout(r, 400));
  return { sameSrc: _audioUrl === before, advanced: _audioTok > c0, hasSrc: !!before };
`);
check('同一个词连点复用已下载的音频（src 不变）', again.hasSrc && again.sameSrc === true, again);

/* 4. 英音切 type=1，切换后立刻生效 */
const uk = await js(`
  S.settings.accent = 'uk';
  speak('vocabulary', null);
  await new Promise(r => setTimeout(r, 500));
  const ukUrl = _audioUrl;
  S.settings.accent = 'us';
  speak('vocabulary', null);
  await new Promise(r => setTimeout(r, 500));
  const usUrl = _audioUrl;
  S.settings.accent = 'us';
  return { ukUrl: ukUrl, usUrl: usUrl };
`);
check('英音取 type=1', /&type=1$/.test(uk.ukUrl || ''), uk.ukUrl);
check('美音取 type=2', /&type=2$/.test(uk.usUrl || ''), uk.usUrl);

/* 5. 断网：不发请求，直接给人话 */
await send('Network.enable');
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
const off = await js(`
  await new Promise(r => setTimeout(r, 200));
  _voiceWarned = false;
  const msgs = [];
  const orig = window.toast;
  window.toast = function (t) { msgs.push(String(t)); };
  const t0 = performance.now();
  let st0 = '';
  speak('vocabulary', null, { onState: function (st) { if (!st0) st0 = st; } });
  const spent = Math.round(performance.now() - t0);
  await new Promise(r => setTimeout(r, 300));
  window.toast = orig;
  return { online: navigator.onLine, first: st0, spent: spent, msgs: msgs, speaking: document.body.classList.contains('is-speaking') };
`);
check('断网时 navigator.onLine 为 false', off.online === false, off);
check('断网时立刻判失败，不空等 6 秒', off.first === 'fail' && off.spent < 500, off);
check('断网时给的是「联网」人话', off.msgs.some(t => /联网|网络/.test(t)), off.msgs);
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

/* 6. 设置页：发音下拉 / 试听 / 排查弹窗 */
const st = await js(`
  document.getElementById('btn-settings').click();
  await new Promise(r => setTimeout(r, 300));
  const sel = document.getElementById('set-accent');
  const opts = sel ? Array.from(sel.options).map(o => o.textContent) : [];
  const msg = (document.getElementById('set-speech-msg').textContent || '');
  const hasTest = !!document.getElementById('set-testspeak');
  const noOld = !document.getElementById('set-voice') && !document.getElementById('set-voicehelp');
  let modal = null;
  showVoiceHelp();
  await new Promise(r => setTimeout(r, 250));
  const body = document.getElementById('modal-body');
  modal = {
    shown: !document.getElementById('modal').classList.contains('hidden'),
    text: (body.innerText || '').slice(0, 200),
    hasBack: !!document.getElementById('vh-back'),
    hasNet: /联网|网络|有道/.test(body.innerText || ''),
    hasOldCmd: /Add-WindowsCapability|Samantha/.test(body.innerText || '')
  };
  return { n: opts.length, opts: opts, msg: msg.slice(0, 60), hasTest: hasTest, noOld: noOld, modal: modal };
`);
check('设置里有「发音」下拉（2 项，都写明有道）', st.n === 2 && st.opts.every(t => /有道/.test(t)), st.opts);
check('发音状态行有内容 + 试听按钮', st.msg.length > 0 && st.hasTest === true, st.msg);
check('旧的系统音色下拉 / 装包入口已移除', st.noOld === true, { noOld: st.noOld });
check('排查弹窗能打开、讲的是网络不是语音包', st.modal.shown && st.modal.hasNet && st.modal.hasBack && st.modal.hasOldCmd === false,
  { shown: st.modal.shown, hasNet: st.modal.hasNet, hasOldCmd: st.modal.hasOldCmd });

/* 7. 代码里不再有系统语音合成 */
const code = await js(`
  const a = String(speak) + String(speakAudio);
  return { synth: /speechSynthesis|SpeechSynthesisUtterance/.test(a),
           youdao: String(YOUDAO).indexOf('dict.youdao.com') >= 0,
           noPickVoice: typeof window.pickVoice === 'undefined', noVoices: typeof window.voiceOptions === 'undefined' };
`);
check('speak 里彻底没有 speechSynthesis', code.synth === false, code);
check('音频地址常量指向有道', code.youdao === true, code);
check('pickVoice / voiceOptions 死代码已删除', code.noPickVoice && code.noVoices, code);

console.log(fails ? ('\n' + fails + ' 项未通过') : '\n全部通过');
try { ws.close(); } catch (e) { /* ignore */ }
proc.kill();
await wait(500);
try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* ignore */ }
process.exit(fails ? 1 : 0);
