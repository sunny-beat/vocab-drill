import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const PORT = 14901 + (process.pid % 10);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-bp-'));
const bin = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const p = spawn(bin, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });
async function w() { for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); const t = (await r.json()).find(x => x.type === 'page'); if (t) return t.webSocketDebuggerUrl; } catch (e) { } await wait(250); } }
const ws = new WebSocket(await w()); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, pr = {}) => { const id = ++n; ws.send(JSON.stringify({ id, method: m, params: pr })); return new Promise(r => pend.set(id, r)); };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8651/index.html' });
for (let i = 0; i < 60; i++) {
  const t = await send('Runtime.evaluate', { returnByValue: true, expression: "typeof ensureDict + '|' + document.readyState + '|' + !!document.getElementById('hero-start')" });
  if (String(t.result.result.value).startsWith('function|complete|true')) break;
  await wait(500);
}
const r = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async function(){ try {
  await ensureDict(); await ensurePaper();
  document.getElementById('hero-start').click();
  await new Promise(r=>setTimeout(r,1000));
  var cw = document.querySelector('.cardword, .qword, .word');
  var cardWord = (cw?cw.textContent:'').replace('🔊','').trim();
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));
  await new Promise(r=>setTimeout(r,1000));
  var modal = document.getElementById('modal');
  var open = !modal.classList.contains('hidden');
  var heads = [].map.call(modal.querySelectorAll('.rsub'), function(x){return x.textContent.trim();});
  var srcs = [].map.call(modal.querySelectorAll('.ssrc'), function(x){return x.textContent.trim();});
  var sents = [].map.call(modal.querySelectorAll('.exlist .en'), function(x){return x.textContent.trim().slice(0,70);});
  closeModal(); await new Promise(r=>setTimeout(r,300));

  // 抽样词书词
  var all = [];
  Object.keys(BOOKS).forEach(function(id){
    var b = VD_DATA[id]; if(!b||!b.words) return;
    b.words.forEach(function(e){ all.push(e.w || e[0] || e); });
  });
  var step = Math.max(1, Math.floor(all.length/120));
  var sample = []; for (var i=0;i<all.length && sample.length<120;i+=step) sample.push(all[i]);
  var hit = sample.filter(function(w){ return PAPER && PAPER[w]; });
  return { cardWord: cardWord, modalOpen: open, heads: heads, srcs: srcs, sents: sents,
           pool: all.length, sampleN: sample.length, hitN: hit.length,
           hitRate: Math.round(hit.length/sample.length*1000)/10,
           missN: sample.length-hit.length, missSample: sample.filter(function(w){return !(PAPER&&PAPER[w]);}).slice(0,6) };
} catch(e){ return {err:String(e&&e.stack||e)}; } })()` });
console.log(JSON.stringify(r.result.result.value, null, 1));
ws.close(); p.kill(); try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
