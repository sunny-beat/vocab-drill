/* 云同步体检：用假的 cloud 对象替换 SDK，跑通「发码 → 验证 → 对账 → 同步 → 退出」全流程。
 * 为什么要假 SDK：真 SDK 只在发布域名下能用（服务端做 exact-Origin 校验），
 * 这里要验的是**前端状态机**和**载荷形状**，不是网络。
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8651/index.html';
const URL_CLOUD = BASE + (BASE.includes('?') ? '&' : '?') + 'cloud=1';
const PORT = 14751 + (process.pid % 30);
const PROFILE = mkdtempSync(path.join(tmpdir(), 'vd-sync-'));
const bin = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' });

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
  if (m.method === 'Page.javascriptDialogOpening') {
    send('Page.handleJavaScriptDialog', { accept: true });
  }
});
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '') };
  }
  return r.result?.result?.value;
};
const sleep = ms => wait(ms);
let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
  if (!cond) fails++;
};
const head = t => console.log('\n== ' + t + ' ==');

const FAKE = `
window.__calls = [];
window.__faker = { row: null, session: { user: { id: 'u1' } }, failUpdate: false };
function __run(st, name) {
  const f = window.__faker;
  window.__calls.push([st.op || 'select', name, st.row || null, st.eq || null]);
  if (!st.op || st.op === 'select') return { data: f.row, error: null };
  if (st.op === 'insert') {
    f.row = { id: 1, payload: st.row.payload, client_updated_at: st.row.client_updated_at };
    return { data: [{ id: 1 }], error: null };
  }
  if (st.op === 'update') {
    if (f.failUpdate) return { data: null, error: { message: 'RLS 拒绝：new row violates policy' } };
    f.row = { id: (st.eq && st.eq[1]) || 1, payload: st.row.payload, client_updated_at: st.row.client_updated_at };
    return { data: [{ id: f.row.id }], error: null };
  }
  return { data: null, error: null };
}
function __table(name) {
  const st = { op: '', row: null, eq: null };
  const api = {
    select() { if (!st.op) st.op = 'select'; return api; },
    insert(r) { st.op = 'insert'; st.row = r; return api; },
    update(r) { st.op = 'update'; st.row = r; return api; },
    del() { st.op = 'delete'; return api; },
    eq(c, v) { st.eq = [c, v]; return api; },
    maybeSingle() { st.one = 1; return api; },
    single() { st.one = 1; return api; },
    limit() { return api; },
    order() { return api; },
    then(res, rej) { return Promise.resolve(__run(st, name)).then(res, rej); }
  };
  return api;
}
window.__fakeCloud = {
  auth: {
    getSession: async function () { window.__calls.push(['getSession']); return { data: window.__faker.session, error: null }; },
    sendOtp: async function (o) { window.__calls.push(['sendOtp', o.email]); return { data: { verificationId: 'vid-1', isExistingUser: false }, error: null }; },
    verifyOtp: async function (o) { window.__calls.push(['verifyOtp', o.email, o.token, o.isExistingUser]);
      return { data: { user: { id: 'u1', raw: { email: o.email } }, accessToken: 'tok' }, error: null }; },
    signOut: async function () { window.__calls.push(['signOut']); return { data: null, error: null }; }
  },
  database: { from: __table }
};
_cloud = window.__fakeCloud;
1;`;

async function nav(url, ms) {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: url });
  await sleep(ms || 5000);
  /* 清掉 SW 缓存，避免读到旧版 */
  await ev(`(async()=>{try{const rs=await navigator.serviceWorker.getRegistrations();for(const r of rs)await r.unregister();}catch(e){}return 1})()`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(4200);
  await ev(`try{localStorage.clear()}catch(e){};1`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(4000);
}

const callNames = () => ev('window.__calls.map(c=>c[0])');

/* ---------------- A. 没在发布域名时不该给表单 ---------------- */
head('A. 非发布域名：不给假的希望');
await nav(BASE);
ok('cloudOriginOk() 为 false', (await ev('cloudOriginOk()')) === false);
await ev('openSettings();1');
await sleep(300);
ok('设置页没有邮箱输入框', (await ev('!!document.getElementById("sync-email")')) === false);
const panelTxt = await ev('(document.getElementById("sync-panel")||{}).textContent||""');
ok('给了一句人话，而不是英文 401', /发布域名|线上链接/.test(panelTxt), panelTxt.slice(0, 70));
await ev('closeModal();1');

/* ---------------- B. 强制开关下：坏邮箱被挡在门口 ---------------- */
head('B. ?cloud=1：表单出来了，坏邮箱不发请求');
await nav(URL_CLOUD);
await ev(FAKE);
ok('cloudOriginOk() 为 true（调试开关生效）', (await ev('cloudOriginOk()')) === true);
await ev('openSettings();1');
await sleep(300);
ok('邮箱输入框在位', (await ev('!!document.getElementById("sync-email")')) === true);
await ev('document.getElementById("sync-email").value="abc";document.getElementById("sync-send").click();1');
await sleep(500);
const msgB = await ev('_syncMsg');
ok('坏邮箱给了提示', /格式不对/.test(msgB || ''), msgB);
ok('坏邮箱没去骚扰服务端', (await callNames()).indexOf('sendOtp') < 0, await callNames());

/* ---------------- C. 发码 → 验证 → 云端空则上传 ---------------- */
head('C. 发码 → 验证 → 首次登录（云端空）自动上传');
/* 先造 3 个词的学习进度 —— 空进度会让「本地空 → 下载」分支先命中，测不到上传 */
await ev(`S.progress = {
  a: { st: 1, due: Date.now()+86400e3, wrong: 0, lastWrong: 0 },
  abandon: { st: 2, due: Date.now()+3600e3, wrong: 1, lastWrong: Date.now() },
  ability: { st: 1, due: Date.now()+172800e3, wrong: 0, lastWrong: 0 }
}; save(); 1`);
ok('本地先有 3 个词的进度（后面两条分支才测得出来）', (await ev('Object.keys(S.progress).length')) === 3);
await ev(`document.getElementById("sync-email").value="me@example.com";document.getElementById("sync-send").click();1`);
await sleep(700);
ok('sendOtp 带着邮箱发出去了', JSON.stringify(await ev('window.__calls.find(c=>c[0]==="sendOtp")||null')).indexOf('me@example.com') > 0);
ok('拿到 verificationId', (await ev('_otp && _otp.verificationId')) === 'vid-1');
ok('界面切到验证码那一步', (await ev('!!document.getElementById("sync-code")')) === true);
ok('提示写清了验证码发到哪个邮箱', /me@example\.com/.test(await ev('(document.getElementById("sync-panel")||{}).textContent||""')));

await ev('document.getElementById("sync-code").value="123456";document.getElementById("sync-verify").click();1');
await sleep(1200);
ok('登录成功，邮箱记住了', (await ev('_sync.email')) === 'me@example.com');
ok('登录态标记打开', (await ev('_sync.on')) === true);
ok('verifyOtp 带上了 isExistingUser', JSON.stringify(await ev('window.__calls.find(c=>c[0]==="verifyOtp")||null')).indexOf('false') > 0);
const insCall = await ev('window.__calls.find(c=>c[0]==="insert")||null');
ok('云端空 → 走的是 insert', !!insCall, insCall && insCall[1]);
const payloadC = insCall && insCall[2] ? insCall[2].payload : null;
ok('上传的载荷里有词进度', !!(payloadC && payloadC.progress && Object.keys(payloadC.progress).length), payloadC && Object.keys(payloadC.progress || {}).length);
ok('载荷剔掉了纯设备字段 session/page/shist',
  !!payloadC && !('session' in payloadC) && !('page' in payloadC) && !('shist' in payloadC),
  payloadC && Object.keys(payloadC));
ok('插库时没有自作主张传 owner_id（由 RLS 的 auth.uid() 兜底）',
  !!insCall && !!insCall[2] && !('owner_id' in insCall[2]), insCall && Object.keys(insCall[2] || {}));
ok('client_updated_at 是毫秒时间戳', !!(insCall && insCall[2] && insCall[2].client_updated_at > 1e12));
await sleep(300);
ok('面板变成「已登录」', /已登录/.test(await ev('(document.getElementById("sync-panel")||{}).textContent||""')));

/* ---------------- D. 退出登录 ---------------- */
head('D. 退出登录：本地不留登录态，云端那份不动');
await ev('document.getElementById("sync-out").click();1');
await sleep(900);
ok('signOut 被调用', (await callNames()).indexOf('signOut') >= 0);
ok('邮箱清掉了', !(await ev('_sync.email')));
ok('登录态标记关掉', !(await ev('_sync.on')));
ok('界面回到填邮箱', (await ev('!!document.getElementById("sync-email")')) === true);
ok('云端那份还在（本地不删远端）', (await ev('!!window.__faker.row')) === true);

/* ---------------- E. 本地较新 → 直接推；真冲突才弹窗（v6.9.3 新语义） ----------------
 * 旧版是「两边都有词就弹窗」，但弹窗的判定依据是「有没有词」而不是「谁更新」，
 * 结果新设备只学了 3 个词也会拦下来问一次，还容易被随手点成「用本机的」把云端盖掉。
 * 现在：谁的数据改得晚用谁的，只有时间几乎相同 + 内容不同才问。 */
head('E. 本地较新：不弹窗，直接覆盖云端');
await ev('window.__faker.row = { id: 5, client_updated_at: Date.now()-3600e3, payload: { progress: { remoteA: {}, remoteB: {} }, settings: { newPerDay: 5 } } };1');
await ev(`document.getElementById("sync-email").value="me@example.com";document.getElementById("sync-send").click();1`);
await sleep(600);
await ev('document.getElementById("sync-code").value="654321";document.getElementById("sync-verify").click();1');
await sleep(1200);
const hasAsk = await ev('!!document.getElementById("sync-use-local")');
ok('本地更新时不弹窗（旧版这里会拦下来问）', hasAsk === false);
const afterPayload = await ev('window.__faker.row.payload');
ok('云端被这台设备的进度覆盖（没有 remoteA 残留）',
  !!(afterPayload && afterPayload.progress) && !('remoteA' in afterPayload.progress),
  Object.keys((afterPayload && afterPayload.progress) || {}).length);
const afterTs = await ev('window.__faker.row.client_updated_at');
const localStampNow = await ev('S.meta.changedAt');
ok('写入的时间戳 = 数据改动时间（不是随手取 now）', afterTs === localStampNow, { ts: afterTs, stamp: localStampNow });
ok('payload 自带 meta.changedAt（对方设备按它比较）',
  !!(afterPayload && afterPayload.meta && afterPayload.meta.changedAt), afterPayload && afterPayload.meta);

head('E2. 时间几乎相同、内容不同 → 才弹窗问一次');
await ev(`(function(){
  const p = JSON.parse(JSON.stringify(S));
  p.progress = Object.assign({}, p.progress, { remoteA: { st: 1, due: Date.now(), wrong: 0, lastWrong: 0 } });
  p.meta = { changedAt: S.meta.changedAt };
  window.__faker.row = { id: 5, client_updated_at: S.meta.changedAt, payload: p };
  return 1; })()`);
await ev('cloudSyncNow();1');
await sleep(900);
const ask2 = await ev('!!document.getElementById("sync-use-local")');
const askTxt = await ev('(document.getElementById("modal-body")||{}).textContent||""');
ok('真冲突时弹窗', ask2 === true);
ok('弹窗列了两边各有多少词', /这台设备/.test(askTxt) && /云端/.test(askTxt), askTxt.slice(0, 80));
ok('弹窗没把「同时改过」写成「第一次登录」', /几乎同时/.test(askTxt), askTxt.slice(0, 60));

/* ---------------- F. 立即同步：云端较新 → 拉下来并刷新 ---------------- */
head('F. 立即同步：云端较新就把本地换掉');
/* 关掉自动推送的定时器：它 4 秒后会把「本地状态」写进假云端，
   把这里精心构造的「云端更新」覆盖掉，测试就变成自己打自己。 */
await ev('_sync.on = false; 1');
await ev(`(function(){
  const p = JSON.parse(JSON.stringify(S));
  p.progress = Object.assign({}, p.progress, { zzzmark: { st: 1, due: Date.now()+86400e3, wrong: 0, lastWrong: 0 } });
  p.meta = { changedAt: Date.now() + 120000 };      /* 云端改动时间明确晚于本地 */
  window.__faker.row = { id: 7, client_updated_at: Date.now() + 120000, payload: p };
  return 1; })()`);
await ev('openSettings();1');
await sleep(300);
ok('设置页有「立即同步」', (await ev('!!document.getElementById("sync-now")')) === true);
await ev('document.getElementById("sync-now").click();1');
await sleep(500);
console.log('   [dbg] ' + await ev('JSON.stringify({msg:_syncMsg, act:syncDecide(window.__faker.row), lc:localStamp(), rc:remoteStamp(window.__faker.row), n:pushCount(S)})'));
await sleep(6000);   // 700ms 后 reload，再等页面起来
const markInLs = await ev(`(function(){try{const s=JSON.parse(localStorage.getItem('vocabdrill.v2'));return !!(s&&s.progress&&s.progress.zzzmark)}catch(e){return 'ERR:'+e.message}})()`);
ok('云端那份已经写进本地存储', markInLs === true, markInLs);
const remoteGone = await ev(`(function(){try{const s=JSON.parse(localStorage.getItem('vocabdrill.v2'));return !(s&&s.progress&&s.progress.remoteA)}catch(e){return 'ERR'}})()`);
ok('本机原来那份被整份替换（不是合并）', remoteGone === true, remoteGone);

/* ---------------- G. 上传失败要能说出来 ---------------- */
head('G. 云端拒写时报错，不假装成功');
await ev(FAKE);
/* reload 后 cloudBootSync 可能已经因为真 SDK 拿不到会话把登录态清了，这里补回来 */
await ev('_sync = { email: "me@example.com", on: true, localAt: Date.now() }; saveSyncMeta(); 1');
await ev('window.__faker.row = { id: 9, client_updated_at: Date.now()+3600e3, payload: { progress: {} } }; 1');
await ev('window.__faker.failUpdate = true; 1');
const pushRes = await ev('(async()=>{try{return await cloudPushNow(window.__fakeCloud,true)}catch(e){return {err:e.message||String(e)}}})()');
ok('cloudPushNow 把错误抛出来了', !!(pushRes && pushRes.err), pushRes);
ok('错误里带着云端给的原因', !!(pushRes && pushRes.err && /RLS|policy/.test(pushRes.err)), pushRes && pushRes.err);

console.log('\n==== ' + (fails ? '失败 ' + fails + ' 项' : '全部通过') + ' ====');
try { ws.close(); } catch (e) {}
try { proc.kill(); } catch (e) {}
setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {} process.exit(fails ? 1 : 0); }, 400);
