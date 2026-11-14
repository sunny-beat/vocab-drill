import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const W = +(process.argv[2] || 390), H = +(process.argv[3] || 780), TAG = process.argv[4] || 'x';
const PORT = 14931 + (process.pid % 8);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-kl-'));
const bin = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const p = spawn(bin, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });
async function w() { for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); const t = (await r.json()).find(x => x.type === 'page'); if (t) return t.webSocketDebuggerUrl; } catch (e) { } await wait(250); } }
const ws = new WebSocket(await w()); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, pr = {}) => { const id = ++n; ws.send(JSON.stringify({ id, method: m, params: pr })); return new Promise(r => pend.set(id, r)); };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: W < 500 });
await send('Page.navigate', { url: 'http://127.0.0.1:8651/index.html' });
for (let i = 0; i < 60; i++) {
  const t = await send('Runtime.evaluate', { returnByValue: true, expression: "typeof kyLineHtml + '|' + document.readyState" });
  if (String(t.result.result.value).startsWith('function|complete')) break;
  await wait(400);
}
const r = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async function(){ try {
  await ensurePaper();
  drillWith(['imagination'], '验证', '');
  await new Promise(r=>setTimeout(r,800));
  var opt = document.querySelector('#card .qopt');
  if (opt) opt.click();
  var immediately = !!document.querySelector('#card .kyline');
  var c0 = document.getElementById('card');
  var over0 = c0.scrollHeight - c0.clientHeight;
  await new Promise(r=>setTimeout(r,900));
  var dbg = { paper: !!(window.PAPER || (typeof PAPER!=='undefined' && PAPER)), hasAbandon: !!(PAPER && PAPER['imagination']),
    kyLen: (typeof kyLineHtml==='function'? kyLineHtml('imagination').length : -1),
    qres: !!document.querySelector('#card .qres'), cardHTML: document.getElementById('card').className };
  var kl = document.querySelector('#card .kyline');
  dbg.immediately = immediately; dbg.over0 = over0;
  dbg.fbHasMeaning = !!document.querySelector('#card .fbfull .meaning, #card .meaning');
  var src = kl ? kl.querySelector('.kysrc') : null;
  var card = document.getElementById('card');
  var o = { dbg: dbg, hasLine: !!kl, text: kl ? kl.textContent.replace(/\\s+/g,' ').trim() : '',
    cardOver: card.scrollHeight - card.clientHeight,
    bodyOver: document.documentElement.scrollHeight - window.innerHeight };
  if (kl && src) {
    var kr = kl.getBoundingClientRect(), sr = src.getBoundingClientRect();
    o.geo = { klLeft: Math.round(kr.left), klRight: Math.round(kr.right), srcLeft: Math.round(sr.left),
      srcRight: Math.round(sr.right), srcTop: Math.round(sr.top), overflowX: src.right > kr.right + 1 };
  }
  // 功能词不该有真题行
  o.skipA = kyLineHtml('a') === '' && kyLineHtml('the') === '';
  return o;
} catch(e){ return {err:String(e&&e.stack||e)}; } })()` });
console.log(JSON.stringify(r.result.result.value, null, 1));
await wait(300);
const shot = await send('Page.captureScreenshot', { format: 'png' });
// v6.11.1 清理：_tmp/ 已删除，截图落到 tools/shots/（不存在就建）
const SHOT_DIR = path.resolve(process.cwd(), 'tools', 'shots');
mkdirSync(SHOT_DIR, { recursive: true });
writeFileSync(path.join(SHOT_DIR, 'kl-' + TAG + '.png'), Buffer.from(shot.result.data, 'base64'));
ws.close(); p.kill(); try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
