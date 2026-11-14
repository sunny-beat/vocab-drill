'use strict';

/* ================= 常量 ================= */
const DAY = 86400000;
// 各等级再次复习的间隔（天）；lv1 答对→1天后，lv2→2天 …
const INTERVALS = [1, 2, 4, 8, 15, 30, 60, 120];
const MAX_LV = 7;
const BOOKS = {
  cet6:   { name: 'CET-6（含四级）', file: 'cet6.js' },
  kaoyan: { name: '考研（含四六级）', file: 'kaoyan.js' }
};
const PAGES = ['study', 'books', 'dict', 'list'];
const LS_KEY = 'vocabdrill.v2';
const CUSTOM_KEY = 'vocabdrill.custom';   // 自定义词库（单独存，不跟进度混在一起）
const APP_VER = '6.11.4';
const WELCOME_KEY = 'vocabdrill.welcome';
/* 三种常驻答题模式：
 * recog 识别（单词 → 选释义，建立“认得”）
 * spell 拼写（释义 → 写出单词，练“产出”）
 * ctx   语境（挖空例句 → 写出单词，练“在句子里用”）
 * 记忆科学依据：识别最省力，产出最难；语境介于两者且带上下文线索，
 * 三种交替能把“考试里读得懂”和“写作/翻译里用得出”都覆盖到。
 * listen 听写（只给读音 → 写出单词，练“听得出”）是第四种，默认关着：
 *   它要求「听到音就能切出词形」，比拼写更难，也最容易把人卡到放弃，
 *   所以在「设置 → 听写模式」里手动开，开着才在顶栏出现第四个按钮。 */
const MODES = ['recog', 'spell', 'ctx'];
const MODES_ALL = ['recog', 'spell', 'ctx', 'listen'];
const MODE_LABEL = { recog: '识别', spell: '拼写', ctx: '语境', listen: '听写' };
function usableModes() {
  return S.settings.listenOn ? MODES_ALL.slice() : MODES.slice();
}

/* ================= FSRS-6 记忆算法（ts-fsrs 本地全局包） ================= */
/* 评分 1=Again 2=Hard 3=Good；进度字段：{ due, stability, difficulty, last, state, lv, wrong, lastWrong } */
let _FSRS = null;
function F() {
  if (_FSRS) return _FSRS;
  const lib = window.FSRS;
  if (!lib) return null;   // 未加载时各处自动降级到 INTERVALS 表
  _FSRS = lib.fsrs(lib.generatorParameters({
    enable_fuzz: true,
    enable_short_term: false,
    request_retention: (S.settings && S.settings.retention) || 0.9
  }));
  return _FSRS;
}
function levelFromS(s) {
  return Math.max(0, Math.min(7, Math.floor(Math.log2(s + 1))));
}
function fmtInterval(ms) {
  const m = ms / 60000;
  if (m < 60) return Math.max(1, Math.round(m)) + '分';
  if (m < 1440) return Math.round(m / 60) + '小时';
  const dd = Math.round(m / 1440);
  return dd >= 60 ? Math.round(dd / 30) + '个月' : dd + '天';
}
function buildFsrsCard(p, now) {
  if (p && p.stability != null) {
    return {
      due: new Date(p.due || now),
      stability: p.stability,
      difficulty: p.difficulty,
      last_review: p.last ? new Date(p.last) : undefined,
      state: p.state != null ? p.state : 2
    };
  }
  if (p) {
    // 旧版 lv/due 进度迁移
    const s = Math.pow(2, p.lv || 0);
    return {
      due: new Date(p.due || now),
      stability: s,
      difficulty: Math.max(1, Math.min(10, 8 - (p.lv || 0))),
      last_review: p.due ? new Date(p.due - s * DAY) : undefined,
      state: 2
    };
  }
  return window.FSRS ? window.FSRS.createEmptyCard(new Date(now)) : { due: new Date(now), stability: 0, difficulty: 0, state: 0 };
}
/* 下一次到期的时间戳：FSRS 算不出来时退回等级表 */
function nextDueAt(p, g) {
  const Fk = F();
  const now = Date.now();
  if (Fk) {
    try {
      return Fk.next(buildFsrsCard(p, now), new Date(now), g).card.due.getTime();
    } catch (e) { /* 兜底 */ }
  }
  const lv = Math.min((p ? p.lv : 0) + (g === 3 ? 1 : 0), MAX_LV);
  return now + INTERVALS[Math.min(lv, 7)] * DAY;
}
function nextIntervalPreview(p, g) {
  return fmtInterval(nextDueAt(p, g) - Date.now());
}
/* 把到期时间说成人话：明天（10月31日）/ 3 天后（11月2日）——比光写「3天」好懂 */
function fmtDue(ms) {
  const d = new Date(ms);
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const n = Math.round((day1 - day0) / DAY);
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  if (n <= 0) return '今天（' + md + '）';
  if (n === 1) return '明天（' + md + '）';
  if (n < 60) return n + ' 天后（' + md + '）';
  return Math.round(n / 30) + ' 个月后（' + md + '）';
}
/* 记忆留存率：优先用库内 FSRS-6 forgetting_curve（衰减系数随参数走），否则退回 FSRS-5 公式 */
function retrievability(p) {
  if (!p || p.stability == null || !p.last) return null;
  const Fk = F();
  if (Fk && typeof Fk.get_retrievability === 'function') {
    try {
      const r = Fk.get_retrievability(buildFsrsCard(p, Date.now()), new Date(), false);
      if (typeof r === 'number' && isFinite(r)) return Math.round(r * 100);
    } catch (e) { /* 兜底 */ }
  }
  const t = Math.max(0, (Date.now() - p.last) / DAY);
  return Math.round(Math.pow(1 + 19 / 81 * t / p.stability, -0.5) * 100);
}

/* ================= 状态 ================= */
function defaultState() {
  return {
    settings: {
      book: 'cet6', mode: 'recog', newPerDay: 20, autoSpeak: false, theme: 'auto', retention: 0.9,
      reviewMode: 'all',     // wrong=只练错词 | all=背过的到期词都练
      reviewCap: 40,         // 每轮复习量，0 = 不限
      recallFirst: false,    // 识别时先回忆，按需展开选项
      sideCollapsed: false,  // 宽屏时是否把右侧进度边栏收起来
      introBatch: 5,         // 新词先学几个再测，0 = 全部学完再测
      order: 'seq',          // 背词顺序：seq=顺序（按 List 往下 / 最早到期的先）| random=乱序
      listenOn: false,       // 是否解锁「听写」第四模式（默认关，设置里手动开）
      accent: 'us',          // 发音口音：us=美音 | uk=英音（都走有道在线音频）
      voiceName: ''          // v6.9.4 起不再用系统语音，只在旧数据里留个字段，读到时忽略
    },
    progress: {},   // word -> { lv, due, wrong, lastWrong, lastG }
    days: {},       // 'YYYY-MM-DD' -> { n, r }
    books: {},      // bookId -> { chapter: 当前章节下标 }
    stars: {},      // word -> 1 收藏 | 2 重点收藏
    pause: {},      // word -> 0 = 已掌握（永久不再复习）；老数据里可能残留未来时间戳，一律忽略
    notes: {},      // word -> '我自己的释义 / 备注'（盖在词典释义上方显示）
    rt: {},         // 反应时样本：模式 -> [毫秒]，用来把「磨蹭」阈值调成你自己的节奏
    confuse: {},    // word -> { 混淆词: 次数 }。答错时选中的那个释义属于谁，就记谁 —— 这是「辨析训练」的原料
    skills: {},     // word -> { 模式: { n, ok, msn, ms, hint } } 技能画像：同一个词在四种模式下的表现分开记
    shist: [],      // 查词历史（最近 12 个）
    session: null,  // 会话快照（中途可接续）
    studyPaused: {}, // 按词书和任务保存暂停的学习位置
    page: 'study',
    /* v6.9.3：同步用的「内容时间戳」。只在**数据真的变了**时更新（见 save()），
       不能拿「打开页面的时间」冒充 —— 旧版就是拿登录时刻当本地更新时间，
       导致新设备一登录就自认比云端新，把空进度推上去覆盖了真进度。 */
    meta: { changedAt: 0 }
  };
}
/* 存储适配层。
 * 坑：某些内置浏览器 / 隐私模式下访问 localStorage 本身就抛 SecurityError，
 * 写满时 setItem 抛 QuotaExceededError。以前 save() 是裸调用，
 * 一抛就把整条渲染链断掉 —— 表现就是「有时候白屏打不开」。
 * 现在统一降级到内存，并只提醒一次，页面绝不因为存不下而崩。 */
let _mem = {};
let _storeWarned = false;
function lsGet(k) {
  try { return localStorage.getItem(k); }
  catch (e) { return Object.prototype.hasOwnProperty.call(_mem, k) ? _mem[k] : null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); _mem[k] = v; return true; }
  catch (e) {
    _mem[k] = v;
    if (!_storeWarned) {
      _storeWarned = true;
      const quota = /quota|exceed/i.test((e && (e.name + ' ' + e.message)) || '');
      setTimeout(function () {
        toast(quota
          ? '本地存储满了，进度暂时只放在内存里 —— 先去「设置 → 导出备份」存一份，再清掉些旧进度'
          : '这个浏览器不让本地保存（隐私模式 / 内置浏览器），进度只存在内存里，关掉页面就没了 —— 改用 Edge 或 Chrome 打开');
      }, 800);
    }
    return false;
  }
}

function loadState() {
  // 优先读 v2，其次迁移 v1（保留进度、统计与设置）
  let s = null;
  try { s = JSON.parse(lsGet(LS_KEY)); } catch (e) { /* ignore */ }
  if (!s) {
    try { s = JSON.parse(lsGet('vocabdrill.v1')); } catch (e) { /* ignore */ }
  }
  const d = defaultState();
  if (s && typeof s === 'object') {
    s.settings = Object.assign(d.settings, s.settings || {});
    // 听音辨意模式已下线，老进度统一回落到「识别（四选一）」
    if (MODES_ALL.indexOf(s.settings.mode) < 0) s.settings.mode = 'recog';
    // 听写是可选模式：没在设置里打开就退回识别，免得顶栏没有按钮却停在听写卡上
    if (s.settings.mode === 'listen' && !s.settings.listenOn) s.settings.mode = 'recog';
    if (!BOOKS[s.settings.book] && s.settings.book !== 'custom') s.settings.book = 'cet6';   // 旧数据里的四级书已并入六级
    if (s.settings.reviewMode !== 'wrong' && s.settings.reviewMode !== 'all') s.settings.reviewMode = 'all';
    s.settings.recallFirst = s.settings.recallFirst === true;
    if (s.settings.reviewCap == null) s.settings.reviewCap = 40;
    if (s.settings.introBatch == null) s.settings.introBatch = 5;
    if (s.settings.order !== 'random') s.settings.order = 'seq';
    // v6.9.4：发音改成有道在线音频后，音色由「美音/英音」决定，其他值一律当美音
    if (s.settings.accent !== 'uk' && s.settings.accent !== 'us') s.settings.accent = 'us';
    s.rt = (s.rt && typeof s.rt === 'object') ? s.rt : {};
    s.confuse = (s.confuse && typeof s.confuse === 'object') ? s.confuse : {};
    s.skills = (s.skills && typeof s.skills === 'object') ? s.skills : {};
    s.progress = s.progress || {};
    for (const k in s.progress) {
      const p = s.progress[k];
      if (p.wrong == null) p.wrong = 0;
      if (p.lastWrong == null) p.lastWrong = 0;
    }
    s.days = s.days || {};
    s.books = (s.books && typeof s.books === 'object') ? s.books : {};
    s.stars = (s.stars && typeof s.stars === 'object') ? s.stars : {};
    s.pause = (s.pause && typeof s.pause === 'object') ? s.pause : {};
    s.notes = (s.notes && typeof s.notes === 'object') ? s.notes : {};
    s.shist = Array.isArray(s.shist) ? s.shist : [];
    s.meta = (s.meta && typeof s.meta === 'object') ? s.meta : { changedAt: 0 };
    s.meta.changedAt = +s.meta.changedAt || 0;
    s.session = (s.session && typeof s.session === 'object' && Array.isArray(s.session.queue)) ? s.session : null;
    s.studyPaused = s.studyPaused && typeof s.studyPaused === 'object' && !Array.isArray(s.studyPaused) ? s.studyPaused : {};
    s.page = PAGES.indexOf(s.page) >= 0 ? s.page : 'study';
    return s;
  }
  return d;
}
let S = loadState();

/* 内容指纹：判断「这次保存是不是真有改动」。绝大多数字段是整数，做滚动哈希即可，
   5000 词大约 0.3ms —— 比 JSON.stringify 整个 payload 便宜一个量级，每次作答都算也不心疼。
   fpOf 要能算「任意一份 payload」（云端那份也要算），所以参数是 p 而不是直接读 S。 */
function fpOf(p) {
  let h = 2166136261;
  const mix = function (n) { h ^= (n | 0); h = Math.imul(h, 16777619); };
  const pr = (p && p.progress) || {};
  for (const k in pr) {
    const q = pr[k] || {};
    let x = 7;
    for (let i = 0; i < k.length; i++) x = (Math.imul(x, 31) + k.charCodeAt(i)) | 0;
    mix(x); mix(+q.lv || 0); mix(+q.due || 0); mix(+q.wrong || 0);
  }
  const small = [p && p.stars, p && p.pause, p && p.notes, p && p.books, p && p.settings];
  for (let i = 0; i < small.length; i++) {
    const t = JSON.stringify(small[i] || {});
    mix(t.length);
    for (let j = 0; j < t.length; j += 5) mix(t.charCodeAt(j));
  }
  return h | 0;
}
function stateFp() { return fpOf(S); }
let _fpLast = stateFp();
let _fpHold = 0;          // >0 表示「这次写入不是用户改的」（套用云端 / 导入备份），别刷新时间戳
function save() {
  if (_fpHold) {
    _fpLast = stateFp();
  } else {
    const fp = stateFp();
    if (fp !== _fpLast) {
      _fpLast = fp;
      S.meta.changedAt = Date.now();   // 只有内容真的变了才算「本地改动」
    }
  }
  try { lsSet(LS_KEY, JSON.stringify(S)); } catch (e) { /* 序列化失败也不能崩，下次再存 */ }
  schedulePush();
}

/* ================= 账号与云同步（WorkBuddy 云服务） =================
 * 设计取舍，改之前先读：
 * 1. SDK 用 CDN **懒加载** —— 只有真去点「登录 / 同步」才拉。单文件版因此仍是零外链，
 *    离线打开也完全不碰网络；`smoke-standalone.mjs` 的「没有外链脚本」断言靠这个成立。
 * 2. 云端只认发布域名（服务端做 exact-Origin 校验）。file:// / 127.0.0.1 上登录必然 401，
 *    所以这里**提前判断并给一句人话**，而不是让用户看着一个英文 401 发懵。
 *    `?cloud=1` 是本地调试用的强制开关，别在正式说明里提。
 * 3. 冲突策略（v6.9.3 重做）：**按数据自己的改动时间**，谁新用谁。
 *    时间戳来源是 `S.meta.changedAt`（内容指纹变了才刷新，见 save()），
 *    不是 `_sync.localAt`（那是「这台设备最后一次 save」，包括打开页面、切主题这种没改数据的写入）。
 *    ⚠️ v6.9.2 之前的 bug：新设备一登录就把 localAt 设成 now，于是它永远「比云端新」，
 *    同步时把自己的空进度推上去，把另一台设备的真进度盖掉。线上真出现过一次（云端 progress 变成 {}）。
 * 4. **空数据永不主动上传**。一条 progress 都没有的设备，第一次登录只会拉、不会推。
 */
const CLOUD_CFG = {
  endpoint: 'https://vocab-drill-12129.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_GhGkhjbypAQ36ldZOT2F1p_khDKSQ58F1hRKgKQUyHo74ZSWXo5GbCY'
};
const SYNC_KEY = 'vocabdrill.sync';
/* SDK 加载源（按顺序试，谁先成功用谁）。
   优先用随站点一起发布的自托管副本：jsDelivr 的默认域名在国内经常被重置（SSL 直接断），
   而"登录"这条路上只要 SDK 下不下来就整条不可用，所以不能把 CDN 当唯一来源。
   后三个只是兜底 —— 自托管那份挂了（比如换域名）才会走到它们。 */
const CLOUD_SDK_URLS = [
  'js/vendor/cloud-sdk.js',
  'https://fastly.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js',
  'https://gcore.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js',
  'https://unpkg.com/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js'
];
const SYNC_TABLE = 'progress';

let _cloud = null;
let _cloudLoad = null;
let _sync = (function () {
  try { return JSON.parse(lsGet(SYNC_KEY)) || {}; } catch (e) { return {}; }
})();
/* 老数据没有 meta.changedAt：用旧版记的「最后一次本地保存时间」补一个近似值。
   旧版里 localAt 每次 save 都会刷新，比真实改动时间略新，但量级接近，够用来做一次性迁移。 */
if (S.meta && !S.meta.changedAt && hasStudyData(S) && _sync.localAt) S.meta.changedAt = +_sync.localAt || 0;
let _otp = null;          // { email, verificationId, isExistingUser }
let _pushTimer = 0;
let _pushBusy = false;
let _syncing = false;
let _syncMsg = '';
let _draftEmail = '';

function saveSyncMeta() {
  try { lsSet(SYNC_KEY, JSON.stringify(_sync)); } catch (e) { /* 存不下就只留内存 */ }
}

function errMsg(e) {
  return (e && (e.message || e.error_description || e.msg)) || String(e || '未知错误');
}

/* 云端只在发布域名下可用 */
function cloudOriginOk() {
  if (/[?&]cloud=1/.test(location.search)) return true;      // 仅调试
  try { return location.origin === CLOUD_CFG.endpoint; } catch (e) { return false; }
}
function cloudSupportMsg() {
  if (location.protocol === 'file:') {
    return '你现在是双击打开本地文件 —— 云端同步要用线上链接才行（手机、电脑都打开同一个链接）。' +
      '只想搬一次进度的话，用下面的「导出备份 / 导入备份」也一样。';
  }
  if (window.VD_STANDALONE) {
    return '这是单文件离线版，不含云端同步。要同步请打开线上链接。';
  }
  return '云端同步只在发布域名下可用（当前是 ' + location.host + '）。打开线上链接就能登录。';
}

/* 单个来源装一次 script；成功 resolve，失败/超时 reject */
function loadScriptOnce(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error('timeout'));
    }, timeoutMs);
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = function () {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve();
    };
    s.onerror = function () {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(new Error('error'));
    };
    document.head.appendChild(s);
  });
}

function loadCloudSdk() {
  if (_cloud) return Promise.resolve(_cloud);
  if (_cloudLoad) return _cloudLoad;
  /* 已经被同步引入过（自托管副本用普通 script 标签引进来也一样）就直接用 */
  if (window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function') {
    try {
      _cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CLOUD_CFG.endpoint,
        oauthRelayBaseUrl: CLOUD_CFG.oauthRelayBaseUrl,
        publishableKey: CLOUD_CFG.publishableKey
      });
      return Promise.resolve(_cloud);
    } catch (e) { /* 落到下面走正常加载 */ }
  }
  _cloudLoad = (async function () {
    let lastErr = null;
    for (let i = 0; i < CLOUD_SDK_URLS.length; i++) {
      /* 本地那份给足时间；CDN 兜底每个只等 6 秒，别让用户对着转圈发呆 */
      const budget = i === 0 ? 12000 : 6000;
      try {
        await loadScriptOnce(CLOUD_SDK_URLS[i], budget);
        const api = window.WorkBuddyCloud;
        if (!api || typeof api.createWorkBuddyCloud !== 'function') throw new Error('SDK 没就绪');
        _cloud = api.createWorkBuddyCloud({
          endpoint: CLOUD_CFG.endpoint,
          oauthRelayBaseUrl: CLOUD_CFG.oauthRelayBaseUrl,
          publishableKey: CLOUD_CFG.publishableKey
        });
        return _cloud;
      } catch (e) { lastErr = e; }
    }
    throw new Error('SDK 加载失败（本地和 CDN 都没拿到），检查一下网络 —— ' + errMsg(lastErr));
  })();
  _cloudLoad.catch(function () { _cloudLoad = null; });   // 失败后允许重试
  return _cloudLoad;
}
/* 调试出口（只在 ?cloud=1 时挂上）：让探针能直接验「本地副本 / CDN 兜底」这条链，
   不用点 UI。生产路径不依赖它。 */
if (/[?&]cloud=1/.test(location.search)) {
  window.__vdCloud = { load: loadCloudSdk, originOk: cloudOriginOk, urls: CLOUD_SDK_URLS.slice() };
}
/* 调试出口（只在 ?debug=1 时挂上）：让 tools/probe-order.mjs 这类探针能直接检查
   取词 / 复习计划这些内部函数，不用靠点 UI 猜。生产路径不读它。 */
if (/[?&]debug=1/.test(location.search)) {
  window.__vd = {
    state: function () { return S; },
    newWords: function (n, ch, strict) { return newWords(n, ch, strict); },
    reviewPlan: function () { return reviewPlan(); },
    setOrder: function (o) { S.settings.order = o === 'random' ? 'random' : 'seq'; },
    words: function () { return WORDS.map(function (it) { return it[0]; }); }
  };
}

/* 推上云端的载荷：去掉纯设备本地的几项（会话快照、当前页、查词历史） */
function syncPayload() {
  const p = JSON.parse(JSON.stringify(S));
  delete p.session;
  delete p.studyPaused;
  delete p.page;
  delete p.shist;
  return p;
}

async function cloudRow(cloud) {
  const r = await cloud.database.from(SYNC_TABLE).select('id, payload, client_updated_at').maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}

/* 一条进度都没有 = 空壳。空壳永不主动上传 —— 这是 v6.9.2 那次「手机把空进度推上去」的根治。 */
function hasStudyData(p) {
  if (!p) return false;
  return pushCount(p) > 0 ||
    Object.keys(p.stars || {}).length > 0 ||
    Object.keys(p.notes || {}).length > 0;
}

/* 两端各自的「数据改动时间」。
   云端优先用 payload 自带的 meta.changedAt；老版本推上去的没有这个字段，
   退回 client_updated_at（老版本里那列就是上传时刻，语义接近，够用）。 */
function localStamp() { return +((S.meta || {}).changedAt) || 0; }
function remoteStamp(row) {
  const m = row && row.payload && row.payload.meta;
  return (+(m && m.changedAt) || 0) || Number((row && row.client_updated_at) || 0);
}

/* 2 秒内算「同一时刻」：设备间毫秒级抖动不该让它俩来回抢 */
const STAMP_SLACK = 2000;

/* 这次该干什么：'push' | 'pull' | 'same' | 'ask'
   一句话规则：谁的数据改得晚用谁的；空的那边永远让位。 */
function syncDecide(row) {
  const lHas = hasStudyData(S);
  const rHas = row ? hasStudyData(row.payload) : false;
  if (!row) return lHas ? 'push' : 'same';
  if (!lHas && !rHas) return 'same';
  if (!lHas) return 'pull';
  if (!rHas) return 'push';
  const lc = localStamp(), rc = remoteStamp(row);
  if (rc > lc + STAMP_SLACK) return 'pull';
  if (lc > rc + STAMP_SLACK) return 'push';
  /* 时间几乎一样：比内容。相同就什么都不做，不同才是真冲突（两台设备同时改），问一次。 */
  return samePayload(row) ? 'same' : 'ask';
}

function samePayload(row) {
  try {
    const cur = syncPayload();
    const tot = JSON.stringify(row.payload || {});
    if (JSON.stringify(cur) === tot) return true;
    return fpOf(cur) === fpOf(row.payload) &&
      pushCount(cur) === pushCount(row.payload);
  } catch (e) { return false; }
}

async function cloudPushNow(cloud, force) {
  if (!_sync.email) return { skipped: 'nologin' };
  if (!hasStudyData(S) && !force) return { skipped: 'empty' };
  const payload = syncPayload();
  let ts = localStamp();
  if (force || !ts) {
    /* 用户明确说「用这份覆盖」或本机从没记过时间：取 now，并把它写进 payload，
       这样对方设备下次比较时用的是同一个时钟来源，而不是各自的登录时刻。 */
    ts = Math.max(ts, Date.now());
    payload.meta = Object.assign({}, payload.meta, { changedAt: ts });
    S.meta.changedAt = ts;
    _fpLast = stateFp();
  }
  const row = await cloudRow(cloud);
  if (row && !force && remoteStamp(row) > ts) return { skipped: 'stale' };
  /* 内容没变就别写库：省一次无意义的 client_updated_at 漂移，也少一次失败机会 */
  if (row && !force && samePayload(row)) {
    _sync.remoteAt = remoteStamp(row);
    _sync.lastAt = Date.now();
    saveSyncMeta();
    return { skipped: 'same' };
  }
  if (row) {
    const up = await cloud.database.from(SYNC_TABLE)
      .update({ payload: payload, client_updated_at: ts })
      .eq('id', row.id).select();
    if (up.error) throw up.error;
    if (!Array.isArray(up.data) || !up.data.length) throw new Error('云端拒绝了这次写入');
  } else {
    const ins = await cloud.database.from(SYNC_TABLE)
      .insert({ payload: payload, client_updated_at: ts }).select();
    if (ins.error) throw ins.error;
  }
  _sync.remoteAt = ts;
  _sync.localAt = ts;
  _sync.lastAt = Date.now();
  saveSyncMeta();
  return { ok: true };
}

/* 用云端那份覆盖本地（保留纯设备本地的字段：会话快照、当前页、查词历史） */
function applyRemotePayload(remote, stamp) {
  const d = defaultState();
  const keep = { session: S.session, page: S.page, shist: S.shist };
  const next = Object.assign(d, remote || {});
  next.settings = Object.assign(d.settings, (remote && remote.settings) || {});
  next.session = keep.session || null;
  next.studyPaused = S.studyPaused;
  next.page = keep.page || 'study';
  next.shist = keep.shist || [];
  /* 时间戳跟着云端走 —— 绝不能因为「刚从云端套用」就把它刷成 now，
     那等于把本地又变成「最新」，下次同步反过来把云端覆盖一遍（旧版就是这么循环的）。 */
  next.meta = { changedAt: +stamp || +((remote && remote.meta && remote.meta.changedAt)) || 0 };
  _fpHold++;
  try {
    S = next;
    save();
  } finally {
    _fpHold--;
    _fpLast = stateFp();
  }
  applyTheme();
}

/* 拉到云端进度后统一收尾：记元数据 + 提示 + 刷新 */
function pullAndReload(row, msg) {
  applyRemotePayload(row.payload, remoteStamp(row));
  _sync.remoteAt = remoteStamp(row);
  _sync.localAt = _sync.remoteAt;
  _sync.lastAt = Date.now();
  _sync.lastErr = '';
  saveSyncMeta();
  if (msg) toast(msg);
  setTimeout(function () { location.reload(); }, 700);
}

function pushCount(p) {
  try { return Object.keys((p && p.progress) || {}).length; } catch (e) { return 0; }
}

function schedulePush() {
  if (!_sync || !_sync.on || !_sync.email) return;
  /* 不要在这里更新任何时间戳：save() 会因为「切页面 / 换主题 / 套用云端」被调用，
     那些都不是数据改动。本地改动时间只由 save() 里的内容指纹决定。 */
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(function () { cloudAutoPush(); }, 4000);
}

async function cloudAutoPush() {
  if (_pushBusy || !_sync.on || !_sync.email || !cloudOriginOk()) return;
  _pushBusy = true;
  try {
    const cloud = await loadCloudSdk();
    await cloudPushNow(cloud, false);
  } catch (e) {
    /* 自动推送失败不打扰用户：下次保存会再来一次；手动同步才报错 */
    _sync.lastErr = errMsg(e);
    saveSyncMeta();
  } finally {
    _pushBusy = false;
  }
}

/* 手动同步：拉下来 → 按「数据改动时间」定谁新 → 谁新用谁 */
async function cloudSyncNow() {
  if (_syncing) return;
  _syncing = true;
  _syncMsg = '正在同步…';
  refreshSyncPanel();
  try {
    const cloud = await loadCloudSdk();
    const row = await cloudRow(cloud);
    const act = syncDecide(row);
    if (act === 'pull') {
      _syncing = false;
      pullAndReload(row, '已拉取云端进度，正在刷新…');
      return;
    }
    if (act === 'push') {
      const r = await cloudPushNow(cloud, true);
      _syncMsg = r && r.skipped === 'same' ? '两边一致，无需同步' : '已上传到云端';
    } else if (act === 'same') {
      _syncMsg = '两边一致，无需同步';
    } else {
      _syncMsg = '';
      askSyncSide(pushCount(S), pushCount(row.payload), row);
    }
    _sync.lastErr = '';
    saveSyncMeta();
  } catch (e) {
    _syncMsg = '同步失败：' + errMsg(e);
  }
  _syncing = false;
  refreshSyncPanel();
}

/* 登录后的第一次对账：统一走 syncDecide —— 谁的数据改得晚用谁的，空的那边永远让位。
   只有「两边都有数据、改动时间几乎相同、内容却不一样」才弹窗问一次（那是真的同时改了两边）。 */
async function cloudFirstSync(cloud) {
  let row = null;
  try { row = await cloudRow(cloud); } catch (e) {
    _syncMsg = '读云端失败：' + errMsg(e); refreshSyncPanel(); return;
  }
  const act = syncDecide(row);
  if (act === 'pull') { pullAndReload(row, '已拉取云端进度，正在刷新…'); return; }
  if (act === 'push') {
    const r = await cloudPushNow(cloud, false);
    _syncMsg = r && r.skipped === 'same' ? '云端已是最新' : '已把本机进度上传到云端';
    refreshSyncPanel();
    return;
  }
  if (act === 'same') {
    _syncMsg = row ? '两边一致' : '';
    if (row) {
      _sync.remoteAt = remoteStamp(row);
      _sync.localAt = _sync.remoteAt;
      _sync.lastAt = Date.now();
    }
    saveSyncMeta();
    refreshSyncPanel();
    return;
  }
  askSyncSide(pushCount(S), pushCount(row.payload), row);
}

function askSyncSide(localN, remoteN, row) {
  const body = $('modal-body');
  if (!body) return;
  body.innerHTML =
    '<h2>两边几乎同时改过，用哪一边？</h2>' +
    '<p class="s-hint">同步是整份覆盖、没法逐词合并，所以问一次。选错的话另一边的进度会被盖掉' +
    '（本机那份可以先在「设置 → 导出备份」存一份）。</p>' +
    '<div class="panel" style="font-size:13px;line-height:1.9">' +
    '· 这台设备：<b>' + localN + '</b> 个词有进度' + (localStamp() ? '（改动于 ' + new Date(localStamp()).toLocaleString() + '）' : '') + '<br>' +
    '· 云端：<b>' + remoteN + '</b> 个词有进度' + (remoteStamp(row) ? '（改动于 ' + new Date(remoteStamp(row)).toLocaleString() + '）' : '') +
    '</div>' +
    '<div class="actions sync-choose" style="margin-top:12px">' +
    '<button id="sync-use-local" class="big primary">用这台设备的（覆盖云端）</button>' +
    '<button id="sync-use-remote" class="big">用云端的（覆盖这台）</button>' +
    '</div>';
  $('modal').classList.remove('hidden');
  $('sync-use-local').addEventListener('click', function () {
    const cloud = _cloud;
    cloudPushNow(cloud, true).then(function () {
      _syncMsg = '已用本机进度覆盖云端';
      saveSyncMeta();
      openSettings();
    }, function (e) {
      _syncMsg = '上传失败：' + errMsg(e);
      openSettings();
    });
  });
  $('sync-use-remote').addEventListener('click', function () {
    _syncMsg = '';
    pullAndReload(row, '已用云端进度覆盖本机，正在刷新…');
  });
}

async function cloudSendCode(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    _syncMsg = '邮箱格式不对，检查一下';
    refreshSyncPanel();
    return;
  }
  if (!cloudOriginOk()) { _syncMsg = cloudSupportMsg(); refreshSyncPanel(); return; }
  _draftEmail = email;
  _syncMsg = '正在发送…';
  refreshSyncPanel();
  try {
    const cloud = await loadCloudSdk();
    const sent = await cloud.auth.sendOtp({ email: email });
    if (sent.error) { _syncMsg = '发不出去：' + errMsg(sent.error); refreshSyncPanel(); return; }
    _otp = {
      email: email,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser
    };
    _syncMsg = '';
    refreshSyncPanel();
  } catch (e) {
    _syncMsg = '发不出去：' + errMsg(e);
    refreshSyncPanel();
  }
}

async function cloudVerifyCode(code) {
  if (!_otp) { _syncMsg = '先点「发送验证码」'; refreshSyncPanel(); return; }
  if (!/^\d{4,8}$/.test(String(code || '').trim())) {
    _syncMsg = '验证码是几位数字，再检查一下';
    refreshSyncPanel();
    return;
  }
  _syncMsg = '正在验证…';
  refreshSyncPanel();
  try {
    const cloud = await loadCloudSdk();
    const done = await cloud.auth.verifyOtp({
      email: _otp.email,
      verificationId: _otp.verificationId,
      isExistingUser: _otp.isExistingUser,
      token: String(code).trim()
    });
    if (done.error) { _syncMsg = '登录失败：' + errMsg(done.error); refreshSyncPanel(); return; }
    /* 注意：SDK 的 user 对象是 { id, name, avatarUrl, isAnonymous, raw }，
       邮箱不在顶层，只在 raw 里 —— 拿不到就退回用户输入的地址 */
    const user = (done.data && done.data.user) || {};
    _sync.email = user.email || (user.raw && user.raw.email) || _otp.email;
    _sync.on = true;
    /* 这里**不要**动任何时间戳。旧版在这一行 `_sync.localAt = Date.now()`，
       等于给「刚登录、还没学过一个词」的新设备打上「我比云端新」的标记，
       于是第一次对账/自动推送就会把空进度写上去 —— 线上真丢过一次。 */
    _sync.lastAt = 0;
    _sync.lastErr = '';
    saveSyncMeta();
    _otp = null;
    _syncMsg = '登录成功，正在对账…';
    refreshSyncPanel();
    await cloudFirstSync(cloud);
  } catch (e) {
    _syncMsg = '登录失败：' + errMsg(e);
    refreshSyncPanel();
  }
}

async function cloudSignOut() {
  try {
    const cloud = await loadCloudSdk();
    await cloud.auth.signOut();
  } catch (e) { /* 退出失败也把本地标记清掉 */ }
  _sync = { localAt: _sync.localAt };
  saveSyncMeta();
  _otp = null;
  _syncMsg = '已退出，进度不会再上传';
  openSettings();
}

function timeAgo(ts) {
  if (!ts) return '';
  const d = Math.max(0, Date.now() - ts);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  return Math.floor(d / 86400e3) + ' 天前';
}

function syncPanelHtml() {
  if (!cloudOriginOk()) {
    return '<p class="s-hint">' + esc(cloudSupportMsg()) + '</p>';
  }
  if (!_sync.email) {
    if (!_otp) {
      return '<div class="set-row"><label for="sync-email">邮箱</label>' +
        '<input id="sync-email" class="set-input" type="email" inputmode="email" autocomplete="email" ' +
        'placeholder="you@example.com" value="' + esc(_draftEmail) + '"></div>' +
        '<p class="s-hint" id="sync-msg">' + esc(_syncMsg || '登录后手机和电脑共用一份进度。第一次登录会发一封验证码邮件。') + '</p>' +
        '<div class="actions split"><button id="sync-send" class="big primary">发送验证码</button></div>';
    }
    return '<p class="s-hint">验证码已发到 <b>' + esc(_otp.email) + '</b>，几分钟内有效。' +
      '<button id="sync-back" class="linkhint">换个邮箱</button></p>' +
      '<div class="set-row"><label for="sync-code">验证码</label>' +
      '<input id="sync-code" class="set-input" type="text" inputmode="numeric" autocomplete="one-time-code" ' +
      'maxlength="8" placeholder="邮件里的数字"></div>' +
      '<p class="s-hint" id="sync-msg">' + esc(_syncMsg || '') + '</p>' +
      '<div class="actions split">' +
      '<button id="sync-verify" class="big primary">登录 / 注册</button>' +
      '<button id="sync-resend" class="big">重新发送</button></div>';
  }
  const lc = localStamp(), rc = +_sync.remoteAt || 0;
  return '<p class="s-hint">已登录：<b>' + esc(_sync.email) + '</b>' +
    (_sync.lastAt ? ' · 上次同步 ' + timeAgo(_sync.lastAt) : ' · 还没同步过') +
    (_sync.lastErr ? '<br>上次自动同步失败：' + esc(_sync.lastErr) : '') + '</p>' +
    /* 这一行是排障用的：同步按「数据改动时间」判断谁新，两个时间要能直接看见 */
    '<p class="s-hint">本机数据改动：<b>' + (lc ? timeAgo(lc) : '还没学过') + '</b>' +
    (rc ? ' · 云端：' + timeAgo(rc) : '') +
    ' <i style="opacity:.6">（同步以改动更晚的一边为准）</i></p>' +
    '<p class="s-hint" id="sync-msg">' + esc(_syncMsg || '改动作答会自动上传，换台设备登录同一个邮箱就能接上。') + '</p>' +
    '<div class="actions split">' +
    '<button id="sync-now" class="big primary">立即同步</button>' +
    '<button id="sync-out" class="big">退出登录</button></div>';
}

/* 面板状态变了就整块重画（设置弹窗是整块 innerHTML 重绘的，跟着它走最省事） */
function refreshSyncPanel() {
  if ($('modal') && $('modal').classList.contains('hidden')) return;
  if (!$('sync-panel')) return;
  openSettings();
}

/* 启动后自动对账：登录过就跑一次，规则和手动同步完全一致（syncDecide） */
async function cloudBootSync() {
  if (!_sync.on || !_sync.email || !cloudOriginOk()) return;
  try {
    const cloud = await loadCloudSdk();
    /* 先确认会话还有效：清过浏览器数据 / 刷新令牌过期时会走到这里，
       与其让用户看到一行英文 401，不如安静退回「未登录」等他重新登一次 */
    const sess = await cloud.auth.getSession();
    if (!sess || !sess.data) {
      _sync = { localAt: _sync.localAt };
      saveSyncMeta();
      return;
    }
    const row = await cloudRow(cloud);
    const act = syncDecide(row);
    if (act === 'pull') {
      pullAndReload(row, '已同步云端的进度');
    } else if (act === 'push') {
      await cloudPushNow(cloud, false);
    } else if (act === 'same' && row) {
      _sync.remoteAt = remoteStamp(row);
      _sync.lastAt = Date.now();
      saveSyncMeta();
    }
    /* 'ask' 不在启动时弹窗：等用户主动开「设置」或点同步再问，免得一开页就被挡住 */
  } catch (e) {
    _sync.lastErr = errMsg(e);
    saveSyncMeta();
  }
}


function todayStr(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * DAY);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function fmtDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function dayRec(create) {
  const t = todayStr();
  if (S.days[t]) return S.days[t];
  if (create) { S.days[t] = { n: 0, r: 0 }; return S.days[t]; }
  return { n: 0, r: 0 };
}
function streakDays() {
  let n = 0, off = 0;
  const t0 = S.days[todayStr()];
  if (!(t0 && t0.n + t0.r > 0)) off = 1;
  while (true) {
    const rec = S.days[todayStr(-off)];
    if (rec && rec.n + rec.r > 0) { n++; off++; } else break;
  }
  return n;
}

/* ================= 词库加载 ================= */
function ensureBook(id) {
  if (window.VD_DATA && VD_DATA[id]) return Promise.resolve(VD_DATA[id]);
  return new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = 'data/' + BOOKS[id].file;
    s.onload = function () { resolve(window.VD_DATA[id]); };
    s.onerror = function () { reject(new Error('词库文件加载失败：' + BOOKS[id].file)); };
    document.head.appendChild(s);
  });
}

let ALL_LOADED = false;
let DICT = null;   // word(lower) -> { w, defs, phrases, books[] }

/* ================= 通用字典（9.8 万词，只管查，不用来背） =================
 * 和两本词书的分工：
 *   词书 → 负责「背」，有例句、有 FSRS 进度、有错词本；
 *   字典 → 负责「查」，任何词都能查到中文释义，但不进复习队列。
 * 字典是 8MB 的独立文件，只在进查词页时才加载；单文件版里它被内联，
 * window.VD_DICT 已经存在，所以 ensureDict() 直接短路。
 */
let LEX = null;
let LEX_WORDS = null;
let LEX_LOAD = null;

/* 考试标签词的「短语 / 例句 / 近义词」。字典本身只有中文释义 + 音标，
 * 这几样是 tools/fetch_exam.mjs 逐个抓来的（同一次抓取只跑一次，结果存 data/exam.js）。
 * 单独一个文件而不是塞进 dict.js：dict.js 由 build_dict.py 生成，两边管线互不干扰；
 * 它比字典小得多（约 3.7MB），加载完才刷新一次卡片，不会让首屏等它。 */
let EXAM = null;
let EXAM_LOAD = null;
/* 真题例句（data/paper.js）：{ 词: [[英文, 出处], ...] }。
 * 这是「这个词在哪一年的哪张卷子上出现过」的唯一来源 —— 比任何词典例句都有说服力，
 * 所以有它就优先显示，没有才退回词典例句。 */
let PAPER = null;
let PAPER_LOAD = null;

function examInit() {
  EXAM = window.VD_EXAM || null;
  return !!EXAM;
}
function paperInit() {
  PAPER = window.VD_PAPER || null;
  return !!PAPER;
}
function ensurePaper() {
  if (paperInit()) return Promise.resolve(PAPER);
  if (PAPER_LOAD) return PAPER_LOAD;
  PAPER_LOAD = new Promise(function (resolve) {
    const s = document.createElement('script');
    s.src = 'data/paper.js';
    s.async = true;
    s.onload = function () { resolve(paperInit() ? PAPER : null); };
    s.onerror = function () { PAPER_LOAD = null; resolve(null); };
    document.head.appendChild(s);
  });
  return PAPER_LOAD;
}
function ensureExam() {
  if (examInit()) return Promise.resolve(EXAM);
  if (EXAM_LOAD) return EXAM_LOAD;
  EXAM_LOAD = new Promise(function (resolve) {
    const s = document.createElement('script');
    s.src = 'data/exam.js';
    s.async = true;
    /* 拿不到就算了：没有它只是查词卡少几块，不该挡住查词这个主功能 */
    s.onload = function () { resolve(examInit() ? EXAM : null); };
    s.onerror = function () { EXAM_LOAD = null; resolve(null); };
    document.head.appendChild(s);
  });
  return EXAM_LOAD;
}

function lexInit() {
  if (LEX_WORDS) return true;
  LEX = window.VD_DICT || null;
  if (!LEX) return false;
  LEX_WORDS = Object.keys(LEX).sort();
  return true;
}
function ensureDict() {
  if (lexInit()) { examInit(); return Promise.resolve(LEX); }
  if (LEX_LOAD) return LEX_LOAD;
  LEX_LOAD = new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = 'data/dict.js';
    s.async = true;
    s.onload = function () {
      if (lexInit()) {
        /* 字典一到位就把考试标签的短语/例句、真题例句跟上；任何一个失败都不影响查词 */
        Promise.all([ensureExam(), ensurePaper()]).then(function () { resolve(LEX); },
          function () { resolve(LEX); });
      } else { LEX_LOAD = null; reject(new Error('字典内容不对')); }
    };
    s.onerror = function () { LEX_LOAD = null; reject(new Error('字典文件加载失败')); };
    document.head.appendChild(s);
  });
  return LEX_LOAD;
}
/* 前缀查找走二分 —— 千万别遍历 9.8 万个 key，那是每次敲键盘都卡一下 */
function lexPrefix(q, max) {
  if (!LEX_WORDS || !q) return [];
  let lo = 0, hi = LEX_WORDS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (LEX_WORDS[mid] < q) lo = mid + 1; else hi = mid;
  }
  const out = [];
  for (let i = lo; i < LEX_WORDS.length && out.length < max; i++) {
    const w = LEX_WORDS[i];
    if (!w.startsWith(q)) break;
    if (w !== q && !DICT.has(w)) out.push(w);
  }
  return out;
}
function lexContains(q, max) {
  if (!LEX_WORDS || q.length < 2) return [];
  const out = [];
  for (let i = 0; i < LEX_WORDS.length && out.length < max; i++) {
    const w = LEX_WORDS[i];
    if (w.indexOf(q) <= 0 || DICT.has(w)) continue;
    out.push(w);
  }
  return out;
}
/* 把字典行包装成词书词条的形状，好复用 richCardHtml 那套渲染 */
function lexEntry(w) {
  const d = LEX && LEX[w];
  if (!d) return null;
  const ex = (EXAM && EXAM[w]) || null;
  return {
    w: w,
    defs: String(d[0] || '').split('｜'),
    sents: ex ? ex[1] : [], phrases: ex ? ex[0] : [], syns: ex ? ex[2] : [],
    us: d[1] || '', uk: '',
    freq: (d[5] || 0) >= 4,
    rank: d[3] || d[4] || 0,
    books: [], lex: true
  };
}
/* 这个词在通用字典里有没有 —— 判断「查不到」时用，别再拿 DICT（词书）一个标准卡死。
   字典是懒加载的，所以调用方要自己区分「没加载」和「确实没有」。 */
function lexHas(w) {
  return !!(LEX && LEX[String(w || '').toLowerCase()]);
}
const TAG_CN = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级',
  ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE'
};
function lexTagHtml(w) {
  const d = LEX && LEX[w];
  if (!d || !d[2]) return '';
  const tags = String(d[2]).split(' ').filter(Boolean).slice(0, 2);
  return tags.map(function (t) {
    return '<i class="lextag t-' + esc(t) + '">' + esc(TAG_CN[t] || t) + '</i>';
  }).join('');
}
function lexRowHtml(w) {
  const d = LEX[w] || [];
  const def = String(d[0] || '').replace(/｜/g, ' / ');
  return '<div class="lexrow" data-lex="' + esc(w) + '">' +
    '<span class="lw">' + esc(w) + lexTagHtml(w) + '</span>' +
    '<span class="ld">' + esc(def.length > 40 ? def.slice(0, 40) + '…' : def) + '</span>' +
    '</div>';
}

async function ensureAllBooks() {
  if (ALL_LOADED) return;
  await Promise.all(Object.keys(BOOKS).map(ensureBook));
  DICT = new Map();
  for (const bid of Object.keys(BOOKS)) {
    for (const it of VD_DATA[bid].words) {
      const k = it[0].toLowerCase();
      let e = DICT.get(k);
      if (!e) {
        e = { w: it[0], defs: it[1], phrases: it[2] || [], freq: isHighFreq(it),
          us: it[4] || '', uk: it[5] || '', sents: it[6] || [], syns: it[7] || [],
          meta: metaOf(it), books: [] };
        DICT.set(k, e);
      }
      e.books.push(bid);
    }
  }
  ALL_LOADED = true;
}

/* ---------- 自定义词库：粘贴一份词表就能变成第三本词书 ----------
 * 存法：{ name, words: [[word, defs[]], ...] }（只存最小集，导入时补齐成数据管线的 9 元组）
 * 放 localStorage 单独一个 key，不进进度快照——导出一份进度不会把几万个词拖着走。 */
function loadCustom() {
  try {
    const o = JSON.parse(lsGet(CUSTOM_KEY));
    if (o && Array.isArray(o.words) && o.words.length) return o;
  } catch (e) { /* ignore */ }
  return null;
}
function customWords(c) {
  return (c.words || []).map(function (it) {
    // 兼容两种存法：['word', ['释义']] 或 ['word', ['释义'], [], 0, '', '', [], [], 0]
    const defs = (it[1] && it[1].length) ? it[1] : ['（未填释义）'];
    return [it[0], defs, it[2] || [], 0, it[4] || '', it[5] || '', it[6] || [], it[7] || [], 0];
  });
}
/* 把自定义词库挂成 BOOKS.custom + VD_DATA.custom；返回是否有这本词书 */
function applyCustomBook() {
  const c = loadCustom();
  if (!c) {
    delete BOOKS.custom;
    if (window.VD_DATA) delete VD_DATA.custom;
    if (S.settings.book === 'custom') S.settings.book = 'cet6';
    return false;
  }
  window.VD_DATA = window.VD_DATA || {};
  VD_DATA.custom = { name: c.name || '我的词库', words: customWords(c) };
  BOOKS.custom = { name: (c.name || '我的词库') + '（' + VD_DATA.custom.words.length + ' 词）', file: '' };
  return true;
}
function saveCustom(c) {
  if (!c) lsSet(CUSTOM_KEY, '');
  else lsSet(CUSTOM_KEY, JSON.stringify(c));
  applyCustomBook();
}
function removeCustomBook() {
  try { localStorage.removeItem(CUSTOM_KEY); } catch (e) { /* ignore */ }
  delete _mem[CUSTOM_KEY];
  delete BOOKS.custom;
  if (window.VD_DATA) delete VD_DATA.custom;
  if (S.settings.book === 'custom') { S.settings.book = 'cet6'; }
  S.session = null;
  delete S.studyPaused['custom:new'];
  delete S.studyPaused['custom:review'];
  save();
}
function bookOptionsHtml() {
  return Object.keys(BOOKS).map(function (id) {
    return '<option value="' + id + '">' + esc(BOOKS[id].name) + '</option>';
  }).join('');
}
/* 词表解析：单词 + 释义，一行一个。
 * 难点是「abandon v. 放弃」里的 v. 属于释义、不属于单词，而「take off 起飞」里的 off 属于单词。
 * 判定：先取首词；后面如果紧跟词性缩写就停下（那是释义的一部分），
 * 否则只有在「再往后不是纯英文」时才把下一个词并进单词（短语）。 */
const POS_WORD = /^(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|abbr|pl|phr)\.?$/i;
function splitEntryLine(line) {
  const m = line.match(/^([A-Za-z][A-Za-z'’\-]*)([\s\S]*)$/);
  if (!m) return ['', line];
  let w = m[1];
  let rest = m[2].replace(/^[\s\t,，;；:：|]+/, '');
  rest = rest.replace(/^-\s+/, '');
  for (let k = 0; k < 2; k++) {
    const t = rest.match(/^([A-Za-z][A-Za-z'’\-]*)\s+([\s\S]*)$/);
    if (!t) break;
    if (POS_WORD.test(t[1])) break;                  // v. / n. / adj. → 属于释义
    if (/^[A-Za-z][A-Za-z\s'’\-.,;]*$/.test(t[2])) break;   // 后面还是纯英文 → 不并
    w = w + ' ' + t[1];
    rest = t[2];
  }
  return [w, rest.trim()];
}
function parseWordList(text) {
  const out = [];
  const seen = Object.create(null);
  let skipped = 0, bad = 0, dup = 0;
  String(text || '').split(/\r?\n/).forEach(function (raw) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') return;
    const pair = splitEntryLine(line);
    const w = pair[0].replace(/^[^A-Za-z]+|[^A-Za-z'’\-. ]+$/g, '').trim();
    const rest = pair[1];
    if (!w || !/^[A-Za-z][A-Za-z'’\-. ]*$/.test(w)) { if (line.length > 40) bad++; return; }
    if (!rest) { skipped++; return; }
    const key = w.toLowerCase();
    if (seen[key]) { dup++; return; }
    seen[key] = 1;
    const defs = rest.split(/\s*[；;\/|]\s*/).filter(function (x) { return !!x; }).slice(0, 6);
    if (!defs.length) { skipped++; return; }
    out.push([w, defs]);
  });
  out.sort(function (a, b) { return a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1; });
  return { words: out, skipped: skipped, dup: dup, bad: bad };
}
function openCustomImport() {
  $('modal-body').innerHTML =
    '<h2>📋 导入我的词表</h2>' +
    '<p class="muted" style="font-size:12.5px;line-height:1.8">一行一个词，<b>前面单词、后面释义</b>，' +
    '用空格 / Tab / 逗号 / 冒号隔开都行。重复的自动去重，没有释义的行会被跳过（没释义出不了题）。</p>' +
    '<pre class="fatal-pre ct-sample">' +
    esc('abandon v. 放弃；抛弃\ndeliberate adj. 深思熟虑的；故意的\nallocate, v. 分配；拨给') + '</pre>' +
    '<textarea id="ct-text" class="notein ct-ta" rows="8" placeholder="把词表粘贴到这里…"></textarea>' +
    '<p class="muted" id="ct-preview" style="font-size:12px;margin:8px 0 0">粘贴后这里会显示解析结果</p>' +
    '<div class="actions" style="margin-top:12px">' +
    '<button id="ct-do" class="primary big" disabled>导入并开始用</button>' +
    '<button id="ct-cancel" class="big">取消</button>' +
    '</div>';
  const ta = $('ct-text'), pv = $('ct-preview'), go = $('ct-do');
  const refresh = function () {
    const r = parseWordList(ta.value);
    const ok = r.words.length >= 1;
    go.disabled = !ok;
    pv.innerHTML = ta.value.trim()
      ? (ok
        ? '识别到 <b>' + r.words.length + '</b> 个词' +
          (r.skipped ? ' · 跳过 ' + r.skipped + ' 行（缺释义）' : '') +
          (r.dup ? ' · 去重 ' + r.dup + ' 个' : '') +
          ' · 例如 ' + esc(r.words.slice(0, 3).map(function (x) { return x[0]; }).join('、'))
        : '还没识别到有效词条：每行要有「单词 + 释义」')
      : '粘贴后这里会显示解析结果';
  };
  ta.addEventListener('input', refresh);
  $('ct-cancel').addEventListener('click', openSettings);
  go.addEventListener('click', function () {
    const r = parseWordList(ta.value);
    if (!r.words.length) return;
    saveCustom({ name: '我的词库', words: r.words });
    S.settings.book = 'custom';
    S.session = null;
    delete S.studyPaused['custom:new'];
    delete S.studyPaused['custom:review'];
    save();
    closeModal();
    $('book').innerHTML = bookOptionsHtml();
    $('book').value = 'custom';
    prepareBook().then(function () {
      PHASE = 'review';
      show('study');
      renderHero();
    });
    toast('已导入 ' + r.words.length + ' 个词 · 已切到「我的词库」');
  });
  $('modal').classList.remove('hidden');
  setTimeout(function () { ta.focus(); }, 30);
}

/* 词条解析：当前词书用数组元组，跨词书（单词本多选、查词联动）走 DICT 对象，
 * 统一成数组元组，卡片渲染只认这一种形状。 */
function entryOf(w) {
  const a = DEFMAP.get(w);
  if (a) return a;
  const e = DICT && DICT.get(String(w).toLowerCase());
  if (e) return [e.w, e.defs, e.phrases || [], e.freq ? 1 : 0, e.us || '', e.uk || '', e.sents || [], e.syns || [], 0, e.meta];
  return [w, [], []];
}

/* ---------- 词族：同根词 ----------
 * 词库没有词根数据，但按「共同前缀」能捞到大量同族词（access / accessible / accession），
 * 用来做形态意识（morphological awareness）——认得一个词根，一串词都好记。
 * 只在当前词书里建索引，避免为了一个 chip 去加载另一本 1.5MB 的词库。 */
let FAMILY = null;
function rebuildFamily() {
  FAMILY = new Map();
  for (const it of WORDS) {
    const k = String(it[0]).toLowerCase().slice(0, 4);
    let arr = FAMILY.get(k);
    if (!arr) { arr = []; FAMILY.set(k, arr); }
    arr.push(it[0]);
  }
}
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
/* 同根词判定：共用前缀 ≥5 字母；短词（≤6）放宽到 ≥4 但要几乎整词同源 */
function familyOf(w) {
  if (!FAMILY || !w) return [];
  const lw = String(w).toLowerCase();
  const cands = FAMILY.get(lw.slice(0, 4));
  if (!cands || cands.length < 2) return [];
  const out = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const lc = c.toLowerCase();
    if (lc === lw) continue;
    const cp = commonPrefix(lw, lc);
    const shorter = Math.min(lw.length, lc.length);
    if (cp < 4) continue;
    if (cp < 5 && cp < shorter - 2) continue;
    if (lw.slice(0, 3) !== lc.slice(0, 3)) continue;
    out.push(c);
  }
  out.sort(function (a, b) {
    return Math.abs(a.length - lw.length) - Math.abs(b.length - lw.length) || (a < b ? -1 : 1);
  });
  return out.slice(0, 6);
}
function familyHtml(w) {
  const fam = familyOf(w);
  if (fam.length < 1) return '';
  return '<div class="family"><span class="flabel">形近词</span>' +
    fam.map(function (x) {
      return '<button class="chip famchip" data-w="' + esc(x) + '" title="查看 ' + esc(x) + '">' + esc(x) + '</button>';
    }).join('') + '</div>';
}
function wireFamily(root) {
  root.querySelectorAll('.famchip').forEach(function (b) {
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openDetail(b.dataset.w);
    });
  });
}

/* ================= 会话队列 ================= */
let WORDS = [], DEFMAP = new Map();
let CHAPTERS = [];          // 按首字母分组的章节 [{label, words}]
let CH_COUNT = 1, CUR_CH = 0;
let QUEUE = [], QI = 0;
let sessionGrades = {};   // 本次会话每个已刷词的最后一次评分（1/2/3），驱动轮次巩固
let SESS_RT = [];         // 本段每次作答的反应时（毫秒），结算页给「平均反应」
let SESS_MISS = {};       // 本段每个词被判为 1/2 分的次数（= 卡壳次数），结算页给「最卡壳」
let SESS_LOG = [];        // 与上面两份同步的作答流水，撤销/重做要原样回滚（见 undoStep/redoStep）
let round = 1;            // 当前轮次：1=首轮，2+ 为巩固轮
let session = { n: 0, r: 0 };
/* 阶段机：review=复习 | new=学新词 | browse=顺带过（只看不测） | wrong=错词重刷 */
let PHASE = 'review';
let NEW = null;             // 新词流水 { list, pos, batch, batchStart, mode:'intro'|'quiz' }
let OVER = 0;               // 本轮之外仍待复习的到期词数
let CHAPTER_REVIEW = false;  // true = 这一遍是「整章复习」（点了已学完的章节），不是到期复习
let combo = 0, comboBest = 0;
let PHASE_T0 = 0;           // 本段开始时间（小结算用时）
/* 刷卡历史：每张已评分的卡存一份快照，「上一个」回滚、「下一个」原样恢复 */
let HIST = [];
let HPOS = 0;                 // HIST 中已生效的条数；HPOS < HIST.length 说明还能「下一个」
let spellChecked = false;
let spellStart = 0;
let pendingSpell = null;
let usedHint = false;         // 听写卡点了「提示」：这一张最高只能记「模糊」
let cardKind = 'recog';       // 当前卡的种类（recog/spell/ctx/listen），决定答案块的措辞
let ATTEMPT = null;           // 本次作答的原始事实 { ok, ms, hint }，交给 grade() 记进技能画像
let contextQuestion = null;   // 答后显示同一条例句，词库加载完成也不换题
let quizOpts = [], quizAnswered = false, quizStart = 0, cardSeq = 0;
let current = null;

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function clearHist() { HIST = []; HPOS = 0; }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
// 词表已按字母排序：同一首字母为一大组，超过 40 词再拆为 A1/A2…
function buildChapters() {
  CHAPTERS = [];
  const SIZE = 40;
  let letter = null, buf = [];
  const flush = function () {
    if (!buf.length) return;
    const n = Math.ceil(buf.length / SIZE);
    for (let i = 0; i < n; i++) {
      CHAPTERS.push({
        label: letter + (n > 1 ? i + 1 : ''),
        words: buf.slice(i * SIZE, (i + 1) * SIZE)
      });
    }
    buf = [];
  };
  for (const it of WORDS) {
    const L = (it[0][0] || '#').toUpperCase();
    if (L !== letter) { flush(); letter = L; }
    buf.push(it[0]);
  }
  flush();
  CH_COUNT = CHAPTERS.length;
}
function chapterWords(i) { return CHAPTERS[i].words; }
function defaultChapter() {
  for (let i = 0; i < CHAPTERS.length; i++) {
    if (CHAPTERS[i].words.some(function (w) { return !S.progress[w] && !isParked(w); })) return i;
  }
  return CHAPTERS.length - 1;
}
function bookChapter(bid) {
  const b = S.books[bid] || {};
  if (b.chapter == null || b.chapter >= CHAPTERS.length) return defaultChapter();
  // 当前章已全部学完时，继续学习应顺延到下一个未完成的章节
  const ch = CHAPTERS[b.chapter];
  if (ch && ch.words.every(function (w) { return S.progress[w]; })) return defaultChapter();
  return b.chapter;
}

// 只准备当前词书（词表/章节/当前章），不建队列——封面页也要用
async function prepareBook() {
  const book = await ensureBook(S.settings.book);
  WORDS = book.words;
  DEFMAP = new Map(WORDS.map(function (it) { return [it[0], it]; }));
  buildChapters();
  rebuildFamily();
  CUR_CH = bookChapter(S.settings.book);
  return book;
}

/* ================= 今日任务：三类队列 ================= */
/* 「错词」判定：上次答错或判模糊。老数据没有 lastG，只能退回「错次数 > 0」 */
/* ---------- 掌握：parked 的词不进任何队列（复习、新词、顺带过、错词重刷） ----------
 * v6.6 只留「已掌握」这一种永久标记，原来的「暂缓 7 / 30 天」删了：
 * 它和「错词」「到期」两条既有通道几乎重合，用的人太少，多两个按钮只多两次犹豫。
 * 老数据里 S.pause[w] 若是未来时间戳（正在暂缓中），这里会被当作「没标记」——
 * 那些词自动回到正常队列，不会凭空消失。 */
function parkState(w) {
  return S.pause[w] === 0 ? 'forever' : null;
}
function isParked(w) { return parkState(w) != null; }
function parkText(w) {
  return parkState(w) === 'forever' ? '已掌握 · 不再复习' : '';
}
function parkWords(words) {
  words.forEach(function (w) { S.pause[w] = 0; });
  save();
  return words.length;
}
function unparkWords(words) {
  words.forEach(function (w) { delete S.pause[w]; });
  save();
  return words.length;
}

/* 学习途中直接把这个词踢出队列（不打分、不写 progress）：标为已掌握，以后不再出现。
   场景：复习时碰到早就吃透的词，不用再陪它刷一遍，也不用跳去单词本。 */
function dropWord() {
  if (!current) return;
  const w = current[0];
  parkWords([w]);

  // 从当前队列摘掉：下一个词自动补位到 QI，历史快照的下标全失效所以要清
  const at = QUEUE[QI] === w ? QI : QUEUE.indexOf(w);
  if (at >= 0) QUEUE.splice(at, 1);
  // 学新词段：教学列表里也摘掉，否则下一批教学还会翻到它
  if (NEW && NEW.list) {
    const li = NEW.list.indexOf(w);
    if (li >= 0) {
      NEW.list.splice(li, 1);
      if (li <= NEW.pos) NEW.pos = Math.max(0, NEW.pos - 1);
      if (NEW.batchStart > li) NEW.batchStart--;
    }
  }
  clearHist();
  cardSeq++;          // 作废还在等待中的自动翻页
  saveSession();
  updateTopbar();
  toast('「' + w + '」标为已掌握，以后不再出现（单词本里可恢复）');
  renderCard(3);
}
/* 删除 = 把这个词的所有本地记录清掉，等于重新当新词学 */
function deleteWords(words) {
  words.forEach(function (w) {
    delete S.progress[w];
    delete S.stars[w];
    delete S.pause[w];
    delete S.notes[w];
  });
  // 当前会话的队列里可能还有这些词，清掉快照让下次进学习页重新规划
  S.session = null;
  S.studyPaused = {};
  save();
  return words.length;
}

function isWrongWord(w) {
  const p = S.progress[w];
  return !!p && (p.lastG == null ? p.wrong > 0 : p.lastG <= 2);
}
/* 到期词，最急的在前：到期越早越靠前，同一天到期则稳定性低的先 */
function dueWords() {
  const now = Date.now(), out = [];
  for (const it of WORDS) {
    const p = S.progress[it[0]];
    if (p && p.due <= now && !isParked(it[0])) out.push(it[0]);
  }
  out.sort(function (a, b) {
    const pa = S.progress[a], pb = S.progress[b];
    if (pa.due !== pb.due) return pa.due - pb.due;
    return (pa.stability || 0) - (pb.stability || 0);
  });
  return out;
}
/* 复习计划：current = 今天真要练的，rest = 被上限挡在门外的 */
function reviewPlan() {
  const due = dueWords();
  const wrongs = due.filter(isWrongWord);
  const pool = S.settings.reviewMode === 'wrong' ? wrongs : due;
  const cap = S.settings.reviewCap || 0;
  const cut = cap > 0 && pool.length > cap;
  /* 乱序只打乱**顺序**，不改「本轮练哪一批」这个集合：
     先按到期时间截断上限，再洗牌。否则每次重绘（切页、换主题）都会抽到不同的一批，
     「本轮 40 个」这个数字和实际要练的词就对不上了。 */
  let list = cut ? pool.slice(0, cap) : pool;
  if (S.settings.order === 'random') list = shuffle(list.slice());
  return {
    mode: S.settings.reviewMode,
    pool: pool.length,
    wrongCount: wrongs.length,
    list: list,
    rest: cut ? pool.length - cap : 0,
    dueTotal: due.length
  };
}
/* 从指定章节起取 n 个没学过的词。strict = 只在这一章里取，不顺手把下一章的词也带进来 */
/* 乱序取词：从整本词书所有「还没学」的词里随机抽 n 个。
 * 为什么值得单独做一条路：
 *   顺序学新词时词是按 List 排的，连日背下来会不自觉地靠「位置」和「前后邻居」记词，
 *   而且 A/B 开头的词反复出现、后半本一直没见过 —— 换到考场上没有位置线索就认不出来。
 *   乱序把选词和排序都交给随机，记忆线索只剩词本身。
 * strict（明确点了某一章）时仍然只在这一章里取，只是章内顺序打乱。 */
function randomNewWords(n, chapter, strict) {
  const start = chapter == null ? CUR_CH : chapter;
  const src = strict ? CHAPTERS[start].words : WORDS.map(function (it) { return it[0]; });
  const pool = [];
  for (const w of src) {
    if (S.progress[w] || isParked(w)) continue;
    if (!DEFMAP.has(w)) continue;
    pool.push(w);
  }
  return shuffle(pool).slice(0, n);
}

/* 界面上的「当前位置」标签。乱序时章节推进没有意义，直接写「乱序」——
   否则顶栏一直显示 List 1，用户会以为章节没动、进度卡住了。 */
function posLabel() {
  return S.settings.order === 'random' ? '乱序' : 'List ' + CHAPTERS[CUR_CH].label;
}

function newWords(n, chapter, strict) {
  if (S.settings.order === 'random') return randomNewWords(n, chapter, strict);
  const out = [];
  const start = chapter == null ? CUR_CH : chapter;
  const count = strict ? 1 : CHAPTERS.length;
  for (let i = 0; i < count && out.length < n; i++) {
    const c = (start + i) % CHAPTERS.length;
    for (const w of CHAPTERS[c].words) {
      if (out.length >= n) break;
      if (!S.progress[w] && !isParked(w)) out.push(w);
    }
  }
  return out;
}
/* 到期的非错词：留给「顺带过」当速览用，不动 FSRS */
function browseWords() {
  return dueWords().filter(function (w) { return !isWrongWord(w); });
}
function leftoverNew() {
  return Math.max(0, S.settings.newPerDay - dayRec().n);
}

/* ---------- 顽固词（leech） ----------
 * 同一个词错过 4 次以上，多半不是「刷得不够」，而是线索建错了（记错词性、混了近义词）。
 * 与其让它每轮都来捣乱，不如单独捞出来攻坚，并在卡上直接给同根词。
 * 判定放全局：错词本、统计、专项队列共用。 */
const LEECH_AT = 4;
function isLeech(w) {
  const p = S.progress[w];
  return !!p && (p.wrong || 0) >= LEECH_AT;
}
function leechWords() {
  return WORDS.filter(function (it) { return isLeech(it[0]) && !isParked(it[0]); })
    .map(function (it) { return it[0]; })
    .sort(function (a, b) {
      return ((S.progress[b] || {}).wrong || 0) - ((S.progress[a] || {}).wrong || 0);
    });
}

/* ---------- 反应时自适应 ----------
 * 「磨蹭到模糊」原来是写死的 6 秒，可有人 2 秒就答完、有人 9 秒才想清楚。
 * 收自己的反应时样本，取中位数 ×1.7 当阈值（夹在基准的 0.6~1.8 倍之间），
 * 这样同一档难度对每个人才是同一档难度。样本不足 12 个时用基准值。 */
function median(a) {
  const b = a.slice().sort(function (x, y) { return x - y; });
  const n = b.length;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}
const SLOW_BASE = { recog: 6000, spell: 12000, ctx: 16000, listen: 14000 };
function slowMs(mode) {
  const base = SLOW_BASE[mode] || 6000;
  const arr = (S.rt && S.rt[mode]) || [];
  if (arr.length < 12) return base;
  const t = Math.round(median(arr) * 1.7);
  return Math.max(Math.round(base * 0.6), Math.min(Math.round(base * 1.8), t));
}
function pushRt(mode, dt) {
  if (!(dt > 300 && dt < 180000) || !SLOW_BASE[mode]) return;
  if (!S.rt) S.rt = {};
  const a = S.rt[mode] || (S.rt[mode] = []);
  a.push(Math.round(dt));
  if (a.length > 60) a.shift();
}
/* ---------- 本段成绩 ----------
 * 只统计「这一段」的作答：平均反应时 + 卡壳次数。
 * 为什么值得单独记：连击和词数只说「做了多少」，说不出「哪几个词在拖你」。
 * 结算页把最卡壳的 4 个词摆出来，并给一个「再练这几个」——趁着记忆还热乎马上补。
 * SESS_LOG 是为了撤销/重做：两份统计都必须能原样回滚，否则退一张卡就错账。 */
function sessMark(w, g, dt) {
  const d = dt > 0 ? Math.round(dt) : 0;
  if (d) SESS_RT.push(d);
  if (g < 3) SESS_MISS[w] = (SESS_MISS[w] || 0) + 1;
  SESS_LOG.push({ w: w, g: g, dt: d });
}
function sessUnmark() {
  const x = SESS_LOG.pop();
  if (!x) return null;
  if (x.dt) {
    const i = SESS_RT.lastIndexOf(x.dt);
    if (i >= 0) SESS_RT.splice(i, 1);
  }
  if (x.g < 3 && SESS_MISS[x.w]) {
    SESS_MISS[x.w]--;
    if (!SESS_MISS[x.w]) delete SESS_MISS[x.w];
  }
  return x;
}
function sessRemark(x) {
  if (!x) return;
  if (x.dt) SESS_RT.push(x.dt);
  if (x.g < 3) SESS_MISS[x.w] = (SESS_MISS[x.w] || 0) + 1;
  SESS_LOG.push(x);
}
function sessStats() {
  const n = SESS_RT.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += SESS_RT[i];
  const avg = n ? Math.round(sum / n) : 0;
  const miss = Object.keys(SESS_MISS)
    .filter(function (w) { return SESS_MISS[w] > 0 && DEFMAP.has(w); })
    .sort(function (a, b) { return SESS_MISS[b] - SESS_MISS[a]; });
  return { n: n, avg: avg, avgTxt: n ? (avg / 1000).toFixed(1) + 's' : '—', miss: miss };
}
/* 结算页的「本段最卡壳」+ 一键再练（最多 4 个，别把收尾页撑长） */
function missHtml() {
  const top = sessStats().miss.slice(0, 4);
  if (!top.length) return '';
  /* 「再练这几个」做成 chips 行尾的一颗按钮，而不是另起一行：
     结算页下面本来就有「再清 N 个 / 学新词 / 回封面」三颗，再多一行孤立按钮层级太吵。 */
  return '<div class="donemiss"><span class="dm-label">本段最卡壳</span>' +
    top.map(function (w) {
      return '<button class="chip dmw" data-w="' + esc(w) + '" title="看词条">' + esc(w) +
        ' <i>×' + SESS_MISS[w] + '</i></button>';
    }).join('') +
    '<button id="drillmiss" class="chip dmb" title="趁记忆还热乎，马上把这几个再过一遍">再练这几个 ↻</button>' +
    '</div>';
}
function wireMiss(root) {
  if (!root) return;
  const top = sessStats().miss.slice(0, 4);
  root.querySelectorAll('.dmw').forEach(function (b) {
    b.addEventListener('click', function () { openDetail(b.dataset.w); });
  });
  const rp = root.querySelector('#drillmiss');
  if (rp) rp.addEventListener('click', function () {
    drillWith(top, '本段最卡的 ' + top.length + ' 个词', 'miss');
  });
}
/* ================= 技能画像（v5.0） =================
 * 为什么值得单独记：FSRS 只知道「这个词你多久后该再考」，不知道「你是看能认出来、
 * 还是听不出来」。同一个词，识别能过、听写全错 —— 这是两种能力缺口，复习间隔一样，
 * 但练法完全不同。所以按 词 × 模式 分开记样本（n / ok / 平均反应 / 用提示次数），
 * 再据此给出「这个词该用哪个模式练」和一份跨词的风险排序。
 * 记录点只有一个：grade() —— 撤销 / 重做都能原样回滚，不会错账。 */
function skillRow(w, mode) {
  if (!S.skills) S.skills = {};
  const box = S.skills[w] || (S.skills[w] = {});
  return box[mode] || (box[mode] = { n: 0, ok: 0, msn: 0, ms: 0, hint: 0 });
}
function recordSkill(w, mode, att) {
  if (!w || !mode) return;
  const r = skillRow(w, mode);
  r.n++;
  if (att.ok) r.ok++;
  if (att.ms > 0) { r.ms += Math.round(att.ms); r.msn++; }
  if (att.hint) r.hint++;
}
function skillAcc(w, mode) {
  const r = ((S.skills || {})[w] || {})[mode];
  if (!r || !r.n) return null;
  return r.ok / r.n;
}
/* 这个词最该练哪个模式：
 * ① 练过且正确率最低的（有明显短板就补短板）；
 * ② 没练过的模式里，挑比「最近练过的那个」更难一档的（识别 → 拼写 → 语境 → 听写）。 */
const MODE_RANK = { recog: 0, spell: 1, ctx: 2, listen: 3 };
function recommendedMode(w) {
  const box = (S.skills || {})[w] || {};
  const modes = navigator.onLine === false ? MODES : usableModes();
  let worst = null, worstAcc = 2, seen = -1;
  for (const m in box) {
    const r = box[m];
    if (!r || !r.n || !modes.includes(m)) continue;
    if (MODE_RANK[m] > seen) seen = MODE_RANK[m];
    const a = r.ok / r.n;
    if (a < worstAcc) { worstAcc = a; worst = m; }
  }
  if (worst && worstAcc < 0.75) return worst;
  return modes[Math.min(modes.length - 1, Math.max(0, seen) + 1)];
}
/* 风险打分 0~1：答错率是大头，用提示、答得慢、历史错过次数依次加成。
 * 只用「有证据」的部分 —— 没练过的词不进弱项榜，免得一上来全是陌生词。 */
function wordRisk(w) {
  const p = S.progress[w] || {};
  const box = (S.skills || {})[w] || {};
  let n = 0, ok = 0, hint = 0, slowSum = 0, slowN = 0;
  for (const m in box) {
    const r = box[m];
    if (!r || !r.n) continue;
    n += r.n; ok += r.ok; hint += r.hint;
    if (r.msn) { slowSum += (r.ms / r.msn) / slowMs(m); slowN++; }
  }
  if (!n) return null;
  const acc = ok / n;
  const hintRate = hint / n;
  const slowRate = slowN ? slowSum / slowN : 1;      // 1 = 正好是自己的正常节奏
  const risk = 0.55 * (1 - acc)
    + 0.20 * Math.min(1, hintRate * 2)
    + 0.15 * Math.min(1, Math.max(0, slowRate - 1))
    + 0.10 * Math.min(1, (p.wrong || 0) / 4);
  return { risk: Math.max(0, Math.min(1, risk)), acc: acc, n: n, hint: hint, slow: slowRate, wrong: p.wrong || 0 };
}
/* 弱项榜：只收风险 ≥ 0.35 且真练过的词，按风险从高到低 */
function weakWords(limit) {
  const out = [];
  const seen = {};
  for (const w in (S.skills || {})) {
    if (isParked(w) || !DEFMAP.has(w)) continue;
    const r = wordRisk(w);
    if (!r || r.risk < 0.35) continue;
    seen[w] = 1;
    out.push({ w: w, r: r });
  }
  // 老档升级上来可能只有 S.progress 没有 S.skills：错过 ≥3 次的也算弱项，别让画像空着
  for (const w in S.progress) {
    if (seen[w] || isParked(w) || !DEFMAP.has(w)) continue;
    const p = S.progress[w];
    if ((p.wrong || 0) >= 3) out.push({ w: w, r: { risk: 0.4, acc: 0, n: 0, hint: 0, slow: 1, wrong: p.wrong } });
  }
  out.sort(function (a, b) { return b.r.risk - a.r.risk; });
  return limit ? out.slice(0, limit) : out;
}
/* 技能画像面板：四种模式各自的正确率 + 弱项榜（点词看详情，一键开练） */
function skillProfileHtml() {
  const modes = usableModes();
  const cells = modes.map(function (m) {
    let n = 0, ok = 0, hint = 0;
    for (const w in (S.skills || {})) {
      const r = S.skills[w][m];
      if (!r || !r.n) continue;
      n += r.n; ok += r.ok; hint += r.hint;
    }
    if (!n) {
      return '<div class="sk-cell"><b class="sk-pct sk-none">—</b><span class="sk-name">' + MODE_LABEL[m] +
        '</span><i class="sk-bar"><i style="width:0"></i></i><span class="sk-meta">还没练过</span></div>';
    }
    const pct = Math.round(ok / n * 100);
    const cls = pct >= 85 ? 'g-ok' : pct >= 70 ? 'g-mid' : 'g-low';
    return '<div class="sk-cell"><b class="sk-pct ' + cls + '">' + pct + '%</b>' +
      '<span class="sk-name">' + MODE_LABEL[m] + '</span>' +
      '<i class="sk-bar"><i class="' + cls + '" style="width:' + pct + '%"></i></i>' +
      '<span class="sk-meta">' + n + ' 次作答' + (hint ? ' · 提示 ' + hint + ' 次' : '') + '</span></div>';
  }).join('');
  const weak = weakWords(10);
  return '<h3>技能画像 · 词 × 模式</h3>' +
    '<div class="panel">' +
    '<div class="sk-grid">' + cells + '</div>' +
    '<p class="s-hint">四种模式分开记：识别高、拼写低，说明「看得懂但写不出」，该多练产出；' +
    '反过来则是「背了拼写但没认熟」，该回去刷识别。' +
    (weak.length
      ? '下面按「错得多 + 想得慢 + 靠提示」综合排了 ' + weak.length + ' 个最该补的词。'
      : '练过一些词之后，这里会列出最该补的几个。') + '</p>' +
    (weak.length
      ? '<div class="actions" style="justify-content:flex-start;margin:2px 0 8px">' +
        '<button id="st-weak" class="big primary">按建议模式练这 ' + weak.length + ' 个</button></div>' +
        '<div class="sk-weak">' + weak.map(function (o) {
          const m = recommendedMode(o.w);
          return '<button class="sk-wrow" data-w="' + esc(o.w) + '" title="看词条">' +
            '<span class="sk-w">' + esc(o.w) + '</span>' +
            '<span class="sk-tag">' + MODE_LABEL[m] + '</span>' +
            '<i class="sk-risk" style="width:' + Math.round(o.r.risk * 100) + '%"></i>' +
            '<span class="sk-num">' + Math.round(o.r.risk * 100) + '</span></button>';
        }).join('') + '</div>'
      : '') +
    '</div>';
}
/* 弱项强化：一键按「每个词自己的推荐模式」刷一遍（auto 模式，卡上会标出这题在练什么） */
function startWeakDrill() {
  const ws = weakWords(20).map(function (o) { return o.w; });
  if (!ws.length) { toast('还没有足够的作答记录：先刷十几个词，再来看弱项榜'); return; }
  drillWith(ws, '弱项强化', 'skill', 'auto');
}

/* 专项练习（drill）与错词重刷（wrong）都是「临时队列」：不写会话快照、收尾页单独渲染 */
function isDrillPhase() { return PHASE === 'wrong' || PHASE === 'drill'; }
let DRILL = null;   // { label, from, mode } —— drill 阶段的标题 / 来源 / 临时模式，收尾页用
/* 当前这张卡该用哪个模式：专项练习可临时覆盖（mode='auto' = 按每个词自己的短板挑） */
function cardMode(w) {
  if (PHASE === 'drill' && DRILL && DRILL.mode) {
    if (DRILL.mode === 'auto') return recommendedMode(w);
    return DRILL.mode;
  }
  return S.settings.mode;
}
/* 顶栏高亮用：自动挑模式的专项练习，亮的是「这张卡正在用的」那一段 */
function activeMode() {
  if (PHASE === 'drill' && DRILL && DRILL.mode) {
    if (DRILL.mode === 'auto') {
      const w = QI < QUEUE.length ? QUEUE[QI] : '';
      return w ? recommendedMode(w) : S.settings.mode;
    }
    return DRILL.mode;
  }
  return S.settings.mode;
}
/* 自动挑模式的专项练习，在角标上写明这张在练什么，不然会让人以为模式乱了。
 * 听写 / 语境 / 拼写三种卡自己就带模式名，这里只补「按弱项选」；识别卡没有模式名，才补全。 */
function autoTag() {
  if (!(PHASE === 'drill' && DRILL && DRILL.mode === 'auto')) return '';
  return cardKind === 'recog' ? '按弱项选 · 识别 · ' : '按弱项选 · ';
}

/* 起一个阶段。phase: review | new | browse | wrong | drill
 * opts: { chapter, count, words, label } */
async function startPhase(phase, opts) {
  opts = opts || {};
  await prepareBook();
  if (opts.chapter != null) {
    CUR_CH = Math.min(opts.chapter, CH_COUNT - 1);
    S.books[S.settings.book] = { chapter: CUR_CH };
    save();
  }

  PHASE = phase || 'review';
  NEW = null; OVER = 0; CHAPTER_REVIEW = false; DRILL = null;

  if (PHASE === 'wrong') {
    QUEUE = shuffle(WORDS.filter(function (it) {
      const p = S.progress[it[0]];
      return p && p.wrong > 0 && !isParked(it[0]);
    }).map(function (it) { return it[0]; }));
    if (!QUEUE.length) { toast('错词本是空的，先去刷几个词'); PHASE = 'review'; return renderHero(); }
  } else if (PHASE === 'drill') {
    // 通用专项队列：错词 / 某天到期 / 单词本勾选 / 顽固词，四个入口共用一条渲染链
    const ws = (opts.words || []).filter(function (w) { return DEFMAP.has(w) || (DICT && DICT.has(String(w).toLowerCase())); });
    QUEUE = shuffle(ws.slice());
    DRILL = { label: opts.label || '专项练习', from: opts.from || '', mode: opts.mode || '' };
    if (!QUEUE.length) { toast('这一组没有可练的词'); PHASE = 'review'; DRILL = null; return renderHero(); }
  } else if (PHASE === 'browse') {
    QUEUE = browseWords();
    if (!QUEUE.length) { toast('没有可顺带过的词'); PHASE = 'review'; return renderHero(); }
  } else if (PHASE === 'review') {
    const rp = reviewPlan();
    QUEUE = rp.list; OVER = rp.rest;
    // count：只清一部分（完成页的「再清 N 个」），剩下的继续留在到期池里
    if (opts.count > 0 && QUEUE.length > opts.count) {
      OVER += QUEUE.length - opts.count;
      QUEUE = QUEUE.slice(0, opts.count);
    }
    if (!QUEUE.length) { toast('当前计划没有待复习的词'); return renderHero(); }
  } else {   // new
    const strict = opts.chapter != null;      // 明确点了某一章：只学这一章，绝不越界到下一章
    const n = (opts.count != null ? opts.count : leftoverNew()) || (strict ? 10 : 0);
    const list = newWords(Math.max(0, n), opts.chapter, strict);
    if (!list.length) {
      if (!strict) {
        toast(unseenCount() ? '今日新词目标已完成' : '这本词书已经学完了 🎉');
        PHASE = 'review';
        return renderHero();
      }
      // 点了已经学完的章节：别偷偷跳到下一章，改成把这一章整体复习一遍
      const cw = CHAPTERS[CUR_CH].words.filter(function (w) { return !isParked(w); });
      if (!cw.length) {
        toast('List ' + CHAPTERS[CUR_CH].label + ' 的词都被标成「已掌握」了，换一章吧');
        PHASE = 'review';
        return renderHero();
      }
      CHAPTER_REVIEW = true;
      PHASE = 'review';
      QUEUE = shuffle(cw);
      toast('List ' + CHAPTERS[CUR_CH].label + ' 已经学完 · 这一遍把整章再过一遍');
    } else {
      /* 顺序模式下「第一个新词不在当前章」说明该翻页了；乱序是全书随机抽，
         第一个词落在哪章纯属偶然，跟着跳会把章节进度搅乱。 */
      if (S.settings.order !== 'random' && !strict && !CHAPTERS[CUR_CH].words.includes(list[0])) {
        CUR_CH = CHAPTERS.findIndex(function (ch) { return ch.words.includes(list[0]); });
        S.books[S.settings.book] = { chapter: CUR_CH };
      }
      const batch = S.settings.introBatch > 0 ? Math.min(S.settings.introBatch, list.length) : list.length;
      NEW = { list: list, pos: 0, batch: batch, batchStart: 0, mode: 'intro' };
      QUEUE = [];
    }
  }

  QI = 0; sessionGrades = {}; round = 1;
  SESS_RT = []; SESS_MISS = {}; SESS_LOG = [];   // 换段 = 成绩重记
  session = { n: 0, r: 0 }; clearHist();
  combo = 0; comboBest = 0; PHASE_T0 = Date.now();
  parkStudySession();
  delete S.studyPaused[studySessionKey(S.settings.book, PHASE)];
  save();
  if (S.page !== 'study') show('study');
  renderCard();
  if (current && !isDrillPhase() && !S.session) saveSession();
}

/* 兼容旧调用点 */
function buildQueue(opts) {
  opts = opts || {};
  if (opts.wrong) return startPhase('wrong');
  if (opts.chapter != null) return startPhase('new', { chapter: opts.chapter, count: opts.count });
  return startPhase(opts.phase || 'review', opts);
}

/* 轮次巩固：本会话内最后一次评分不是「认识」的词，都要在巩固轮再过一遍 */
function pendingWords() {
  return Object.keys(sessionGrades).filter(function (w) { return sessionGrades[w] !== 3; });
}

function studySessionKey(book, phase) { return book + ':' + phase; }
function pausedStudy(phase) {
  const saved = S.studyPaused[studySessionKey(S.settings.book, phase)];
  return saved && saved.date === todayStr() && saved.phase === phase ? saved : null;
}
function parkStudySession() {
  const saved = S.session;
  if (!saved) return false;
  if (saved.date === todayStr() && (saved.phase === 'new' || saved.phase === 'review')) {
    S.studyPaused[studySessionKey(saved.book, saved.phase)] = saved;
  }
  S.session = null;
  return true;
}

/* 会话快照：中途关掉页面，回来也能接续（错词重刷 / 专项练习不存） */
function saveSession() {
  if (isDrillPhase() || (!current && !QUEUE.length && !(NEW && NEW.mode === 'intro'))) {
    S.session = null; save(); return;
  }
  S.session = {
    book: S.settings.book,
    date: todayStr(),
    phase: PHASE,
    queue: QUEUE.slice(),
    qi: QI,
    grades: sessionGrades,
    round: round,
    counts: { n: session.n, r: session.r },
    chapter: CUR_CH,
    chapterReview: CHAPTER_REVIEW,
    over: OVER,
    combo: combo, comboBest: comboBest, t0: PHASE_T0,
    log: SESS_LOG,
    nw: NEW ? { list: NEW.list.slice(), pos: NEW.pos, batch: NEW.batch, batchStart: NEW.batchStart, mode: NEW.mode } : null
  };
  save();
}
function restoreSession(s) {
  if (!s || s.book !== S.settings.book || s.date !== todayStr()) return false;
  const phase = s.phase || 'review';
  if (!['review', 'new', 'browse'].includes(phase) || !Array.isArray(s.queue)) return false;
  const nw = s.nw;
  const validWords = function (list) {
    return Array.isArray(list) && list.length > 0 && list.every(function (w) { return DEFMAP.has(w); });
  };
  const intro = phase === 'new' && nw && nw.mode === 'intro';
  if (!intro && !validWords(s.queue)) return false;
  if (phase === 'new' && (!nw || !validWords(nw.list))) return false;
  QUEUE = intro ? [] : s.queue.slice();
  PHASE = phase;
  DRILL = null;
  QI = Math.min(s.qi || 0, QUEUE.length);
  sessionGrades = s.grades || {};
  round = s.round || 1;
  session = { n: (s.counts && s.counts.n) || 0, r: (s.counts && s.counts.r) || 0 };
  CHAPTER_REVIEW = PHASE === 'review' && s.chapterReview === true;
  OVER = s.over || 0;
  combo = s.combo || 0; comboBest = s.comboBest || 0;
  PHASE_T0 = s.t0 || Date.now();
  NEW = PHASE === 'new'
    ? { list: nw.list.slice(), pos: nw.pos || 0, batch: nw.batch || 5,
        batchStart: nw.batchStart || 0, mode: intro ? 'intro' : 'quiz' }
    : null;
  SESS_RT = []; SESS_MISS = {}; SESS_LOG = [];
  if (Array.isArray(s.log)) s.log.forEach(sessRemark);
  clearHist();   // 历史只活在本次会话内，刷新后从当前位置重新记
  if (Number.isInteger(s.chapter) && s.chapter >= 0 && s.chapter < CHAPTERS.length) {
    CUR_CH = s.chapter;
  }
  renderCard();
  // 立刻回写快照：不然连着刷新两次，第二次就找不到可续的会话、掉回封面
  saveSession();
  return true;
}

/* ================= 调度 ================= */
function grade(g) {
  if (!current || QI >= QUEUE.length) return;
  const w = current[0];
  const p = S.progress[w];
  const isNew = !p;
  // 技能画像的唯一记录点：没走到答题环节的评分（如直接 grade(1)）按 g 推断对错
  const att = ATTEMPT || { ok: g >= 3, ms: 0, hint: false };
  ATTEMPT = null;
  sessMark(w, g, att.ms);
  // 评分前先留快照：「上一个」靠它回滚，「下一个」靠 np/daysAfter 原样恢复
  const snap = {
    w: w, qi: QI, g: g, isNew: isNew,
    prev: p ? clone(p) : null,
    daysBefore: clone(S.days),
    skillBefore: S.skills && S.skills[w] ? clone(S.skills[w]) : null,
    comboBefore: combo, comboBestBefore: comboBest,
    prevSG: Object.prototype.hasOwnProperty.call(sessionGrades, w) ? sessionGrades[w] : null
  };
  recordSkill(w, cardKind, att);
  snap.skillAfter = clone(S.skills[w]);
  HIST.length = HPOS;      // 在回溯位置重答 = 丢掉后面的重做分支
  HIST.push(snap);
  HPOS++;

  const now = Date.now();
  const Fk = F();
  let np;
  if (Fk) {
    try {
      const out = Fk.next(buildFsrsCard(p, now), new Date(now), g);
      np = {
        due: out.card.due.getTime(),
        stability: out.card.stability,
        difficulty: out.card.difficulty,
        last: now,
        state: out.card.state,
        lv: levelFromS(out.card.stability)
      };
    } catch (e) { /* 掉回兜底 */ }
  }
  if (!np) {
    const lv = Math.min((p ? p.lv : 0) + (g === 3 ? 1 : 0), MAX_LV);
    np = { due: now + INTERVALS[Math.min(lv, 7)] * DAY, lv: lv };
  }
  let wrong = p ? (p.wrong || 0) : 0;
  if (g === 1) { wrong++; np.lastWrong = now; }
  else if (g === 3 && wrong > 0) wrong--;
  np.wrong = wrong;
  np.lastG = g;                       // 上次评分：复习时靠它判断「是不是错词」
  if (g !== 1 && p && p.lastWrong) np.lastWrong = p.lastWrong;
  S.progress[w] = np;

  // 连击：答对才算，答错/模糊清零
  if (g === 3) { combo++; if (combo > comboBest) comboBest = combo; } else combo = 0;

  // 记录本次会话评分，供轮次巩固使用（错词重刷模式除外）
  if (PHASE !== 'wrong') sessionGrades[w] = g;

  const d = dayRec(true);
  if (isNew) { d.n++; session.n++; } else { d.r++; session.r++; }
  snap.np = clone(np);
  snap.daysAfter = clone(S.days);
  snap.comboAfter = combo; snap.comboBestAfter = comboBest;
  QI++;
  saveSession();   // 快照指向下一张卡，恢复后无缝续刷
  renderCard(g);
}

/* 上一个：回滚这一张的评分，把卡重新摆出来（可以改答案） */
function undoStep() {
  if (HPOS <= 0) return false;
  cardSeq++;                      // 作废可能还在等待的自动翻页
  const s = HIST[HPOS - 1];
  if (s.prev) S.progress[s.w] = clone(s.prev); else delete S.progress[s.w];
  S.days = clone(s.daysBefore);
  // 技能画像跟着回滚：退一张卡等于那次作答没发生
  if (s.skillBefore) S.skills[s.w] = clone(s.skillBefore); else delete S.skills[s.w];
  if (s.prevSG == null) delete sessionGrades[s.w]; else sessionGrades[s.w] = s.prevSG;
  if (s.isNew) session.n = Math.max(0, session.n - 1); else session.r = Math.max(0, session.r - 1);
  combo = s.comboBefore; comboBest = s.comboBestBefore;
  s.m = sessUnmark();             // 本段成绩跟着回滚，否则退一张卡「最卡壳」还挂着它
  HPOS--;
  QI = s.qi;
  saveSession();
  renderCard(2);
  toast('回到「' + s.w + '」，评分已回滚');
  return true;
}

/* 下一个：把刚撤销的那次评分原样写回，不用重答 */
function redoStep() {
  if (HPOS >= HIST.length) return false;
  cardSeq++;
  const s = HIST[HPOS];
  S.progress[s.w] = clone(s.np);
  S.days = clone(s.daysAfter);
  if (s.skillAfter) S.skills[s.w] = clone(s.skillAfter);
  if (PHASE !== 'wrong') sessionGrades[s.w] = s.g;
  if (s.isNew) session.n++; else session.r++;
  combo = s.comboAfter; comboBest = s.comboBestAfter;
  sessRemark(s.m);                // 成绩原样写回
  HPOS++;
  QI = s.qi + 1;
  saveSession();
  renderCard(3);
  toast('恢复「' + s.w + '」的评分');
  return true;
}

/* ================= 渲染基础 ================= */
const $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 放进 HTML 属性里用：esc 不管引号，句子正文里有引号会把属性截断 */
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(function () { t.classList.add('hidden'); }, 1800);
}
function statusClass(p) { return !p ? 's0' : (p.lv >= 3 ? 's2' : 's1'); }

/* 词条内容渲染助手：释义分条（词性高亮），每条释义下方挂它自己的例句。
 * maxN：最多显示几条义项。答题界面传 2 —— 一词多义时只留最主要的两个意思，
 * 每个意思配自己的例句；多出来的义项在看词条详情（A 键）时仍然全都在。 */
function defsHtml(defs, sents, maxN, word) {
  const list = (maxN && defs.length > maxN) ? defs.slice(0, maxN) : defs;
  return list.map(function (d, i) {
    const m = d.match(/^([a-z]+\.)\s*(.*)$/i);
    const line = m
      ? '<div class="dline"><b class="pos">' + esc(m[1]) + '</b>' + esc(m[2]) + '</div>'
      : '<div class="dline">' + esc(d) + '</div>';
    const s = sents && sents[i];
    return '<div class="dblock">' + line + (s && s[0] ? sentHtml(s, word) : '') + '</div>';
  }).join('');
}
/* 一义一例：entry[6] 与 entry[1] 一一对应，没有合适例句的位置是 null */
function sentOf(entry, i) {
  const ss = entry[6] || [];
  const s = ss[i];
  return (s && s[0]) ? s : null;
}

/* ================= 词根词缀拆分（答后辅助记忆） =================
 * 目标：答完一个词，顺手把它拆成「前缀 · 词根 · 后缀」，让用户用构词法记，
 * 而不是纯死记 —— 这是「词根词缀记忆法」能落地的唯一形式：拆完各自给中文。
 *
 * 一条铁律：**拆不准就不拆**。宁可整词不显示，也不能给出一个错的词源，
 * 因为记错的词源比没词源更难改回来。所以每次拆分都要过三重校验：
 *   ① 所有片段按顺序拼起来，必须一字不差等于原词（不许漏字母、不许跳过字母）
 *   ② 前缀 / 词根 / 后缀都必须来自 VD_ROOTS，不许凭空生成
 *   ③ 唯一的例外是「自由词干」（un+happy 里的 happy）—— 它必须本身是字典里的词
 */
let _rootIdx = null;
function rootIndex() {
  if (_rootIdx) return _rootIdx;
  const R = window.VD_ROOTS || { p: {}, r: {}, s: {} };
  /* 前缀 / 词根按**首字母**分桶（从头往后匹配），后缀按**尾字母**分桶（从后往前匹配）。
    这两个方向不一样，用一个 bucket 函数复用会把后缀全查丢 ——
    曾经就是这么错的：后缀桶按首字母建，匹配时却拿尾字母去查，永远返回空。 */
  const bucket = function (obj, tail) {
    const m = Object.create(null);
    for (const k in obj) {
      const c = tail ? k.charAt(k.length - 1) : k.charAt(0);
      (m[c] || (m[c] = [])).push(k);
    }
    for (const c in m) m[c].sort(function (a, b) { return b.length - a.length; });
    return m;
  };
  _rootIdx = { raw: R, p: bucket(R.p, false), r: bucket(R.r, false), s: bucket(R.s, true) };
  return _rootIdx;
}

/* 从 pos 开始、能匹配上的词条，长优先 */
function matchHead(word, pos, bucket, minLen, maxLen) {
  const list = bucket[word.charAt(pos)];
  const out = [];
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    if (k.length < minLen || k.length > maxLen) continue;
    if (word.slice(pos, pos + k.length) === k) out.push(k);
  }
  return out;
}
/* 落在词尾的词条，长优先 */
function matchTail(word, bucket, minLen, maxLen) {
  const list = bucket[word.charAt(word.length - 1)];
  const out = [];
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    if (k.length < minLen || k.length > maxLen) continue;
    if (word.slice(word.length - k.length) === k) out.push(k);
  }
  return out;
}

/* 这个词干算不算「认识的词」—— 词书优先，其次 4 万词干表，最后 9.8 万通用字典。
 * 三级回退是有必要的：词干表只有 341KB，启动就在；字典 8MB，进查词页才加载。 */
let _stemSet = null;
function stemSet() {
  if (_stemSet) return _stemSet;
  const s = window.VD_STEM || '';
  _stemSet = new Set(s ? s.split(' ') : []);
  return _stemSet;
}
function dictHas(w) {
  if (!w || w.length < 3) return false;
  if (typeof DEFMAP !== 'undefined' && DEFMAP && DEFMAP.has(w)) return true;
  if (stemSet().has(w)) return true;
  const D = window.VD_DICT;
  return !!(D && D[w]);
}
/* 词干在拼写变化后会认不出来：happi(happy) / believ(believe) / stopp(stop)。
 * 只做这三种最规矩的还原，不碰元音交替那种（如 receive 的 cei/cep），那些猜不准。 */
function stemVariants(stem) {
  const out = [];
  const n = stem.length;
  if (n < 3) return out;
  if (stem.charAt(n - 1) === 'i') out.push(stem.slice(0, n - 1) + 'y');
  out.push(stem + 'e');
  if (n > 3 && stem.charAt(n - 1) === stem.charAt(n - 2)) out.push(stem.slice(0, n - 1));
  return out;
}
/* 命中就返回原形（用来在卡片上括注），没命中返回 null */
function stemBase(stem) {
  if (dictHas(stem)) return stem;
  const vs = stemVariants(stem);
  for (let i = 0; i < vs.length; i++) if (dictHas(vs[i])) return vs[i];
  return null;
}

/* 返回 [{t:'con', g:'p', m:'共同'}, …]，拆不动返回 null */
function rootSplit(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (w.length < 5 || w.length > 24) return null;
  const idx = rootIndex();
  const R = idx.raw;
  const out = [];
  const seen = Object.create(null);

  const add = function (pre, roots, stem, suf, base) {
    const parts = [];
    if (pre) parts.push({ t: pre, g: 'p', m: R.p[pre] || '' });
    for (let i = 0; i < roots.length; i++) {
      parts.push({ t: roots[i], g: 'r', m: R.r[roots[i]] || '' });
    }
    if (stem) parts.push({ t: stem, g: 'r', m: '词干', o: (base && base !== stem) ? base : '' });
    if (suf) parts.push({ t: suf, g: 's', m: R.s[suf] || '' });
    if (parts.length < 2) return;
    /* 拼写必须严丝合缝 —— 这是防止误拆的最后一道闸 */
    const joined = parts.map(function (x) { return x.t; }).join('');
    if (joined !== w) return;
    const key = parts.map(function (x) { return x.t; }).join('|');
    if (seen[key]) return;
    seen[key] = 1;
    out.push(parts);
  };

  /* 在一段里连续匹配词根，允许「词根 + 词根 + 后缀」这种三段词根结构。
     geo·graph·y、bio·log·y 都靠这个才能拆出来 —— 只认单个词根的版本拆不动它们。 */
  const walkRoots = function (seg, depth, acc, res) {
    if (depth > 3 || res.length >= 8) return;
    const ms = matchHead(seg, 0, idx.r, 3, 12);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const rest = seg.slice(m.length);
      const next = acc.concat([m]);
      if (!rest) { res.push({ roots: next, suf: '' }); continue; }
      const sufs = matchTail(rest, idx.s, 1, 7);
      let gotSuf = false;
      for (let j = 0; j < sufs.length; j++) {
        const s = sufs[j];
        if (rest.slice(0, rest.length - s.length) === '') {
          res.push({ roots: next, suf: s });
          gotSuf = true;
          break;
        }
      }
      if (!gotSuf) walkRoots(rest, depth + 1, next, res);
    }
  };

  const prefs = [''].concat(matchHead(w, 0, idx.p, 2, 6));
  for (let pi = 0; pi < prefs.length; pi++) {
    const pre = prefs[pi];
    const r1 = w.slice(pre.length);
    if (r1.length < 3) continue;

    /* ① 前缀 + 一串词根 [+ 后缀]：最「教科书」的拆法，优先 */
    const found = [];
    walkRoots(r1, 1, [], found);
    for (let i = 0; i < found.length; i++) add(pre, found[i].roots, '', found[i].suf);

    /* ② 前缀 + 自由词干 [+ 后缀]：un+happy、re+build、over+eat 走这条 */
    if (!pre) continue;
    const b1 = stemBase(r1);
    if (b1) { add(pre, [], r1, '', b1); continue; }
    const sufs = matchTail(r1, idx.s, 2, 7);
    for (let si = 0; si < sufs.length; si++) {
      const suf = sufs[si];
      const stem = r1.slice(0, r1.length - suf.length);
      if (stem.length < 3) continue;
      const b = stemBase(stem);
      if (b) { add(pre, [], stem, suf, b); break; }
    }
  }

  /* ③ 无前缀的「词干 + 后缀」：teach·er、health·y、hope·less。
     只在 ①② 都没拆出来时才走这条 —— 词根拆分比「词干 + 后缀」更有信息量。
     词干要求 ≥4 个字母：wat·er、blist·er 这类三字母词干几乎全是误拆。 */
  if (!out.length) {
    const sufs = matchTail(w, idx.s, 1, 7);
    for (let si = 0; si < sufs.length; si++) {
      const suf = sufs[si];
      const stem = w.slice(0, w.length - suf.length);
      if (stem.length < 4) continue;
      const b = stemBase(stem);
      if (b) { add('', [], stem, suf, b); break; }
    }
  }

  if (!out.length) return null;
  /* 成分越多越好（信息量大），同样多时优先「真实词根」多的那条，
     最后才看长度 —— 保证 explain 不会被拆成 ex·plain 这种半吊子 */
  out.sort(function (a, b) {
    const na = a.filter(function (x) { return x.m !== '词干'; }).length;
    const nb = b.filter(function (x) { return x.m !== '词干'; }).length;
    if (na !== nb) return nb - na;
    return b.length - a.length;
  });
  return out[0];
}

/* 拆分结果渲染：大字用 · 连起来，下面一行逐段给释义。
 * 拆不出来就**不显示**：音节切分不算词根词缀，拿它冒充会误导（v6.4 一度加过，用户否掉）。
 * 想提高这里的出现率只能靠扩充 data/roots.js，别在前端造词源。 */
function rootHtml(word) {
  const parts = rootSplit(word);
  if (!parts) return '';
  return '<div class="rootbox">' +
    '<span class="rlabel">拼写拆分</span>' +
    '<span class="rword">' + parts.map(function (p) { return esc(p.t); }).join('·') + '</span>' +
    '<span class="rnote">' + parts.map(function (p) {
      return '<b>' + esc(p.t) + '</b>' + (p.o ? '<em>(' + esc(p.o) + ')</em>' : '') + ' ' + esc(p.m);
    }).join('<i>·</i>') + '</span>' +
    '</div>';
}
/* ---------- 英文释义 / 柯林斯星级 ----------
 * 词条第 9 位是 meta：[英文释义数组, 柯林斯星级, 牛津3000, BNC 排名, 当代语料库排名]。
 * 中文释义负责「看懂」，英文释义负责「会用」—— 选项里四个中文长得像的时候，只有英文能分辨。
 * 老词库没有第 9 位，所有函数都必须静默跳过，不能把卡片搞崩。 */
const META_EN = 0, META_CO = 1, META_OX = 2, META_BNC = 3, META_FRQ = 4;
function metaOf(entry) { return (entry && entry[9]) || null; }
function isHighFreq(entry) {
  const meta = metaOf(entry);
  return !!meta && meta[META_CO] >= 4;
}
function enDefs(entry) {
  const m = metaOf(entry);
  const a = m && m[META_EN];
  return (a && a.length) ? a : [];
}
function enLine(entry, n, max) {
  const a = enDefs(entry);
  if (!a.length) return '';
  let t = a.slice(0, n || 1).join(' ');
  const cap = max || 999;
  if (t.length > cap) t = t.slice(0, cap - 1).replace(/[\s,;:]+$/, '') + '…';
  return t;
}
function enBlockHtml(entry, n) {
  const a = enDefs(entry);
  if (!a.length) return '';
  return '<div class="enmean"><span class="enlabel">EN</span><div class="enbody">' +
    a.slice(0, n || 2).map(function (s) {
      return '<span class="enline">' + esc(s) + '</span>';
    }).join('') + '</div></div>';
}
/* 柯林斯星级（5★=700 词，最该使劲背）/ 牛津 3000 / 语料库词频 */
function rankBadgeHtml(entry) {
  const m = metaOf(entry);
  if (!m) return '';
  const out = [];
  const co = m[META_CO] || 0;
  if (co > 0) {
    out.push('<span class="rk rk-co" title="柯林斯词频星级（5★ 最常用，约 700 词）">' +
      new Array(co + 1).join('★') + '</span>');
  }
  if (m[META_OX]) out.push('<span class="rk rk-ox" title="牛津 3000 核心词">牛津3000</span>');
  const f = m[META_FRQ] || 0;
  if (f > 0) out.push('<span class="rk rk-fq" title="当代语料库词频排名，数字越小越常用">#' + f + '</span>');
  return out.length ? '<div class="ranks">' + out.join('') + '</div>' : '';
}
/* 四选一答完后，每个选项下面补「它到底是哪个词」。
 * v6.4：不再附英文释义 —— 四个选项各带一串英文，视线全被占满，
 * 反而看不清自己错在哪。只留英文单词，一眼知道「哦，原来是这个词」。 */
function optEnHtml(entry) {
  if (!entry) return '';
  return '<span class="qen"><b>' + esc(entry[0]) + '</b></span>';
}
/* 常用搭配：背单词最该记的不是词，是词跟谁一起出现 */
function phrBoxHtml(entry, n) {
  const phs = ((entry && entry[2]) || []).slice(0, n || 2);
  if (!phs.length) return '';
  return '<div class="phr-box"><span class="plabel">搭配</span><div class="phr-list">' +
    phs.map(function (ph) {
      return '<div class="phrow"><b>' + esc(ph[0]) + '</b><span>' + esc(ph[1]) + '</span></div>';
    }).join('') + '</div></div>';
}
/* 搭配 + 近义词排在同一行（够宽并排、不够宽换行）—— 两块各占一行的写法太费高度 */
function metaRowHtml(entry) {
  const ph = phrOneLineHtml(entry);
  const syn = synInlineHtml((entry && entry[7]) || []);
  if (!ph && !syn) return '';
  return '<div class="meta-row">' + ph + syn + '</div>';
}
/* 一行版搭配：空间紧张时优先用它（两个短语并排，中文跟在后面） */
function phrOneLineHtml(entry) {
  const phs = ((entry && entry[2]) || []).slice(0, 2);
  if (!phs.length) return '';
  return '<div class="phr-box one"><span class="plabel">搭配</span><div class="phr-list">' +
    phs.map(function (ph) {
      return '<span class="pchip"><b>' + esc(ph[0]) + '</b>' + esc(ph[1]) + '</span>';
    }).join('') + '</div></div>';
}

function firstSent(entry) {
  const ss = entry[6] || [];
  for (let i = 0; i < ss.length; i++) if (ss[i] && ss[i][0]) return ss[i];
  return null;
}
function phrInlineHtml(ph) {
  if (!ph) return '';
  return '<div class="phinline"><span class="plabel">短语</span><b>' + esc(ph[0]) + '</b>' + esc(ph[1]) + '</div>';
}
/* s = [英文, 中文, 来源?, 原文 URL?, 是否机翻?] */
function sentHtml(s, word, foldTranslation) {
  if (!s) return '';
  const translation = !s[1] ? '' : '<span class="cn">' + esc(s[1]) + '</span>';
  return '<div class="sent">' +
    '<button class="sent-speak" type="button" data-sent="' + escAttr(s[0]) + '" aria-label="朗读整句" title="朗读整句">🔊</button>' +
    '<span class="en" lang="en">' + exampleEnglishHtml(s[0], word) + '</span>' +
    sentenceSourceHtml(s, 'ssrc') +
    (translation && foldTranslation
      ? '<details class="sent-translation"><summary>' + (s[4] ? '查看机翻译文' : '查看译文') +
        '</summary>' + translation + '</details>'
      : translation) +
    '</div>';
}
function exampleEnglishHtml(text, word) {
  const match = word && exactWordSpans(text, word)[0];
  if (!match) return esc(text);
  return esc(text.slice(0, match[0])) + '<mark class="target-word">' +
    esc(text.slice(match[0], match[1])) + '</mark>' + esc(text.slice(match[1]));
}
function sentenceSourceHtml(s, cls) {
  if (!s[2]) return '';
  const label = esc(s[2]);
  return s[3]
    ? '<a class="' + cls + '" href="' + escAttr(s[3]) + '" target="_blank" rel="noopener noreferrer" title="查看原文（新标签页）">' +
      label + ' ↗</a>'
    : '<span class="' + cls + '">' + label + '</span>';
}
function phonHtml(e, px) {
  const mk = function (label, val, code) {
    const btn = px
      ? ' <button id="' + px + '-s-' + code + '" class="icon pbtn" title="朗读' + label + '发音">🔊</button>'
      : '';
    return label + ' /' + esc(val) + '/' + btn;
  };
  const parts = [];
  if (e.us) parts.push(mk('US', e.us, 'us'));
  if (e.uk) parts.push(mk('UK', e.uk, 'uk'));
  return parts.length ? '<div class="phon">' + parts.join('<i class="psep">·</i>') + '</div>' : '';
}

function updateTopbar() {
  const d = dayRec();
  $('today').textContent = '新词 ' + d.n + '/' + S.settings.newPerDay + ' · 复 ' + d.r;
  $('today').title = '今日目标：新词 ' + S.settings.newPerDay + ' 个';
  $('streak').textContent = '🔥 ' + streakDays();
  const segs = document.querySelectorAll('#modeseg button');
  const act = activeMode();
  for (let i = 0; i < segs.length; i++) {
    // 听写没在设置里打开就整段藏起来：顶栏按钮只出现在真能用的模式上
    const selected = segs[i].dataset.mode === act;
    if (segs[i].dataset.mode === 'listen') segs[i].classList.toggle('hidden', !S.settings.listenOn && !selected);
    segs[i].classList.toggle('on', selected);
    segs[i].setAttribute('aria-pressed', selected);
  }
  refreshSide();
}

function updateProgressbar() {
  const pct = QUEUE.length ? Math.round(QI / QUEUE.length * 100) : 100;
  $('pbar-in').style.width = pct + '%';
}

function updateStudySub(showPos) {
  const sub = $('study-sub-text');
  if (!sub) return;
  $('study-switch').querySelectorAll('button').forEach(function (b) {
    b.setAttribute('aria-pressed', showPos !== false && PHASE === b.dataset.lane);
  });
  if (PHASE === 'wrong') {
    sub.textContent = '错词重刷 · 共 ' + QUEUE.length + ' 词';
    return;
  }
  if (PHASE === 'drill') {
    sub.textContent = (DRILL ? DRILL.label : '专项练习') + ' · 共 ' + QUEUE.length + ' 词' +
      (showPos === false ? '' : ' · 第 ' + Math.min(QI + 1, QUEUE.length) + ' 词') +
      (round > 1 ? ' · 第 ' + round + ' 轮巩固' : '');
    return;
  }
  if (PHASE === 'browse') {
    sub.textContent = '顺带过 · 到期但上次答对的词，只看不测';
    return;
  }
  if (PHASE === 'new') {
    const total = NEW ? NEW.list.length : QUEUE.length;
    const i = NEW && NEW.mode === 'intro' ? NEW.pos : Math.min(total - 1, (NEW ? NEW.batchStart : 0) + QI);
    sub.textContent = '学新词 · ' + (showPos === false ? '' : (i + 1) + '/' + total + ' · ') +
      BOOKS[S.settings.book].name + ' · ' + posLabel();
    return;
  }
  if (round > 1) {
    $('study-sub-text').textContent = '第 ' + round + ' 轮巩固 · 共 ' + QUEUE.length + ' 词' +
      (showPos === false ? '' : ' · 刷到第 ' + (QI + 1) + ' 词');
    return;
  }
  const cw = chapterWords(CUR_CH);
  const learned = cw.filter(function (w) { return S.progress[w]; }).length;
  sub.textContent = (CHAPTER_REVIEW ? '复习本章 · List ' + CHAPTERS[CUR_CH].label + ' · ' : '复习 · ') +
    (showPos === false ? '' : '第 ' + (QI + 1) + '/' + QUEUE.length + ' 词 · ') +
    BOOKS[S.settings.book].name + ' · 本章 ' + learned + '/' + cw.length +
    (OVER ? ' · 另有 ' + OVER + ' 个到期词待复习' : '');
}

function tagOf(p) {
  if (!p) return '新词';
  return p.lv >= 3 ? '复习' : '巩固';
}
/* 卡片上的出口：这个词不用再考了（只留「已掌握」） */
function wactsHtml() {
  return '<div id="wacts" class="wacts">' +
    '<button id="wmaster" class="linkhint" title="这个词我早就会：标为已掌握，以后不再出现（K）">✓ 已掌握 <kbd>K</kbd></button>' +
    '</div>';
}

/* 回溯入口：给错分了可以往回退，退回去还能再往前（Ctrl+Z / Ctrl+Shift+Z 同效） */
function navChip() {
  if (!HIST.length) return '';
  let out = '';
  if (HPOS > 0) {
    out += ' <button id="prevbtn" class="linkhint undo" title="回到上一张，这一张的评分会回滚 (Ctrl+Z)">↩ 上一个</button>';
  }
  if (HPOS < HIST.length) {
    out += ' <button id="nextbtn" class="linkhint undo" title="恢复刚刚撤销的评分，直接往前走，不用重答 (Ctrl+Shift+Z)">下一个 ↪</button>';
  }
  return out;
}

function starLabel(w) {
  const t = S.stars[w] || 0;
  return t === 2 ? '⭐⭐' : t === 1 ? '⭐' : '☆';
}
function setStar(w, t) {
  if ((S.stars[w] || 0) === t) delete S.stars[w]; else S.stars[w] = t;
  save();
  toast(t === 0 || S.stars[w] == null ? '已取消收藏' : (S.stars[w] === 2 ? '已设为重点收藏' : '已收藏'));
}
function starCycle(w) {
  const t = ((S.stars[w] || 0) + 1) % 3;
  if (t) S.stars[w] = t; else delete S.stars[w];
  save();
  const b = $('starbtn');
  if (b) {
    b.textContent = starLabel(w);
    b.classList.toggle('starred', t > 0);
  }
  toast(t === 0 ? '已取消收藏' : t === 1 ? '已收藏' : '已设为重点收藏');
}

/* ================= 封面：今日任务 ================= */
function dueCount() {
  const now = Date.now();
  let n = 0;
  for (const it of WORDS) {
    const p = S.progress[it[0]];
    if (p && p.due <= now) n++;
  }
  return n;
}
function unseenCount() {
  let n = 0;
  for (const it of WORDS) if (!S.progress[it[0]] && !isParked(it[0])) n++;
  return n;
}
/* 未来 7 天到期分布：下标 0 = 今天（含已过期） */
function forecastBuckets() {
  const b = [0, 0, 0, 0, 0, 0, 0];
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  for (const it of WORDS) {
    const p = S.progress[it[0]];
    if (!p || p.due == null || isParked(it[0])) continue;
    const diff = Math.floor((p.due - t0.getTime()) / DAY);
    if (diff <= 0) b[0]++;
    else if (diff < 7) b[diff]++;
  }
  return b;
}

/* ================= 封面：今日进度之书 =================
 * 为什么这一屏的主角是一本书：
 * 圆环是「任何 App 的默认答案」，一眼就能做，也一眼就能忘 —— 它不告诉你这是什么产品。
 * 书是背单词这件事本身的物件，而且天然能装下三件事：
 *   ① 书脊里那道光是进度（从下往上长，像读到哪儿了）；
 *   ② 书签尾巴的长度跟着进度变（隐喻，不用读数字也有体感）；
 *   ③ 封面上的大数字给准头（精确到 1%）与「已学 / 今日总量」。
 * 全部用 SVG + 主题变量画，所以浅色是纸书、深色是夜读，不用两套图。
 */
const BK_COVER_TOP = 10, BK_COVER_H = 140;   // 封面上下沿（书脊光柱沿用同一段高度）
const BK_X0 = 12, BK_X1 = 32;                 // 书脊左右沿
const BK_MARK_X = 96, BK_MARK_W = 9;          // 书签左右沿
function bookHtml() {
  return '<div class="bookwrap" id="hero-book" role="button" tabindex="0" ' +
    'title="今日进度：已学 / 今日总量 · 点开看统计">' +
    '<div class="book-img">' +
    '<svg class="book-svg" viewBox="0 0 150 168" aria-hidden="true">' +
    '<defs>' +
    /* 封面：左上受光 → 右下压暗，一条 45° 渐变就够立体 */
    '<linearGradient id="bk-face" x1=".1" y1="0" x2=".9" y2="1">' +
    '<stop class="bk-s1" offset="0"></stop><stop class="bk-s2" offset="1"></stop>' +
    '</linearGradient>' +
    /* 书脊进度光：底部实、往上淡出，像光从下往上漫 */
    '<linearGradient id="bk-glow" x1="0" y1="1" x2="0" y2="0">' +
    '<stop class="bk-p1" offset="0"></stop><stop class="bk-p2" offset="1"></stop>' +
    '</linearGradient>' +
    '<clipPath id="bk-cover-clip"><rect x="30" y="10" width="88" height="140" rx="3.5"></rect></clipPath>' +
    '<clipPath id="bk-spine-clip"><rect x="12" y="10" width="20" height="140" rx="4"></rect></clipPath>' +
    '</defs>' +
    '<ellipse class="bk-shadow" cx="74" cy="160" rx="41" ry="3.6"></ellipse>' +
    /* 书根（下切口）：封面下沿露出一条页边，书才有厚度、不是一张卡片 */
    '<rect class="bk-edge" x="30" y="148" width="95" height="9" rx="4"></rect>' +
    /* 书口（右侧页边）：外弧 + 三道叶线，深浅错开像一叠纸 */
    '<path class="bk-pages" d="M118 16h7a6 6 0 0 1 6 6v114a6 6 0 0 1-6 6h-7Z"></path>' +
    '<path class="bk-leaf" d="M122.2 24v112M125.4 26.5v108M128.6 30v100"></path>' +
    /* 封面 */
    '<rect class="bk-cover" x="30" y="10" width="88" height="140" rx="3.5" fill="url(#bk-face)"></rect>' +
    '<g clip-path="url(#bk-cover-clip)">' +
    '<path class="bk-sheen" d="M30 150 76 10h17L47 150Z"></path>' +
    '</g>' +
    '<rect class="bk-rim" x="37" y="17" width="74" height="126" rx="2"></rect>' +
    /* 书脊：底轨 + 进度光 + 两道压印箍（setBookProgress 只改 fill 的 y/height） */
    '<rect class="bk-spine-track" x="12" y="10" width="20" height="140" rx="4"></rect>' +
    '<g clip-path="url(#bk-spine-clip)">' +
    '<rect class="bk-spine-fill" id="book-fill" x="12" y="150" width="20" height="0"></rect>' +
    /* 光柱顶端那道亮线 = 「读到这儿」，让进度是刻度而不是一团渐变 */
    '<rect class="bk-spine-head" id="book-head" x="12" y="150" width="20" height="1.8"></rect>' +
    '<path class="bk-band" d="M12 32h20M12 131h20"></path>' +
    '</g>' +
    /* 封面左边的高光（书脊与封面的转折处） */
    '<path class="bk-rimlight" d="M32.8 13v134"></path>' +
    /* 书签：从封面顶边垂下来，尾巴长度 = 进度（refreshHero 改 d） */
    '<path class="bk-mark" id="book-mark" d="M96 10h9v30l-4.5-6.5L96 40Z"></path>' +
    '</svg>' +
    '<div class="book-num"><b id="book-pct">0%</b><span id="book-sub">0 / 0</span></div>' +
    '</div>' +
    '<div class="book-cap">今日进度</div>' +
    '</div>';
}
/* 进度落到书上：书脊光柱高度 + 书签尾巴长度（两个都用 CSS 过渡补间，数字直接换） */
function setBookProgress(pct) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const h = Math.round(BK_COVER_H * p / 100);
  const top = BK_COVER_TOP + BK_COVER_H - h;
  const fill = $('book-fill');
  if (fill) {
    fill.setAttribute('height', String(h));
    fill.setAttribute('y', String(top));
  }
  const head = $('book-head');
  if (head) head.setAttribute('y', String(top - 0.9));
  const mark = $('book-mark');
  if (mark) {
    const len = Math.round(26 + 20 * p / 100);   // 26 → 46，越长说明读得越靠后（再长会压到封面数字）
    mark.setAttribute('d', 'M' + BK_MARK_X + ' ' + BK_COVER_TOP + 'h' + BK_MARK_W +
      'v' + len + 'l-' + (BK_MARK_W / 2) + '-6.5L' + BK_MARK_X + ' ' + (BK_COVER_TOP + len) + 'Z');
  }
}

function renderHero() {
  const hero = $('hero'), main = $('study-main');
  if (!hero) return;
  if (parkStudySession()) save();
  cardSeq++;
  CHAPTER_REVIEW = false;
  current = null;
  hero.classList.remove('hidden');
  main.classList.add('hidden');
  syncLock();
  updateTopbar();

  const d = dayRec();
  const unseen = unseenCount();
  const cw = chapterWords(CUR_CH) || [];
  const chLearned = cw.filter(function (w) { return S.progress[w]; }).length;
  const now = new Date();
  const wk = '日一二三四五六'[now.getDay()];
  const bk = forecastBuckets();
  const maxB = Math.max.apply(null, bk.concat([1]));
  const soon = bk.slice(1).reduce(function (a, b) { return a + b; }, 0);
  const oldPlan = $('hero-plan');

  hero.innerHTML =
    '<div class="hero-top">' +
    '<div class="hero-copy">' +
    '<div class="hero-date">' + (now.getMonth() + 1) + '月' + now.getDate() + '日 · 周' + wk + '</div>' +
    '<h1></h1>' +
    '<p class="hero-sub">' + esc(BOOKS[S.settings.book].name) + ' · ' + esc(posLabel()) +
    (S.settings.order === 'random'
      ? ' · 全书还剩 ' + unseenCount() + ' 个'
      : ' · 本章 ' + chLearned + '/' + cw.length) + '</p>' +
    '</div>' +
    bookHtml() +
    '</div>' +

    '<div class="modeseg study-lanes" id="hero-switch" role="group" aria-label="学习任务">' +
    '<button data-lane="new">学新词 <span id="hero-new-count"></span></button>' +
    '<button data-lane="review">复习 <span id="hero-review-count"></span></button>' +
    '</div>' +
    '<div class="hero-actions">' +
    '<button id="hero-start" class="cta"></button>' +
    '<button id="hero-ch" class="big">选章节</button>' +
    '</div>' +
    '<p class="hero-next" id="hero-next"></p>' +

    '<details id="hero-plan" class="hero-plan"' + (oldPlan && oldPlan.open ? ' open' : '') + '>' +
    '<summary>调整学习计划</summary>' +
    '<div class="plan-tasks">' +
    '<div class="task" id="task-review">' +
    '<div class="task-head"><span class="task-name">复习</span><b id="rv-n"></b></div>' +
    '<div class="opts2" id="rv-mode">' +
    '<button data-m="all">到期都练 <i id="rv-a"></i></button>' +
    '<button data-m="wrong">只练错词 <i id="rv-w"></i></button>' +
    '</div>' +
    '<div class="chips" id="rv-cap">' +
    '<span class="chips-label">每轮最多</span>' +
    [20, 40, 60, 0].map(function (c) {
      return '<button data-c="' + c + '">' + (c || '不限') + '</button>';
    }).join('') +
    '</div>' +
    '<div class="task-note" id="rv-note"></div>' +
    '</div>' +

    '<div class="task" id="task-new">' +
    '<div class="task-head"><span class="task-name">新词</span><b id="nw-n"></b></div>' +
    '<div class="numrow">' +
    '<button id="nw-minus" class="step" title="少学 5 个">−</button>' +
    '<input id="nw-input" class="numin" type="number" min="0" max="300" step="1" aria-label="每日新词数">' +
    '<button id="nw-plus" class="step" title="多学 5 个">+</button>' +
    '<span class="numunit">个</span>' +
    '<span class="chips" id="nw-quick">' +
    '<button data-n="10">10</button><button data-n="30">30</button><button data-n="50">50</button>' +
    '</span>' +
    '</div>' +
    '<div class="task-note" id="nw-note"></div>' +
    '</div>' +

    '<div class="task browse" id="task-browse">' +
    '<div class="browse-line">' +
    '<span class="browse-txt">顺带过 <b id="bw-n"></b> 个到期词 · 上次答对了，只看不测不动曲线</span>' +
    '<button id="browse-go" class="browse-go">快速翻一遍 →</button>' +
    '</div>' +
    '</div></div></details>' +

    '<div class="hero-stats">' +
    '<div class="hstat due"><b id="hs-due">' + d.r + '</b><span>今日已复习</span></div>' +
    '<div class="hstat new"><b>' + unseen + '</b><span>本书未背</span></div>' +
    '<div class="hstat"><b>' + streakDays() + '</b><span>连续打卡</span></div>' +
    '</div>' +

    (bk.reduce(function (a, b) { return a + b; }, 0) === 0
      ? '<div class="fcempty">未来 7 天没有到期词</div>'
      : '<p class="forecast-label">复习预报 · 未来 6 天 ' + soon + ' 个词将到期</p>' +
      '<div class="forecast" aria-label="未来 7 天复习预测">' + bk.map(function (v, i) {
      return '<button class="fc fclick' + (i === 0 ? ' today' : '') + '" data-d="' + i + '" title="' +
        (i === 0 ? '今天（含已过期）' : i + ' 天后') + ' · ' + v + ' 词 · 点击查看词表">' +
        '<i style="height:' + (v ? Math.max(4, Math.round(v / maxB * 30)) : 0) + 'px"></i>' +
        '<span>' + (i === 0 ? '今' : i + 'd') + '</span></button>';
    }).join('') + '</div>');

  refreshHero();

  $('hero-start').addEventListener('click', function () { startSession(); });
  $('hero-switch').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function (e) {
      studyLane = b.dataset.lane;
      if (e.detail) b.blur();
      refreshHero();
    });
  });
  $('hero-ch').addEventListener('click', function () { show('books'); });
  $('browse-go').addEventListener('click', function () { startPhase('browse'); });
  const hr = $('hero-book');
  if (hr) {
    hr.addEventListener('click', function () { openStats(); });
    hr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStats(); }
    });
  }
  hero.querySelectorAll('.fclick').forEach(function (b) {
    b.addEventListener('click', function () { openDayWords(+b.dataset.d); });
  });
  document.querySelectorAll('#rv-mode button').forEach(function (b) {
    b.addEventListener('click', function () {
      S.settings.reviewMode = b.dataset.m; save(); refreshHero();
    });
  });
  document.querySelectorAll('#rv-cap button').forEach(function (b) {
    b.addEventListener('click', function () {
      S.settings.reviewCap = +b.dataset.c; save(); refreshHero();
    });
  });
  document.querySelectorAll('#nw-quick button').forEach(function (b) {
    b.addEventListener('click', function () { setNewCount(+b.dataset.n); });
  });
  $('nw-minus').addEventListener('click', function () { setNewCount(stepNew(-5)); });
  $('nw-plus').addEventListener('click', function () { setNewCount(stepNew(5)); });
  $('nw-input').addEventListener('change', function (e) { setNewCount(+e.target.value || 0); });
}
function stepNew(d) {
  const cur = S.settings.newPerDay || 0;
  return Math.max(0, Math.min(300, cur + d));
}
function setNewCount(n) {
  n = Math.max(0, Math.min(300, Math.round(Number(n)) || 0));   // 自己填多少就多少，不再自动凑 5 的整数
  S.settings.newPerDay = n; save();
  refreshHero();
  updateTopbar();
}
let studyLane = null;
let studyStarting = false;
function selectedStudyLane(plan) {
  return studyLane || (plan.list.length || pausedStudy('review') ? 'review' : 'new');
}

/* 只刷数字与高亮，不重建封面（保住滚动位置，点一下就有反应） */
function refreshHero() {
  const rp = reviewPlan();
  const unseen = unseenCount();
  const left = Math.min(leftoverNew(), unseen);
  const lane = selectedStudyLane(rp);
  const resumed = pausedStudy(lane);
  const bw = browseWords();
  const setT = function (id, txt) { const el = $(id); if (el) el.textContent = txt; };
  const on = function (root, attr, val) {
    document.querySelectorAll(root).forEach(function (b) {
      const active = String(b.dataset[attr]) === String(val);
      b.classList.toggle('on', active);
      b.setAttribute('aria-pressed', active);
    });
  };

  const h1 = document.querySelector('#hero h1');
  if (h1) {
    h1.innerHTML = resumed ? (lane === 'review' ? '继续复习' : '继续学新词')
      : lane === 'review'
        ? (rp.list.length ? '复习 <em>' + rp.list.length + '</em> 个' + (rp.mode === 'wrong' ? '错词' : '到期词') : '当前计划没有待复习的词')
        : (left ? '今天学 <em>' + left + '</em> 个新词' : '今日新词目标已完成');
  }
  on('#hero-switch button', 'lane', lane);
  setT('hero-new-count', pausedStudy('new') ? '可续学' : left);
  setT('hero-review-count', pausedStudy('review') ? '可续练' : rp.list.length);

  setT('rv-n', rp.list.length ? rp.list.length + ' 词 · 约 ' + Math.max(1, Math.round(rp.list.length * 8 / 60)) + ' 分钟'
    : '今天没有要复习的');
  on('#rv-mode button', 'm', rp.mode);
  on('#rv-cap button', 'c', S.settings.reviewCap);

  let note;
  if (!rp.pool) {
    note = rp.dueTotal
      ? '到期 ' + rp.dueTotal + ' 个，但都不是错词 —— 切「到期都练」可以练它们'
      : '没有到期词，专注学新词就行';
  } else if (rp.rest) {
    note = '本轮练 ' + rp.list.length + ' 个，另有 ' + rp.rest + ' 个待复习';
  } else {
    note = '到期 ' + rp.dueTotal + ' 个 · 其中错词 ' + rp.wrongCount + ' 个';
  }
  setT('rv-note', note);
  setT('rv-w', rp.wrongCount);
  setT('rv-a', rp.dueTotal);
  setT('hs-due', dayRec().r);

  /* 今日进度之书：已学（复习+新词）÷ 今日总量（已学 + 还剩）。
     书脊里那道光是进度条，封面上的数字是准确值，书签尾巴跟着一起变长 —— 一个数给准头，两个形状给体感。 */
  const dd = dayRec();
  const bkDone = dd.n + dd.r;
  const bkTotal = bkDone + rp.list.length + left;
  const bkPct = bkTotal ? Math.round(bkDone / bkTotal * 100) : 100;
  setBookProgress(bkPct);
  const bkEl = $('book-pct');
  if (bkEl) {
    bkEl.textContent = bkPct + '%';
    /* 三位数（100%）比两位数宽一截，不缩一点会顶到封面压印边上 */
    bkEl.classList.toggle('wide', bkPct >= 100);
  }
  setT('book-sub', bkDone + ' / ' + bkTotal);

  const inp = $('nw-input');
  if (inp && document.activeElement !== inp) inp.value = S.settings.newPerDay;
  setT('nw-n', unseen
    ? (left ? '还剩 ' + left + ' 个' : '今日新词目标已完成')
    : '本书已经学完 🎉');
  setT('nw-note', unseen
    ? '今日已学 ' + Math.min(dayRec().n, S.settings.newPerDay) + '/' + S.settings.newPerDay +
      ' · ' + (S.settings.order === 'random' ? '全书乱序抽' : '从 List ' + CHAPTERS[CUR_CH].label + ' 起') +
      ' · 本书还剩 ' + unseenCount() + ' 个'
    : '换本书或者复习已学的吧');
  document.querySelectorAll('#nw-quick button').forEach(function (b) {
    b.classList.toggle('on', +b.dataset.n === S.settings.newPerDay);
  });

  const tb = $('task-browse');
  if (tb) {
    tb.classList.toggle('hidden', rp.mode !== 'wrong' || !bw.length);
    setT('bw-n', bw.length);
  }

  const cta = $('hero-start');
  if (cta) {
    cta.disabled = studyStarting || (!resumed && (lane === 'review' ? !rp.list.length : !unseen));
    if (resumed) cta.textContent = lane === 'review' ? '继续本轮复习' : '继续本轮新词';
    else if (lane === 'review') cta.textContent = rp.list.length ? '开始复习 ' + rp.list.length + ' 个' : '暂无待复习';
    else if (left > 0) cta.textContent = '开始学 ' + left + ' 个新词 · 约 ' + Math.max(1, Math.round(left * 25 / 60)) + ' 分钟';
    else if (unseen) cta.textContent = '再学 ' + Math.min(10, unseen) + ' 个新词';
    else cta.textContent = '本书新词已学完';
  }
  setT('hero-next', [
    '到期 ' + rp.dueTotal + ' 词',
    rp.mode === 'wrong' && rp.dueTotal ? '仅练到期错词' : '',
    left ? '今日新词还剩 ' + left + ' 个' : '今日新词目标已完成'
  ].filter(Boolean).join(' · '));
  refreshSide();       // 封面任何数字一变，右边边栏跟着走
}

async function startSession(requested, limit) {
  if (studyStarting) return;
  const rp = reviewPlan();
  const phase = requested || selectedStudyLane(rp);
  if (requested) studyLane = requested;
  if (current && PHASE === phase && !$('study-main').classList.contains('hidden')) return;
  const saved = pausedStudy(phase);
  studyStarting = true;
  try {
    if (saved) {
      parkStudySession();
      delete S.studyPaused[studySessionKey(S.settings.book, phase)];
      if (S.page !== 'study') show('study');
      if (restoreSession(saved)) return;
    }
    const count = phase === 'new' ? Math.min(limit || leftoverNew() || 10, unseenCount())
      : Math.min(limit || rp.list.length, rp.list.length);
    if (count) await startPhase(phase, { count: count });
    else renderHero();
  } catch (e) {
    toast('加载失败：' + e.message);
  } finally {
    studyStarting = false;
    refreshHero();
  }
}

/* ================= 学习页 ================= */
/* 学习卡出现时把整页锁成视口高：卡片自己分配高度，页面不出现滚动条 */
function syncLock() {
  const m = $('study-main');
  document.body.classList.toggle('study-lock', !!m && !m.classList.contains('hidden') && S.page === 'study');
}

function renderCard(dir) {
  const heroEl = $('hero'), mainEl = $('study-main');
  if (heroEl) heroEl.classList.add('hidden');
  if (mainEl) mainEl.classList.remove('hidden');
  syncLock();

  // 新词阶段：还在「教学」环节就出介绍卡，不评分
  if (PHASE === 'new' && NEW && NEW.mode === 'intro') { renderIntro(dir); return; }
  // 顺带过：整段都是介绍卡，看完就结束
  if (PHASE === 'browse') {
    if (QI >= QUEUE.length) { renderPhaseDone(); return; }
    renderIntro(dir);
    return;
  }

  // 队列刷完
  if (QI >= QUEUE.length) {
    // 新词阶段：这一批测完了 → 下一批回教学；全学完就收工
    if (PHASE === 'new') {
      if (NEW) NEW.batchStart = NEW.pos + 1;
      if (NEW && NEW.batchStart < NEW.list.length) {
        NEW.mode = 'intro'; NEW.pos = NEW.batchStart;
        QUEUE = []; QI = 0;
        renderIntro(1);
        return;
      }
      renderDone();
      return;
    }
    // 复习和专项各补测一次，之后把仍不熟的词留给 FSRS 与用户主动复测。
    const retry = pendingWords().filter(function (w) { return !isParked(w); });
    if (round === 1 && retry.length > 0) {
      round++;
      QUEUE = shuffle(retry);
      QI = 0;
      clearHist();     // 队列换成新一轮，旧下标不再对应
      saveSession();
      toast('巩固 ' + QUEUE.length + ' 个还不熟的词');
    } else if (PHASE === 'review') {
      renderPhaseDone();   // 复习段收尾：出小结算，引导去学新词
      return;
    } else {
      renderDone();
      return;
    }
  }
  updateStudySub();
  updateProgressbar();
  const card = $('card');
  cardSeq++;
  card.scrollTop = 0;
  spellChecked = false; quizAnswered = false; pendingSpell = null; usedHint = false; ATTEMPT = null;
  const w = QUEUE[QI];
  current = entryOf(w);
  updateTopbar();
  const defs = current[1];
  const p = S.progress[w];
  const mode = cardMode(w);      // 专项练习可临时换模式（弱项强化按词挑），其余跟顶栏设置
  contextQuestion = mode === 'ctx' ? ctxPrompt(current) : null;
  card.classList.remove('pop', 'enter-up', 'enter-down', 'intro', 'answered', 'spell-answered');
  void card.offsetWidth;   // 重新触发动画
  card.classList.add(dir === 1 || dir === 2 ? 'enter-down' : 'enter-up');

  if (mode === 'recog') {
    cardKind = 'recog';
    const freq = isHighFreq(current);
    const ret = retrievability(p);
    quizOpts = buildQuizOptions(current);
    quizAnswered = false;
    quizStart = Date.now();
    card.innerHTML =
      '<div class="tagline">' + autoTag() + (round > 1 ? '第' + round + '轮巩固 · ' : '') + tagOf(p) +
      (freq ? ' · <span class="freqmark">高频</span>' : '') +
      (p && p.wrong > 0 ? ' · 错过 ' + p.wrong + ' 次' : '') +
      (ret != null ? ' · 记忆 ' + ret + '%' : '') +
      (combo >= 3 ? ' · <span class="combo">🔥' + combo + '</span>' : '') +
      navChip() + '</div>' +
      '<div class="word">' + esc(w) +
      ' <button id="speak" class="icon" title="发音 (S)">🔊</button>' +
      ' <button id="starbtn" class="icon' + ((S.stars[w] || 0) ? ' starred' : '') + '" title="收藏：点一下收藏，再点设为重点，再点取消">' + starLabel(w) + '</button></div>' +
      (current[4] || current[5] ? phonHtml({ us: current[4], uk: current[5] }) : '') +
      '<div class="qprompt"><span id="recall-prompt">选出正确的释义</span>' +
      '<button id="recall-toggle" type="button" class="linkhint" aria-pressed="false" title="每题先想词义，再按需展开选项">先回忆</button></div>' +
      '<button id="recall-reveal" type="button" class="big hidden">显示选项 <kbd>空格</kbd></button>' +
      '<div id="qopts" class="qopts">' +
      quizOpts.map(function (o, i) {
        return '<button class="qopt" data-i="' + i + '"><span class="qkey">' + (i + 1) + '</span>' +
          '<span class="qtext">' + esc(o.text) + '</span></button>';
      }).join('') +
      '</div>' +
      '<div id="selfrow" class="selfrow">' +
      '<button id="selfknow" class="selfbtn know" title="一眼就认识，不必挑了：直接记为认识（回车）">认识 <kbd>回车</kbd></button>' +
      '<button id="selfno" class="selfbtn no" title="完全不认识：直接看答案，记为不认识（Esc）">不认识 <kbd>Esc</kbd></button>' +
      '</div>' +
      wactsHtml() +
      '<div id="qfb" class="qfb"></div>';
    setRecallOptions(S.settings.recallFirst);
    $('recall-toggle').setAttribute('aria-pressed', S.settings.recallFirst);
    $('recall-toggle').addEventListener('click', function (e) {
      e.currentTarget.blur();
      S.settings.recallFirst = !S.settings.recallFirst;
      e.currentTarget.setAttribute('aria-pressed', S.settings.recallFirst);
      save();
      setRecallOptions(S.settings.recallFirst);
    });
    $('recall-reveal').addEventListener('click', function (e) { e.currentTarget.blur(); setRecallOptions(false); });
  } else if (mode === 'listen') {
    /* 听写卡：只给读音，连音标都不给 —— 给了就等于把答案露出一半。
       听不清可以反复点 🔊（不扣分，听写练的是「听出来」不是「一次听懂」）；
       实在想不起来点「💡 提示」看中文，代价是这一张最高只记「模糊」。
       判定复用拼写那条链路，所以拼错后的逐字母差异、曲线、撤销全都一致。 */
    cardKind = 'listen';
    spellStart = Date.now();
    card.innerHTML =
      '<div class="tagline">' + autoTag() + '听写 · ' + tagOf(p) +
      (p && p.wrong > 0 ? ' · 错过 ' + p.wrong + ' 次' : '') +
      (isLeech(w) ? ' · <span class="leechmark">顽固词</span>' : '') +
      (combo >= 3 ? ' · <span class="combo">🔥' + combo + '</span>' : '') + navChip() + '</div>' +
      '<div class="listenbig">' +
      '<button id="playw" class="listenbtn" title="再听一遍（Alt+S）">' +
      '<span class="lspk">🔊</span><span class="ltxt">听发音，把单词拼出来</span></button>' +
      '</div>' +
      '<div class="listenmeta" id="listenmeta"></div>' +   // 空着：点「提示」才往里写一行中文
      '<input id="spell" class="spell" aria-label="听写答案" enterkeyhint="go" autocomplete="off" autocapitalize="off" ' +
      'spellcheck="false" placeholder="听到什么就拼什么，回车判定">' +
      '<div id="spellfb" class="spellfb"></div>' +
      '<div class="actions" id="spellrow">' +
      '<button id="skip" class="big" title="想不起来，直接看答案（Esc）">不认识 <kbd>Esc</kbd></button>' +
      '<button id="hintw" class="big ghost" title="给一条中文释义，这一张最高记「模糊」">💡 提示</button>' +
      '<button id="submit" class="primary big" title="拼好了，回车判定">提交 <kbd>回车</kbd></button>' +
      '</div>' +
      '<p class="muted tinyhint">听不清就多听几遍，不扣分；靠中文提示想起来的话，这一张最多记「模糊」。</p>' +
      wactsHtml();
    wireSpellInput(w);
    const hw = $('hintw');
    if (hw) hw.addEventListener('click', function (e) { e.currentTarget.blur(); showListenHint(); });
    // 卡片进场后再放音：立刻播常常被浏览器的首帧打断
    (function (seq) {
      setTimeout(function () { if (seq === cardSeq && !spellChecked) speak(w); }, 180);
    })(cardSeq);
  } else if (contextQuestion) {
    /* 语境卡：只给一句挖空例子，把词填回去。
       这是「读得懂」到「用得出」的桥：句子本身是提示，也是考的不是背释义。 */
    cardKind = 'ctx';
    const cp = contextQuestion;
    spellStart = Date.now();
    card.innerHTML =
      '<div class="tagline">' + autoTag() + '语境 · ' + tagOf(p) +
      (p && p.wrong > 0 ? ' · 错过 ' + p.wrong + ' 次' : '') +
      (isLeech(w) ? ' · <span class="leechmark">顽固词</span>' : '') +
      (combo >= 3 ? ' · <span class="combo">🔥' + combo + '</span>' : '') + navChip() + '</div>' +
      '<div class="ctxq">' +
      '<div class="sent ctxsent"><span class="en">' + esc(cp.q) + '</span></div>' +
      '</div>' +
      '<div class="ctxmeta"><span id="ctxmeta">' + ctxMeta(cp, w) + '</span>' +
      '<button id="ctx-hint" type="button" class="linkhint">首字母提示</button></div>' +
      '<input id="spell" class="spell" aria-label="语境填空答案" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
      'placeholder="把这个词填回句子里，回车判定">' +
      '<div id="spellfb" class="spellfb"></div>' +
      '<div class="actions" id="spellrow">' +
      '<button id="skip" class="big" title="想不起来，直接看答案（Esc）">不认识 <kbd>Esc</kbd></button>' +
      '<button id="submit" class="primary big" title="填好了，回车判定">提交 <kbd>回车</kbd></button>' +
      '</div>' +
      wactsHtml();
    wireSpellInput(w);
    $('ctx-hint').addEventListener('click', function (e) {
      if (spellChecked || usedHint) return;
      usedHint = true;
      $('ctxmeta').insertAdjacentHTML('beforeend', ' · 首字母 <b class="pos">' + esc(w[0]) + '</b>');
      e.currentTarget.disabled = true;
      $('spell').focus();
    });
  } else {
    cardKind = 'spell';
    const cloze = clozeHint(w, current);
    spellStart = Date.now();
    card.innerHTML =
      '<div class="tagline">' + autoTag() + (PHASE === 'browse' ? '顺带过 · ' : '拼写 · ') + tagOf(p) +
      (p && p.wrong > 0 ? ' · 错过 ' + p.wrong + ' 次' : '') +
      (isLeech(w) ? ' · <span class="leechmark">顽固词</span>' : '') +
      (combo >= 3 ? ' · <span class="combo">🔥' + combo + '</span>' : '') + navChip() + '</div>' +
      (mode === 'ctx' ? '<p class="muted tinyhint">暂无可准确挖空的例句，本题练拼写</p>' : '') +
      '<div class="meaning prompt">' + defs.map(function (d) { return esc(d); }).join('<br>') + '</div>' +
      (cloze
        ? '<div class="sent cloze"><span class="en">' + esc(cloze) + '</span></div>'
        : '<div class="hint">' + hintPattern(w) + '</div>') +
      '<div class="listenrow">' +
      '<button id="playw" class="big ghost listen" title="听发音再拼，等于听写（Alt+S）">🔊 听音</button>' +
      '</div>' +
      '<input id="spell" class="spell" aria-label="拼写答案" enterkeyhint="go" autocomplete="off" autocapitalize="off" ' +
      'spellcheck="false" placeholder="拼出这个单词，回车判定">' +
      '<div id="spellfb" class="spellfb"></div>' +
      '<div class="actions" id="spellrow">' +
      '<button id="skip" class="big" title="直接看答案，记为不认识">不认识 <kbd>Esc</kbd></button>' +
      '<button id="submit" class="primary big" title="我认识，把它拼出来">认识 <kbd>回车</kbd></button>' +
      '</div>' +
      '<p class="muted tinyhint">「认识」= 把单词拼出来提交；拼错或想不起来就点「不认识」看答案。听音等于听写，不扣分。</p>' +
      wactsHtml();
    wireSpellInput(w);
  }

  const sp = $('speak');
  if (sp) sp.addEventListener('click', function (e) { e.currentTarget.blur(); speak(w); });
  const sb = $('starbtn');
  if (sb) sb.addEventListener('click', function (e) { e.currentTarget.blur(); starCycle(w); });
  const sk = $('skip');
  if (sk) sk.addEventListener('click', function (e) { e.currentTarget.blur(); showSpellAnswer(false, true); });
  card.querySelectorAll('.qopt').forEach(function (b) {
    b.addEventListener('click', function () { answerQuiz(+b.dataset.i); });
  });
  const kb = $('selfknow');
  if (kb) kb.addEventListener('click', function (e) { e.currentTarget.blur(); selfAssess(true); });
  const nb2 = $('selfno');
  if (nb2) nb2.addEventListener('click', function (e) { e.currentTarget.blur(); selfAssess(false); });
  const wm = $('wmaster');
  if (wm) wm.addEventListener('click', function (e) { e.currentTarget.blur(); dropWord(); });
  const pb = $('prevbtn');
  if (pb) pb.addEventListener('click', function (e) { e.currentTarget.blur(); undoStep(); });
  const rb = $('nextbtn');
  if (rb) rb.addEventListener('click', function (e) { e.currentTarget.blur(); redoStep(); });
  card.querySelectorAll('.grade').forEach(function (b) {
    b.addEventListener('click', function () { grade(+b.dataset.g); });
  });

  if (mode === 'recog' && S.settings.autoSpeak) speak(w, null, { auto: true });
}

/* ================= 教学卡（新词先学 / 顺带过速览） ================= */
function introNext() {
  if (!NEW) return;
  const end = Math.min(NEW.batchStart + NEW.batch, NEW.list.length);
  if (NEW.pos + 1 >= end) { enterQuiz(); return; }
  NEW.pos++;
  renderIntro(1);
}
function introPrev() {
  if (!NEW) return;
  if (NEW.pos <= NEW.batchStart) { toast('已经是这一批的第一个了'); return; }
  NEW.pos--;
  renderIntro(2);
}
function introSkip() {
  if (!NEW) return;
  NEW.pos = Math.min(NEW.batchStart + NEW.batch - 1, NEW.list.length - 1);
  toast('跳过教学，直接测这一批');
  enterQuiz();
}
function enterQuiz() {
  if (!NEW) return;
  QUEUE = NEW.list.slice(NEW.batchStart, NEW.pos + 1);
  QI = 0;
  NEW.mode = 'quiz';
  clearHist();
  saveSession();
  toast('这批学完了，来测 ' + QUEUE.length + ' 个');
  renderCard(1);
}
function browseNext() { QI++; if (QI >= QUEUE.length) { renderPhaseDone(); return; } renderIntro(1); }
function browsePrev() { if (QI <= 0) return; QI--; renderIntro(2); }

function renderIntro(dir) {
  const card = $('card');
  const browse = PHASE === 'browse';
  const list = browse ? QUEUE : (NEW ? NEW.list : []);
  const idx = browse ? QI : NEW.pos;
  const w = list[idx];
  cardSeq++;
  card.scrollTop = 0;
  spellChecked = false; pendingSpell = null; ATTEMPT = null;
  if (!w) { renderPhaseDone(); return; }
  current = entryOf(w);
  updateTopbar();
  const e = current;
  const total = list.length;
  updateStudySub();
  const pb = $('pbar-in');
  if (pb) pb.style.width = (total ? (idx + 1) / total * 100 : 0).toFixed(1) + '%';
  card.classList.remove('pop', 'enter-up', 'enter-down', 'answered', 'spell-answered');
  void card.offsetWidth;
  card.classList.add(dir === 2 ? 'enter-down' : 'enter-up');

  const canPrev = browse ? idx > 0 : (NEW && NEW.pos > NEW.batchStart);
  card.classList.add('intro');
  card.innerHTML =
    '<div class="tagline">' + (browse ? '顺带过 · 只看不测' : '先认识一下') +
    ' · ' + (idx + 1) + '/' + total +
    (isHighFreq(e) ? ' · <span class="freqmark">高频</span>' : '') +
    (isLeech(w) ? ' · <span class="leechmark">顽固词</span>' : '') +
    (browse || !NEW || NEW.batch >= total ? '' : ' · 每 ' + NEW.batch + ' 个测一次') + '</div>' +
    '<div class="word">' + esc(w) +
    ' <button id="speak" class="icon" title="发音 (S)">🔊</button>' +
    ' <button id="starbtn" class="icon' + ((S.stars[w] || 0) ? ' starred' : '') +
    '" title="收藏：点一下收藏，再点设为重点，再点取消">' + starLabel(w) + '</button></div>' +
    (e[4] || e[5] ? phonHtml({ us: e[4], uk: e[5] }) : '') +
    '<div class="meaning intro-mean">' + noteLineHtml(w) +
    defsHtml(e[1], e[6], 2, w) + kyLineHtml(w) +
    (e[2] && e[2].length ? phrInlineHtml(e[2][0]) : '') +
    synInlineHtml(e[7] || []) +
    '</div>' +
    '<div class="actions">' +
    '<button id="intro-prev" class="big"' + (canPrev ? '' : ' disabled') + '>← 上一个</button>' +
    studyDetailButton() +
    '<button id="intro-next" class="primary big">' + (browse ? '下一个 →' : '记住了 →') + ' <kbd>空格</kbd></button>' +
    '</div>' +
    (browse
      ? '<p class="muted tinyhint">速览不动记忆曲线，看个眼熟就行。</p>'
      : '<p class="muted tinyhint">先看懂例句再往下走 —— <button id="intro-skip" class="linkhint">跳过教学</button>（Esc）直接开测也行。</p>');
  const sp = $('speak');
  if (sp) sp.addEventListener('click', function (ev) { ev.currentTarget.blur(); speak(w); });
  const sb = $('starbtn');
  if (sb) sb.addEventListener('click', function (ev) { ev.currentTarget.blur(); starCycle(w); });
  const pv = $('intro-prev');
  if (pv) pv.addEventListener('click', function () { if (browse) browsePrev(); else introPrev(); });
  const nx = $('intro-next');
  if (nx) nx.addEventListener('click', function () { if (browse) browseNext(); else introNext(); });
  const sk = $('intro-skip');
  if (sk) sk.addEventListener('click', function (ev) { ev.currentTarget.blur(); introSkip(); });
  if (S.settings.autoSpeak) speak(w, null, { auto: true });
  kyPaintSoon();
  /* 教学卡没有 fitFeedback 那套兜底，真题行是自己加的高度，超了要自己退让 */
  requestAnimationFrame(function () {
    const c = $('card');
    if (c && c.scrollHeight - c.clientHeight > 0) {
      const kl = c.querySelector('.kyline');
      if (kl) kl.remove();
    }
  });
  saveSession();
}

/* 通用小结页 */
/* extra：插在说明文字和按钮之间的补充块（现在的用法：本段最卡壳的 4 个词） */
function doneHtml(emoji, title, desc, stats, buttons, extra) {
  return '<div class="done">' +
    '<div class="done-emoji">' + emoji + '</div>' +
    '<h2>' + title + '</h2>' +
    (stats && stats.length
      ? '<div class="done-cards' + (stats.length > 3 ? ' q4' : '') + '">' + stats.map(function (s) {
        return '<div class="dc"><b>' + s.n + '</b><span>' + s.t + '</span></div>';
      }).join('') + '</div>'
      : '') +
    '<p>' + desc + '</p>' +
    (extra || '') +
    '<div class="actions">' + buttons.map(function (b) {
      return '<button id="' + b[1] + '" class="' + (b[2] || 'big') + '">' + b[0] + '</button>';
    }).join('') + '</div></div>';
}

/* 一段做完的小结：复习 / 顺带过 */
function renderPhaseDone() {
  const was = PHASE;
  // 复习段按「去重后的词数」算：轮次巩固会把答错的词再刷一遍，别让同一个词算两次
  const doneN = was === 'browse' ? QUEUE.length : Object.keys(sessionGrades).length;
  const spent = Math.max(1, Math.round((Date.now() - PHASE_T0) / 60000));
  const nb = newWords(leftoverNew()).length;
  const ss = sessStats();
  const retry = pendingWords().length;
  const followUp = retry ? ' · 还有 ' + retry + ' 个不熟，已安排后续复习。' : '。';
  cardSeq++;
  current = null;
  clearHist();
  S.session = null; save();
  updateStudySub(false);
  const subEl = $('study-sub-text');
  if (subEl) subEl.textContent = (was === 'browse' ? '顺带过完成' : '复习完成') + ' · ' + doneN + ' 词';
  const pb = $('pbar-in');
  if (pb) pb.style.width = '100%';
  const card = $('card');
  card.classList.remove('intro', 'answered', 'spell-answered');
  updateTopbar();

  if (was === 'browse') {
    card.innerHTML = doneHtml('👀', '顺带过完了',
      '看了 ' + doneN + ' 个到期词。速览不动记忆曲线，明天该提醒还是会提醒 —— 想真练就切「全部到期」。',
      [{ n: doneN, t: '本次速览' }, { n: streakDays(), t: '连续打卡' }],
      [['回封面', 'go-hero', 'primary big']]);
  } else if (CHAPTER_REVIEW) {
    // 整章复习收尾：明确给「下一章 / 再刷一遍」两个出口，不再用会串到下一章的「开始学新词」
    const chName = 'List ' + CHAPTERS[CUR_CH].label;
    const nextOk = CUR_CH + 1 < CH_COUNT;
    const btns = [];
    if (nextOk) btns.push(['学下一章 List ' + CHAPTERS[CUR_CH + 1].label, 'go-nextch', 'primary big']);
    btns.push(['再刷一遍本章', 'go-again', nextOk ? 'big' : 'primary big']);
    btns.push(['回封面', 'go-hero', 'big']);
    card.innerHTML = doneHtml('🔁', '本章复习完成',
      '练了 ' + chName + ' 的 ' + doneN + ' 个词 · 用时约 ' + spent + ' 分钟 · 最高连击 ' + comboBest + followUp,
      [{ n: doneN, t: '复习词数' }, { n: comboBest, t: '最高连击' }, { n: spent + '′', t: '用时' }],
      btns, missHtml());
    wireMiss(card);
  } else {
    const btns = [];
    // 还有到期词没清（上限截断 / 自己只清了一批）→ 给一个「接着清」的出口，不用回封面重进
    const plan = reviewPlan();
    const dueLeft = plan.pool;
    const more = Math.min(plan.list.length, 10);
    const leechN = leechWords().length;
    if (more > 0) btns.push(['再清 ' + more + ' 个', 'go-more', 'primary big']);
    if (nb) btns.push(['开始学 ' + nb + ' 个新词', 'go-new', more > 0 ? 'big' : 'primary big']);
    if (leechN) btns.push(['🧱 攻克顽固词 ' + leechN, 'go-leech', 'big']);
    btns.push(['回封面', 'go-hero', nb || more ? 'big' : 'primary big']);
    if (!nb) btns.push(['看统计', 'go-stats']);
    card.innerHTML = doneHtml('✅', '复习完成',
      '复习了 ' + doneN + ' 个词 · 用时约 ' + spent + ' 分钟 · 最高连击 ' + comboBest + followUp +
      (dueLeft ? '<br><span class="muted">还有 ' + dueLeft + ' 个到期词在排队，可以接着清。</span>'
        : ''),
      [{ n: doneN, t: '复习词数' }, { n: spent + '′', t: '用时' },
        { n: ss.avgTxt, t: '平均反应' }, { n: comboBest, t: '最高连击' }],
      btns, missHtml());
    wireMiss(card);
  }
  const gm = $('go-more');
  if (gm) gm.addEventListener('click', function () { startSession('review', 10); });
  const gl = $('go-leech');
  if (gl) gl.addEventListener('click', function () { startLeechDrill(); });
  const gn = $('go-new');
  if (gn) gn.addEventListener('click', function () { startSession('new', nb); });
  const gc = $('go-nextch');
  if (gc) gc.addEventListener('click', function () { startPhase('new', { chapter: CUR_CH + 1, count: S.settings.newPerDay }); });
  const ga = $('go-again');
  if (ga) ga.addEventListener('click', function () { startPhase('new', { chapter: CUR_CH, count: S.settings.newPerDay }); });
  const gh = $('go-hero');
  if (gh) gh.addEventListener('click', function () { PHASE = 'review'; renderHero(); });
  const gs = $('go-stats');
  if (gs) gs.addEventListener('click', openStats);
}

/* ================= 识别：四选一 ================= */
function setRecallOptions(hide) {
  const hasOptions = quizOpts.length > 1;
  $('qopts').classList.toggle('hidden', hide || !hasOptions);
  $('recall-reveal').classList.toggle('hidden', !hide || !hasOptions);
  $('recall-toggle').classList.toggle('hidden', !hasOptions);
  $('recall-prompt').textContent = hide || !hasOptions ? '先在心里回忆词义' : '选出正确的释义';
  if (!hide) quizStart = Date.now();
}

/* 选项文本：释义太多时只取第一条，避免长到看不清 */
/* 选项文本：只给最主要的两个意思，不带英文、不带例句。
 * v6.4 之前是「所有义项用；连起来，超过 30 字才截」，结果四个选项长短差一大截，
 * 长的那条一眼就能被排除，等于白送分；短的那条又太宽泛，四个都能沾点边。
 * 现在统一压到「词性 + 最多两个义项」，四条观感一致，考的是真认识不认识。 */
function optText(entry) {
  const defs = (entry && entry[1]) || [];
  const first = defs[0] || '';
  if (!first) return '';
  const m = first.match(/^([a-z]{1,5}\.)\s*(.*)$/i);
  const pos = m ? m[1].toLowerCase() + ' ' : '';
  const body = m ? m[2] : first;
  const senses = body.split(/[；;，,、]/)
    .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
    .filter(Boolean)
    .slice(0, 2);
  if (!senses.length) return '';
  let t = pos + senses.join('；');
  if (t.length > 26) {
    t = pos + senses[0];
    if (t.length > 25) t = t.slice(0, 24).replace(/[\s；，,、]+$/, '') + '…';
  }
  return t;
}
function defPos(defs) {
  const m = ((defs && defs[0]) || '').match(/^([a-z]{1,4})\./i);
  return m ? m[1].toLowerCase() : '';
}
function charSet(s) {
  const set = Object.create(null);
  for (let i = 0; i < s.length; i++) set[s[i]] = 1;
  return set;
}
function setOverlap(a, b) {
  let n = 0, total = 0;
  for (const k in a) { total++; if (b[k]) n++; }
  return total ? n / total : 0;
}
/* 干扰项挑选：同词性优先、长度接近、字面重合低的（近义词一律排除，否则两个都对）。
 * v4.1 两处升级，都是为了「辨析」而不是「凑数」：
 *   ① 每个选项带上来源词 src —— 答错时才能说出「你把这个词的意思当成了那个词」；
 *   ② 自己混过的词（S.confuse）一定优先拉进来当干扰项 —— 这是 discrimination training：
 *      光多刷几遍没用，必须让两个容易混的东西同场出现、逼你分开。 */
function buildQuizOptions(entry) {
  const correctText = optText(entry);
  const cp = defPos(entry[1]);
  const cset = charSet(correctText);
  const syns = entry[7] || [];
  const seen = Object.create(null);
  seen[entry[0]] = 1;
  const opts = [{ ok: true, text: correctText, src: entry[0] }];

  const usable = function (it) {
    if (!it || seen[String(it[0]).toLowerCase()]) return false;
    if (!it[1] || !it[1][0]) return false;
    if (syns.indexOf(it[0]) >= 0) return false;                    // 同义词
    if ((it[7] || []).indexOf(entry[0]) >= 0) return false;        // 反向同义词
    const t = optText(it);
    if (!t || t.length < 2 || t.length > 42) return false;
    if (t === correctText) return false;
    return true;
  };

  /* ① 先放「自己混过的」：最多 2 个，避免整题全是老对手反而练不到新干扰 */
  const cf = (S.confuse && S.confuse[entry[0]]) || {};
  const cfList = Object.keys(cf).sort(function (a, b) { return cf[b] - cf[a]; });
  for (let i = 0; i < cfList.length && opts.length < 3; i++) {
    const it = entryOf(cfList[i]);
    if (!usable(it)) continue;
    seen[String(it[0]).toLowerCase()] = 1;
    opts.push({ ok: false, text: optText(it), src: it[0], wasConfused: true });
  }

  const cand = [];
  let guard = 0;
  while (cand.length < 26 && guard++ < 600) {
    const it = WORDS[(Math.random() * WORDS.length) | 0];
    if (!usable(it)) continue;
    const t = optText(it);
    if (cand.some(function (o) { return o.text === t; })) continue;
    seen[String(it[0]).toLowerCase()] = 1;
    cand.push({ text: t, src: it[0], pos: defPos(it[1]), over: setOverlap(cset, charSet(t)) });
  }
  cand.sort(function (a, b) {
    const pa = a.pos === cp ? 0 : 1, pb = b.pos === cp ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const la = Math.abs(a.text.length - correctText.length);
    const lb = Math.abs(b.text.length - correctText.length);
    return (a.over * 4 + la * 0.03) - (b.over * 4 + lb * 0.03);
  });
  for (let i = 0; i < cand.length && opts.length < 4; i++) {
    opts.push({ ok: false, text: cand[i].text, src: cand[i].src });
  }
  return shuffle(opts);
}

/* ---------- 易混记录：答错时把「你选的那个词」记到 target 头上 ----------
 * 只记到当前词，不双向记 —— 用户是「看到 A 想到了 B 的意思」，方向有意义。
 * 每个词最多留 4 个对手，取次数最高的，防止 S.confuse 无限膨胀。 */
const CONFUSE_MAX = 4;
function bumpConfuse(w, other) {
  if (!w || !other || w === other) return;
  if (!S.confuse) S.confuse = {};
  const m = S.confuse[w] || (S.confuse[w] = {});
  m[other] = (m[other] || 0) + 1;
  const keys = Object.keys(m);
  if (keys.length > CONFUSE_MAX) {
    keys.sort(function (a, b) { return m[a] - m[b]; });
    delete m[keys[0]];
  }
}
/* 某词混过的对象（按次数降序） */
function confuseOf(w) {
  const m = (S.confuse && S.confuse[w]) || null;
  if (!m) return [];
  return Object.keys(m)
    .filter(function (k) { return DEFMAP.has(k); })
    .sort(function (a, b) { return m[b] - m[a]; });
}
/* 反向：谁把 w 当成了自己的意思（有人看到 A 想成了 w） */
function confuseIn(w) {
  const out = [];
  if (!S.confuse) return out;
  for (const a in S.confuse) {
    if (a === w) continue;
    if (S.confuse[a][w] && DEFMAP.has(a)) out.push(a);
  }
  return out.sort(function (a, b) { return S.confuse[b][w] - S.confuse[a][w]; });
}
/* 双向合并：查这个词时，把它混过的和混成它的都摆出来（辨析要看两边） */
function confuseNeighbors(w) {
  const out = confuseOf(w).slice();
  confuseIn(w).forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
  return out;
}
/* 全局易混词对：A→B 与 B→A 合并成一对，次数相加 */
function confusePairs() {
  const map = Object.create(null);
  for (const a in S.confuse) {
    const m = S.confuse[a];
    for (const b in m) {
      if (!DEFMAP.has(a) || !DEFMAP.has(b)) continue;
      const k = a < b ? a + '|' + b : b + '|' + a;
      map[k] = (map[k] || 0) + m[b];
    }
  }
  return Object.keys(map)
    .map(function (k) {
      const p = k.split('|');
      return { a: p[0], b: p[1], n: map[k] };
    })
    .sort(function (x, y) { return y.n - x.n; });
}
/* 易混词涉及的全部词（去重），用于一键开练 */
function confuseWords(limit) {
  const out = [];
  const push = function (w) { if (w && DEFMAP.has(w) && out.indexOf(w) < 0) out.push(w); };
  confusePairs().slice(0, limit || 40).forEach(function (p) { push(p.a); push(p.b); });
  return out;
}

/* ---------- 拼写差异对齐 ----------
 * 拼错时只说「不对」，人还是得把整词重读一遍才知道错在哪一个字母。
 * 这里用 LCS 把「你写的」和「正确」逐字母对齐：多写的、漏写的各占一格，
 * 一眼就能看出是漏了 i，还是把 e 写成 a。只做定位，不参与评分。 */
function lcsAlign(ta, co) {
  const n = ta.length, m = co.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i].toLowerCase() === co[j].toLowerCase()
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const cells = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i].toLowerCase() === co[j].toLowerCase()) {
      cells.push({ t: ta[i], c: co[j], same: true }); i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      cells.push({ t: ta[i], c: null, same: false }); i++;        // 多写的
    } else {
      cells.push({ t: null, c: co[j], same: false }); j++;        // 漏写的
    }
  }
  while (i < n) { cells.push({ t: ta[i], c: null, same: false }); i++; }
  while (j < m) { cells.push({ t: null, c: co[j], same: false }); j++; }
  /* LCS 会把「写错一个字母」拆成「多写一个 + 漏写一个」两列，
     眼睛反而看不出是同一个位置写错了。这里把相邻的这一对并成一列，
     两行就变成「同一个位置：你写 z / 正确 m」—— 这才是人想看的。 */
  const merged = [];
  for (let k = 0; k < cells.length; k++) {
    const a = cells[k], b = cells[k + 1];
    if (!a.same && a.t != null && a.c == null && b && !b.same && b.t == null && b.c != null) {
      merged.push({ t: a.t, c: b.c, same: false, sub: true });
      k++;
    } else merged.push(a);
  }
  return merged;
}
const SDIFF_MAX = 24;   // 再长就不铺格子了，格子会挤成一团
function spellDiffHtml(typed, correct) {
  const t0 = (typed || '').trim();
  if (!t0 || !correct || t0.toLowerCase() === correct.toLowerCase()) return '';
  if (correct.length > SDIFF_MAX || t0.length > SDIFF_MAX) {
    return '<div class="sdiff plain">' +
      '<span class="sdiff-tag">你写的</span><span class="sdiff-raw">' + esc(t0) + '</span></div>';
  }
  const cells = lcsAlign(t0, correct);
  const rowT = cells.map(function (c) {
    if (c.same) return '<i>' + esc(c.t) + '</i>';
    return c.t == null ? '<i class="dgap"></i>' : '<i class="dbad">' + esc(c.t) + '</i>';
  }).join('');
  const rowC = cells.map(function (c) {
    if (c.same) return '<i>' + esc(c.c) + '</i>';
    return c.c == null ? '<i class="dgap"></i>' : '<i class="dmiss">' + esc(c.c) + '</i>';
  }).join('');
  const subs = cells.filter(function (c) { return !c.same && c.t != null && c.c != null; });
  const miss = cells.filter(function (c) { return !c.same && c.t == null; }).map(function (c) { return c.c; });
  const extra = cells.filter(function (c) { return !c.same && c.c == null; }).map(function (c) { return c.t; });
  const bits = [];
  if (subs.length) {
    bits.push(subs.slice(0, 2).map(function (c) { return c.c + ' 写成了 ' + c.t; }).join('，') +
      (subs.length > 2 ? ' 等 ' + subs.length + ' 处' : ''));
  }
  if (miss.length) bits.push('漏了 ' + miss.slice(0, 4).join(' ') + (miss.length > 4 ? ' 等 ' + miss.length + ' 个' : ''));
  if (extra.length) bits.push('多了 ' + extra.slice(0, 4).join(' ') + (extra.length > 4 ? ' 等 ' + extra.length + ' 个' : ''));
  return '<div class="sdiff">' +
    '<div class="sdiff-row"><span class="sdiff-tag">你写的</span><span class="sdiff-w">' + rowT + '</span></div>' +
    '<div class="sdiff-row"><span class="sdiff-tag">正确</span><span class="sdiff-w">' + rowC + '</span></div>' +
    (bits.length ? '<div class="sdiff-hint">' + esc(bits.join(' · ')) + '</div>' : '') +
    '</div>';
}

/* ---------- 遗忘曲线（小图） ----------
 * 把一个词「从现在到下次复习」的留存率衰减画出来：横轴天数，纵轴还记得的概率。
 * 用与 retrievability() 同源的公式，保证图上的数和卡片上的「记忆 x%」永远一致。
 * 为什么值得画：一句「下次复习：3 天后」看不出代价；画出来才知道「今天不复习，3 天后只剩 90%」。 */
function curveR(tDays, s) {
  if (!(s > 0) || tDays < 0) return 0;
  return Math.pow(1 + 19 / 81 * tDays / s, -0.5);
}
function forgetCurveSvg(p, g) {
  if (!p && g == null) return '';
  const now = Date.now();
  // 用「这次评分之后」的稳定性画，图上终点才和「下次复习」对得上
  let s = p && p.stability;
  let dueMs = p && p.due;
  try {
    const Fk = F();
    if (Fk && g != null) {
      const out = Fk.next(buildFsrsCard(p, now), new Date(now), g);
      s = out.card.stability;
      dueMs = out.card.due.getTime();
    }
  } catch (e) { /* 用兜底 */ }
  if (!(s > 0) || !dueMs) return '';
  const dueDays = Math.max(0.04, (dueMs - now) / DAY);
  const span = Math.max(dueDays * 1.18, 0.1);
  const W = 460, H = 44, PL = 8, PR = 8, PT = 7, PB = 13;
  const iw = W - PL - PR, ih = H - PT - PB;
  const x = function (t) { return PL + (t / span) * iw; };
  const y = function (r) { return PT + (1 - r) * ih; };
  const pts = [];
  const N = 44;
  for (let i = 0; i <= N; i++) {
    const t = span * i / N;
    pts.push(x(t).toFixed(1) + ',' + y(curveR(t, s)).toFixed(1));
  }
  const rEnd = curveR(dueDays, s);
  const area = PL + ',' + (PT + ih) + ' ' + pts.join(' ') + ' ' + (PL + iw) + ',' + (PT + ih);
  const rr = Math.max(0, Math.min(100, Math.round(rEnd * 100)));
  const dLabel = dueDays < 1
    ? Math.max(1, Math.round(dueDays * 24)) + ' 小时'
    : Math.round(dueDays) + ' 天';
  return '<svg class="fcurve" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" ' +
    'aria-label="遗忘曲线：' + dLabel + '后预计还记得 ' + rr + '%">' +
    '<polygon class="fc-area" points="' + area + '"/>' +
    '<polyline class="fc-line" points="' + pts.join(' ') + '"/>' +
    '<line class="fc-dash" x1="' + x(dueDays).toFixed(1) + '" y1="' + PT + '" x2="' + x(dueDays).toFixed(1) + '" y2="' + (PT + ih) + '"/>' +
    '<circle class="fc-dot now" cx="' + x(0) + '" cy="' + y(1) + '" r="3"/>' +
    '<circle class="fc-dot due" cx="' + x(dueDays).toFixed(1) + '" cy="' + y(rEnd).toFixed(1) + '" r="3"/>' +
    '<text class="fc-t" x="' + (PL + 1) + '" y="' + (H - 3) + '">今天 100%</text>' +
    '<text class="fc-t end" x="' + (W - PR - 1) + '" y="' + (H - 3) + '" text-anchor="end">' + dLabel + '后 ' + rr + '%</text>' +
    '</svg>';
}

function answerQuiz(i) {
  if (quizAnswered || !quizOpts[i] || !current || $('qopts').classList.contains('hidden')) return;
  const ok = quizOpts[i].ok;
  const dt = Date.now() - quizStart;
  pushRt('recog', dt);
  ATTEMPT = { ok: ok, ms: dt, hint: false };
  // 答对但磨得比自己的节奏久 → 记为「模糊」（阈值随个人反应时自适应，见 slowMs）
  const g = ok ? (dt > slowMs('recog') ? 2 : 3) : 1;
  settleQuiz(ok, g, i, false);
}

/* 自评：一眼认识或完全不认识，不必走选择题（不计超时，自评就是自评） */
function selfAssess(ok) {
  if (quizAnswered || !current) return;
  ATTEMPT = { ok: ok, ms: 0, hint: false };
  settleQuiz(ok, ok ? 3 : 1, -1, true);
}

/* 反馈区的自适应收纳。
 * 卡片是「一屏装下」的硬约束（card-fit 六档断言卡内不溢出），
 * 而错因对比 + 遗忘曲线是新加的高度。这里按价值从低到高依次砍：
 * 先砍曲线 → 再砍解释句 → 曲终压缩对比块；实在放不下才整个收掉。
 * 换句话说：屏幕够大就全给，屏幕小就先保证「答对/答错 + 释义」永远看得见。 */
function fitFeedback(fb) {
  const card = $('card');
  if (!card || !fb) return;
  const over = function () { return card.scrollHeight - card.clientHeight; };
  if (over() <= 0) return;
  /* 矮窗口兜底：先扔「看一眼就够」的装饰（小曲线 / 提示），再扔次要信息，
     最后才动搭配与英文释义 —— 顺序就是重要性倒序，别把最有用的先删了。 */
  /* 顺序 = 牺牲先后。v6.9.2 把 .kyline 从第 3 位挪到末位：真题句+释义带中文后高了 8px，
     挤的时候先让搭配、难度标记、近义这些退场，最后才轮到真题 —— 它是用户点名要看的。 */
  const drop = ['.why-hint', '.fcurve', '.phinline', '.ranks', '.phr-box', '.enmean', '.kyline'];
  for (let i = 0; i < drop.length; i++) {
    const el = fb.querySelector(drop[i]);
    if (!el) continue;
    el.remove();
    if (over() <= 0) return;
  }
  const why = fb.querySelector('.why');
  if (why) {
    why.classList.add('one');
    if (over() <= 0) return;
    why.remove();
  }
}

function settleQuiz(ok, g, idx, self) {
  quizAnswered = true;
  pendingSpell = g;
  /* 作答后把词头收小、提示行撤掉：这一屏剩下的高度要全部让给释义、英文、搭配、近义词 */
  const cEl = $('card');
  if (cEl) cEl.classList.add('answered');
  const seq = cardSeq;
  const w = current[0];
  const p = S.progress[w];
  $('recall-reveal').classList.add('hidden');

  document.querySelectorAll('#qopts .qopt').forEach(function (b, j) {
    b.disabled = true;
    if (quizOpts[j] && quizOpts[j].ok) b.classList.add('qopt-ok');
    else if (j === idx) b.classList.add('qopt-bad');
    else b.classList.add('qopt-dim');
    /* 答完才展开：这四个中文各对应哪个词、英文又怎么说。
       中文让你选得对，英文让你记得住 —— 也是「形近义近四个选项」唯一能自证的地方。 */
    const o = quizOpts[j];
    const it = o && entryOf(o.src);
    if (it) b.insertAdjacentHTML('beforeend', optEnHtml(it));
  });
  const sr = $('selfrow');
  if (sr) sr.remove();          // 已作答，自评按钮就没必要了
  const wa = $('wacts');
  if (wa) wa.remove();          // 「已掌握」也一起收走，把高度留给释义

  const fb = $('qfb');
  if (!fb) return;
  const isNewPhase = PHASE === 'new';
  const label = ok ? (self ? '✓ 认识' : '✓ 正确') : (self ? '✗ 不认识' : '✗ 答错了');

  /* 错因对比：答错时把「你把哪个词当成了这个词」摆出来。
     光说「答错了」学不到东西；知道错在混淆了哪个词，才知道下一步该辨析谁。 */
  let why = '';
  const chosen = idx >= 0 ? quizOpts[idx] : null;
  if (!ok && chosen && chosen.src && chosen.src !== w && DEFMAP.has(chosen.src)) {
    bumpConfuse(w, chosen.src);
    save();
    why = '<div class="why">' +
      '<div class="why-row bad"><span class="why-tag">你选的</span>' +
      '<b>' + esc(chosen.src) + '</b><span class="why-d">' + esc(chosen.text) + '</span></div>' +
      '<div class="why-row ok"><span class="why-tag">正确</span>' +
      '<b>' + esc(w) + '</b><span class="why-d">' + esc(optText(current)) + '</span></div>' +
      '</div>';
  }

  // 学新词答对：不自动跳，让你先看一眼释义，再决定「加入复习」还是「还不熟」
  /* v6.9.4：答完之后 .card.answered 会把 tagline 藏起来（那是「巩固 · 记忆 95%」这行），
     顺手把 tagline 里的「↩ 上一个」也一起藏没了 —— 而复习时「答完想改答案/回退」恰恰是最想用它的时刻。
     所以答后这一排放一个自己的回退按钮，不依赖 tagline。 */
  const prevAct = HPOS > 0
    ? '<button id="qprev" class="big ghost" title="返回上一个词并撤销它的评分">↩ 上一个词</button>'
    : '';
  const acts = prevAct + studyDetailButton() +
    (ok ? '<button id="qhold" class="big" title="把这个词记为不熟">还不熟 <kbd>N</kbd></button>' : '') +
    '<button id="qnext" class="primary big">' + (isNewPhase && ok ? '加入复习' : '下一个') + ' <kbd>空格</kbd></button>';
  /* 释义面板：中文分条（带各自的例句）+ 词根拆分 + 两条搭配 + 近义词 + 词频刻度。
     v6.4：不再显示英文释义（EN 块），一词多义只留最主要的两个义项。
     理由：这一屏是答完顺手看一眼的地方，不是词典页 —— 塞满英文和七八个义项，
     视线全被占走，反而记不住。想看全的按 A 开词条详情。 */
  const phs = (current[2] || []).slice(0, 2);
  /* 两个义项各自都挂着例句时，释义块会比平时高 ~55px ，
     矮窗口下会顶出卡片 —— 加个 two-ex 类，让 CSS 把那两条例句的留白压一压。 */
  const twoEx = Math.min(2, (current[1] || []).length) === 2 &&
    (current[6] || []).slice(0, 2).filter(function (s) { return s && s[0]; }).length === 2;
  fb.innerHTML =
    '<div class="qres ' + (ok ? 'ok' : 'bad') + '">' + label +
    (g === 2 ? '<span class="qnote">想得有点久，记为「模糊」</span>' : '') +
    '</div>' +
    /* 答对时不画遗忘曲线：那条线是「你多久会忘」，答错/模糊时才有指导价值；
       答对时这 60px 留给释义和词根更划算 */
    (ok && g >= 3 ? '' : forgetCurveSvg(p, g)) +
    why +
    '<div class="meaning qmean' + (twoEx ? ' two-ex' : '') + '">' +
    '<div class="mhead"><b class="mword">' + esc(w) + '</b>' + rankBadgeHtml(current) + '</div>' +
    noteLineHtml(current[0]) +
    /* 一词多义：只留最主要的两个义项，**每个义项配自己的例句**，对错都这样。
       以前答对时只留第一条例句、省下来的高度给词根和搭配 —— 但两个义项只有一句例句，
       第二个意思就变成了「干条条」，反而是最需要例句的地方没例句。 */
    defsHtml(current[1], current[6], 2, w) + kyLineHtml(w) +
    metaRowHtml(current) +
    '</div>' +
    '<div class="actions">' + acts + '</div>';
  /* 释义刚插进 DOM 时字体还没重排，同步量高度会量小、误判成「装得下」，
     结果按钮被裁掉一半。等两帧再收，这时高度才是真的。 */
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { if (seq === cardSeq) fitFeedback(fb); });
  });
  kyPaintSoon();
  $('qnext').addEventListener('click', function () { if (seq === cardSeq) grade(g); });
  const qp = $('qprev');
  if (qp) qp.addEventListener('click', function (e) { e.currentTarget.blur(); if (seq === cardSeq) undoStep(); });
  const hb = $('qhold');
  if (hb) hb.addEventListener('click', function (e) {
    e.currentTarget.blur();
    if (seq !== cardSeq) return;
    holdWord();
  });

  // 释义是接在选项下方长出来的。矮窗口下它会顶出卡片可视区，
  // 这里只补滚「差的那一点」，让释义完整露出来、词和选项尽量还留在屏上。
  const cardEl = $('card');
  if (cardEl) {
    requestAnimationFrame(function () {
      if (seq !== cardSeq) return;
      const need = fb.offsetTop + fb.offsetHeight - cardEl.clientHeight;
      const max = cardEl.scrollHeight - cardEl.clientHeight;
      if (need > 0 && max > 0) cardEl.scrollTop = Math.min(need, max);
    });
  }

  if (!ok) speak(w);
  /* 答对不再自动翻页。以前是 900ms 后自己跳 —— 快是快，但四个选项刚变绿就没了，
     释义、英文、搭配一个都没读到，等于只练了「认选项」。
     现在统一停下来：看完点「下一个」或按空格。 */
}

function studyDetailButton() {
  return '<button type="button" class="big ghost study-detail" title="查看完整词条（A）">完整词条</button>';
}

function holdWord() {
  toast('已记为不熟，复习时会再考');
  grade(1);
}

/* 保留字符位置，只统一撇号和连字符。遇到复合词或缩写，不把其中一截误当作完整词。 */
function exactWordSpans(text, word) {
  const fold = function (s) {
    return s.replace(/[‘’]/g, "'").replace(/[‐‑]/g, '-')
      .replace(/[A-Z]/g, function (ch) { return ch.toLowerCase(); });
  };
  const haystack = fold(text), needle = fold(word);
  const spans = [];
  if (!needle) return spans;
  const alnum = /[a-z0-9]/;
  const joiner = /['-]/;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) {
    const end = i + needle.length;
    const left = haystack.charAt(i - 1), right = haystack.charAt(end);
    if (alnum.test(left) || alnum.test(right)) continue;
    if (joiner.test(left) && alnum.test(haystack.charAt(i - 2))) continue;
    if (joiner.test(right) && alnum.test(haystack.charAt(end + 1))) continue;
    spans.push([i, end]);
  }
  return spans;
}

function blankOut(text, w) {
  const spans = exactWordSpans(text, w);
  if (spans.length !== 1) return null;
  return text.slice(0, spans[0][0]) + '_____' + text.slice(spans[0][1]);
}
function clozeHint(w, entry) {
  const s = firstSent(entry);
  return s ? blankOut(s[0], w) : null;
}
/* 优先用短而可追溯的真题句，缺少合适句子时使用和释义配对的词条例句。 */
function ctxPrompt(entry) {
  const w = entry[0];
  for (const row of paperRows(w)) {
    const sentence = paperExample(row);
    if (!sentence[3] || sentence[0].length > 165) continue;
    const q = blankOut(sentence[0], w);
    if (q) return { q: q, sentence: sentence, pos: '' };
  }
  const ss = entry[6] || [];
  for (let i = 0; i < ss.length; i++) {
    if (!ss[i] || !ss[i][0]) continue;
    const b = blankOut(ss[i][0], w);
    if (b) return { q: b, sentence: ss[i], pos: defPos([entry[1][i]]) };
  }
  return null;
}
function ctxMeta(question, word) {
  const source = question.sentence[3] ? '真题摘句' : '词条例句';
  const pos = question.pos ? ' · <b class="pos">' + esc(question.pos) + '.</b>' : '';
  const length = (word.match(/[a-z]/gi) || []).length;
  return source + pos + ' · ' + length + ' 个字母';
}
/* 拼写 / 语境 / 听写共用的输入框接线（含 Alt+S 听音、🔊 按钮，有就接） */
function wireSpellInput(w) {
  const inp = $('spell');
  if (!inp) return;
  if (!IS_TOUCH) inp.focus();
  inp.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); checkSpell(); }
    else if (e.key === 'Escape') { e.preventDefault(); showSpellAnswer(false, true); }
    else if (e.altKey && e.key.toLowerCase() === 's' && $('playw')) { e.preventDefault(); speak(w); }
  });
  const sb = $('submit');
  if (sb) sb.addEventListener('click', checkSpell);
  const pw = $('playw');
  if (pw) pw.addEventListener('click', function (e) {
    e.currentTarget.blur();
    speak(w);
    const i2 = $('spell');
    if (i2 && !spellChecked) i2.focus();   // 听完能直接接着打字
  });
}
/* 听写卡的「提示」：给一条中文释义，代价是这一张最高只记「模糊」 */
function showListenHint() {
  if (!current || spellChecked || usedHint) return;
  usedHint = true;
  const el = $('listenmeta');
  const defs = current[1] || [];
  if (el) {
    el.innerHTML = '<span class="hintlabel">提示</span>' + esc(defs[0] || '（这条词没有释义数据）') +
      (defs.length > 1 ? ' …' : '') + '<i class="hintcost">这一张最高记「模糊」</i>';
  }
  const hw = $('hintw');
  if (hw) { hw.disabled = true; hw.textContent = '💡 已提示'; }
  const i2 = $('spell');
  if (i2) i2.focus();
}

function hintPattern(w) {
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    out += (i === 0 || !/[a-z]/i.test(c)) ? c : '_';
  }
  return out;
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z' -]/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeSpelling(s) {
  return s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[‐‑]/g, '-').replace(/\s+/g, ' ').trim();
}

function checkSpell() {
  if (spellChecked) { grade(pendingSpell); return; }
  const inp = $('spell');
  if (!inp || !inp.value.trim()) {
    if (inp) inp.focus();
    toast('先把单词拼出来；不会就点「不认识」');
    return;
  }
  showSpellAnswer(normalizeSpelling(inp.value) === normalizeSpelling(current[0]), false);
}

function showSpellAnswer(ok, skipped) {
  if (spellChecked) return;
  spellChecked = true;
  const w = current[0], defs = current[1];
  const spelDt = Date.now() - spellStart;
  // 拼对了但磨得比自己平时久 → 记「模糊」，各模式的判定口径一致（阈值随反应时自适应）
  // 用了听写提示的，就算答对也只到「模糊」——提示是借来的记忆，不该记满分
  pendingSpell = (ok && !skipped)
    ? (usedHint || spelDt > slowMs(cardKind === 'ctx' ? 'ctx' : (cardKind === 'listen' ? 'listen' : 'spell')) ? 2 : 3)
    : 1;
  if (!skipped) pushRt(cardKind, spelDt);   // 拼写 / 语境 / 听写各自留反应时样本，阈值慢慢贴合你的节奏
  ATTEMPT = { ok: ok && !skipped, ms: skipped ? 0 : spelDt, hint: usedHint };
  const inp = $('spell');
  const typedStr = inp.value || '';      // 藏起来之前先留一份，用来算逐字母差异
  inp.disabled = true;
  inp.classList.add(ok && !skipped ? 'right' : 'wrong');
  // 答案已经写在下面了，输入框和挖空句就别占地方了
  inp.classList.add('gone');
  const card = $('card');
  card.classList.add('spell-answered');
  const cz = card.querySelector('.sent.cloze');
  if (cz) cz.remove();
  const cq = card.querySelector('.ctxq');
  if (cq) cq.remove();
  const cm = card.querySelector('.ctxmeta');
  if (cm) cm.remove();          // 语境卡的首字母提示也收走
  const lb = card.querySelector('.listenbig');
  if (lb) lb.remove();          // 听写卡的大喇叭也收走（答案块里有发音按钮）
  const lm = card.querySelector('.listenmeta');
  if (lm) lm.remove();          // 听写卡的提示行一起收走
  const th = card.querySelector('.tinyhint');
  if (th) th.remove();
  const wa = card.querySelector('#wacts');
  if (wa) wa.remove();          // 答案出来了，别再让人点「已掌握」
  const lr = card.querySelector('.listenrow');
  if (lr) lr.remove();          // 答案块里已经有发音按钮，别重复
  const pr = card.querySelector('.meaning.prompt');
  if (pr) pr.remove();          // 答案块里已经有释义了，别重复
  const fb = $('spellfb');
  const isNewPhase = PHASE === 'new';
  const right = ok && !skipped;
  const lblOk = cardKind === 'ctx' ? '✓ 填对了' : (cardKind === 'listen' ? '✓ 听对了' : '✓ 拼对了');
  const lblBad = cardKind === 'ctx' ? '✗ 填错了' : (cardKind === 'listen' ? '✗ 听错了' : '✗ 拼写不对');
  const lblSkip = cardKind === 'listen' ? '已跳过，听答案' : '已跳过';
  const example = contextQuestion && contextQuestion.sentence;
  const seq = cardSeq;
  fb.innerHTML =
    '<div class="word small">' + esc(w) + ' <button id="speak2" class="icon">🔊</button></div>' +
    (current[4] || current[5] ? phonHtml({ us: current[4], uk: current[5] }) : '') +
    '<div class="qres ' + (right ? 'ok' : (skipped ? 'skip' : 'bad')) + '">' +
    (right ? lblOk : (skipped ? lblSkip : lblBad)) +
    (usedHint ? '<span class="qnote">用了提示，最高记「模糊」</span>' : '') +
    '</div>' +
    (right || skipped ? '' : spellDiffHtml(typedStr, w)) +
    (example ? '<div class="ctx-answer">' + sentHtml(example, w, true) + '</div>' : '') +
    forgetCurveSvg(S.progress[w], pendingSpell) +
    '<div class="meaning">' +
    noteLineHtml(w) + defsHtml(defs, example ? null : current[6], 2, w) + (example ? '' : kyLineHtml(w)) +
    metaRowHtml(current) + '</div>';
  fb.querySelector('#speak2').addEventListener('click', function (e) { e.currentTarget.blur(); speak(w); });
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { if (seq === cardSeq) fitFeedback(fb); });
  });
  if (!example) kyPaintSoon();
  const row = $('spellrow');
  if (row) {
    row.innerHTML = studyDetailButton() +
      (right ? '<button id="hold" class="big" title="把这个词记为不熟">还不熟 <kbd>N</kbd></button>' : '') +
      '<button id="next" class="primary big">' + (isNewPhase && right ? '加入复习' : '下一个') + ' <kbd>空格</kbd></button>';
    $('next').addEventListener('click', function () { grade(pendingSpell); });
    const hd = $('hold');
    if (hd) hd.addEventListener('click', holdWord);
  }
  speak(w);
}

function renderDone() {
  if (PHASE === 'drill') { renderDrillDone(); return; }
  cardSeq++;   // 作废还在等待中的自动翻页
  current = null;
  clearHist();
  S.session = null; save();   // 本批结束，清除会话快照
  const card = $('card');
  card.classList.remove('intro', 'answered', 'spell-answered');
  updateTopbar();
  const d = dayRec();

  if (PHASE === 'wrong') {
    round = 1;
    PHASE = 'review';
    updateStudySub(false);
    card.innerHTML =
      '<div class="done">' +
      '<div class="done-emoji">🎯</div>' +
      '<h2>错词刷完</h2>' +
      '<p>本次刷错词 ' + (session.n + session.r) + ' 个。错词计数清零后会移出错词本。</p>' +
      '<div class="actions">' +
      '<button id="backlist" class="primary big">返回单词本</button>' +
      '<button id="openstats" class="big">统计</button>' +
      '</div></div>';
    $('backlist').addEventListener('click', function () { show('list'); });
    $('openstats').addEventListener('click', openStats);
    return;
  }

  // 成绩单：首轮词数 + 每轮巩固词数
  const uniq = Object.keys(sessionGrades).length || (session.n + session.r);
  const retry = pendingWords().filter(function (w) { return !isParked(w); });
  const mastery = retry.length
    ? '完成 ' + uniq + ' 个词，其中 ' + retry.length + ' 个还不熟。可以现在复测。'
    : '本轮完成 ' + uniq + ' 个词，已安排后续复习。';
  // 结算后轮次状态归零
  round = 1;
  updateStudySub(false);

  // 全部掌握的小庆祝彩带
  const conf = [];
  for (let i = 0; i < 14; i++) {
    conf.push('<i class="cf" style="left:' + (3 + i * 7) + '%;animation-delay:' + (i * 0.1).toFixed(2) +
      's;background:' + ['#69b58c', '#e8a33d', '#d67f70', '#7c93ff'][i % 4] + '"></i>');
  }

  const cwUnseen = chapterWords(CUR_CH).filter(function (w) { return !S.progress[w] && !isParked(w); }).length;
  const wrongN = WORDS.filter(function (it) {
    const p = S.progress[it[0]];
    return p && p.wrong > 0;
  }).length;
  /* 乱序时「本章学完」不代表这一轮的意义，改成看整本书 */
  const chDone = S.settings.order === 'random' ? unseenCount() === 0 : cwUnseen === 0;
  const ssN = sessStats();

  card.innerHTML =
    '<div class="confetti">' + conf.join('') + '</div>' +
    '<div class="done">' +
    '<div class="done-emoji">🎉</div>' +
    '<h2>' + (chDone
      ? (S.settings.order === 'random' ? '本书新词学完' : 'List ' + CHAPTERS[CUR_CH].label + ' 学完')
      : '本轮完成') + '</h2>' +
    '<div class="done-cards q4">' +
    '<div class="dc"><b>' + session.n + '</b><span>本次新词</span></div>' +
    '<div class="dc"><b>' + session.r + '</b><span>本次复习</span></div>' +
    '<div class="dc"><b>' + d.n + '</b><span>今日累计新词</span></div>' +
    '<div class="dc"><b>' + ssN.avgTxt + '</b><span>平均反应</span></div>' +
    '</div>' +
    '<p>' + mastery + '</p>' +
    missHtml() +
    '<div class="actions">' +
    (retry.length ? '<button id="retry-new" class="primary big">复测 ' + retry.length + ' 个</button>' : '') +
    (unseenCount() ? '<button id="more" class="big' + (retry.length ? '' : ' primary') + '">再学 ' + Math.min(10, unseenCount()) + ' 个</button>' : '') +
    (CUR_CH + 1 < CH_COUNT ? '<button id="nextch" class="big">下一章</button>' : '') +
    '<button id="backhero" class="big' + (retry.length || unseenCount() ? '' : ' primary') + '">回封面</button>' +
    '</div>' +
    '<div class="actions sm">' +
    '<button id="gochapters" class="big ghost">选章节</button>' +
    (wrongN ? '<button id="wrongdrill" class="big ghost">错词重刷 (' + wrongN + ')</button>' : '') +
    '<button id="openstats" class="big ghost">统计</button>' +
    '</div></div>';
  wireMiss(card);

  const again = $('retry-new');
  if (again) again.addEventListener('click', function () { drillWith(retry, '本轮薄弱词', 'new', 'auto'); });
  const more = $('more');
  if (more) more.addEventListener('click', function () { startSession('new', 10); });
  const nx = $('nextch');
  if (nx) nx.addEventListener('click', function () { startPhase('new', { chapter: CUR_CH + 1, count: S.settings.newPerDay }); });
  $('gochapters').addEventListener('click', function () { show('books'); });
  const bh = $('backhero');
  if (bh) bh.addEventListener('click', function () { PHASE = 'review'; renderHero(); });
  const wd = $('wrongdrill');
  if (wd) wd.addEventListener('click', function () { startPhase('wrong'); });
  $('openstats').addEventListener('click', openStats);
}

/* 专项练习收尾：这不是日常任务，所以不塞「今日累计」，只交代这一组成绩 + 出口 */
function renderDrillDone() {
  cardSeq++;
  const label = DRILL ? DRILL.label : '专项练习';
  const mode = DRILL ? DRILL.mode : '';
  const from = DRILL ? DRILL.from : '';
  const words = Object.keys(sessionGrades);
  const doneN = Object.keys(sessionGrades).length || (session.n + session.r);
  const retry = pendingWords().length;
  const spent = Math.max(1, Math.round((Date.now() - PHASE_T0) / 60000));
  const leftLeech = leechWords().length;
  current = null;
  clearHist();
  S.session = null;
  PHASE = 'review'; DRILL = null;
  save();
  const subEl = $('study-sub-text');
  if (subEl) subEl.textContent = label + '完成 · ' + doneN + ' 词';
  const pb = $('pbar-in');
  if (pb) pb.style.width = '100%';
  const card = $('card');
  card.classList.remove('intro', 'answered', 'spell-answered');
  updateTopbar();
  const ssD = sessStats();
  card.innerHTML = doneHtml('🎯', label + '完成',
    '这一组 ' + doneN + ' 个词过了一遍 · 用时约 ' + spent + ' 分钟 · 最高连击 ' + comboBest + '。' +
    (retry ? '<br><span class="muted">还有 ' + retry + ' 个不熟，已安排后续复习。</span>' : '') +
    (leftLeech ? '<br><span class="muted">还有 ' + leftLeech + ' 个顽固词（错过 ≥' + LEECH_AT + ' 次）在等你。</span>' : ''),
    [{ n: doneN, t: '本组词数' }, { n: spent + '′', t: '用时' },
      { n: ssD.avgTxt, t: '平均反应' }, { n: comboBest, t: '最高连击' }],
    [['再来一遍', 'drill-again', 'primary big'],
      from === 'wrong' ? ['返回错词本', 'backlist', 'big'] : ['回封面', 'go-hero', 'big']], missHtml());
  wireMiss(card);
  const ga = $('drill-again');
  if (ga) ga.addEventListener('click', function () { startPhase('drill', { words: words, label: label, mode: mode, from: from }); });
  const bl = $('backlist');
  if (bl) bl.addEventListener('click', function () { gotoList('wrong'); });
  const gh = $('go-hero');
  if (gh) gh.addEventListener('click', function () { PHASE = 'review'; renderHero(); });
}

/* ================= 语音（有道在线发音） ================= */
/* v6.9.4：发音整条链路换掉了 —— 不再用浏览器 / 系统的语音合成（speechSynthesis），
 * 统一播有道词典的发音音频。换的原因很实在：
 *   1. 微信 / QQ 内置浏览器根本没有 speechSynthesis 这个 API，点了静默无声；
 *   2. iOS 在静音拨片打开时会静默失败，连 error 都拿不到；
 *   3. 每台机器装的语音包不一样，读出来是浓重的机器音，跟词典 App 差得远。
 * 现在只有一条路：https://dict.youdao.com/dictvoice?audio=<词>&type=1|2
 *   type=1 英音、type=2 美音；中文释义走 le=zh。
 * 代价写在明处：必须联网，而且会把单词发给有道（只在点 🔊 或自动发音时发）。
 * 断网 / 接口不通时不装死 —— markSpeaking 收掉动画，并给一句「检查网络」。 */

const YOUDAO = 'https://dict.youdao.com/dictvoice?audio=';
let _voiceWarned = false;   // 「读不出来」只提醒一次，别每张卡都弹
let _audio = null;          // 单例 audio 元素：复用同一个，iOS 才认「已被手势解锁」
let _audioUrl = '';         // 当前 src，同词重播直接回到 0 秒，不重新下载
let _audioTok = 0;          // 播放序号：连点时旧的回调不能污染新的
let _audioTimer = 0;

/* 手机端和桌面端的差异只剩「自动播放策略」，其余一致。
 * iOS 判断用 UA + maxTouchPoints（iPadOS 的 UA 伪装成 Mac）。 */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const IS_TOUCH = IS_IOS || IS_ANDROID || /Mobile/i.test(navigator.userAgent);

/* 口音决定 type。显式传了 lang 就以调用方为准（查词卡上有独立的「美音 / 英音」两个按钮），
 * 没传就跟着设置走。 */
function youdaoType(lang) {
  if (lang === 'en-GB' || lang === 'en-UK') return 1;
  if (lang === 'en-US') return 2;
  return (S && S.settings && S.settings.accent === 'uk') ? 1 : 2;
}

function audioEl() {
  if (_audio) return _audio;
  if (typeof Audio !== 'function') return null;
  try { _audio = new Audio(); _audio.preload = 'auto'; } catch (e) { _audio = null; }
  return _audio;
}

/* 「正在读」的视觉状态：给所有 🔊 按钮加脉冲，让网络往返那几百毫秒有交代 */
let _spkTimer = 0;
function markSpeaking(on) {
  try {
    document.body.classList.toggle('is-speaking', !!on);
    clearTimeout(_spkTimer);
    if (on) {
      // 兜底：万一 playing/ended 都没来，4 秒后自动收掉，别一直闪
      _spkTimer = setTimeout(function () { document.body.classList.remove('is-speaking'); }, 4000);
    }
  } catch (e) { /* ignore */ }
}

/* iOS / 安卓的自动播放策略：音频必须由「用户手指点下去」那一下触发。
 * 自动发音是页面自己发起的，第一条会被系统拦掉。解法是在第一次真实交互里，
 * 用**同一个** audio 元素静音播 0.1 秒空波把这个元素解锁 —— 之后程序化 play() 才出声。 */
let _audioPrimed = false;
function silentWavUrl() {
  try {
    const n = 800;                                  // 0.1s @ 8kHz 8bit
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const w = function (o, s) { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);   // 8bit 无符号的静音值
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  } catch (e) { return ''; }
}
/* 先试一次（桌面浏览器多半直接放行）；被自动播放策略拦了，
 * 就退回「等第一次真实手势再试」—— 手机上只有这一下才有权限。 */
let _primeBound = false;
function bindPrimeOnGesture() {
  if (_primeBound) return;
  _primeBound = true;
  const kick = function () {
    document.removeEventListener('pointerdown', kick, true);
    document.removeEventListener('keydown', kick, true);
    document.removeEventListener('touchstart', kick, true);
    primeAudio();
  };
  document.addEventListener('pointerdown', kick, true);
  document.addEventListener('keydown', kick, true);
  document.addEventListener('touchstart', kick, true);
}
function primeAudio() {
  if (_audioPrimed) return;
  const a = audioEl();
  const url = silentWavUrl();
  if (!a || !url) return;
  _audioPrimed = true;
  try {
    a.muted = true;
    a.src = url;
    const pr = a.play();
    if (pr && pr.catch) pr.catch(function () {
      _audioPrimed = false;          // 被拦了：等用户第一次触摸再解一次
      bindPrimeOnGesture();
    });
  } catch (e) {
    _audioPrimed = false;
    bindPrimeOnGesture();
  }
}

/* 播一个词 / 一句话。onDone 的状态跟旧实现保持一致：start / end / fail，
 * 这样六个调用点（卡片、查词卡、例句、听写…）一行都不用改。 */
function speakAudio(w, lang, onDone) {
  const done = typeof onDone === 'function' ? onDone : function () {};
  const text = String(w == null ? '' : w).trim();
  if (!text) return false;
  const a = audioEl();
  if (!a) return false;
  const isZh = /^zh/i.test(lang || '');
  const url = isZh
    ? YOUDAO + encodeURIComponent(text) + '&le=zh'
    : YOUDAO + encodeURIComponent(text) + '&type=' + youdaoType(lang);
  const tok = ++_audioTok;
  clearTimeout(_audioTimer);
  let started = false;
  try { a.pause(); } catch (e) { /* ignore */ }
  a.muted = false;
  a.onplaying = function () {
    if (tok !== _audioTok) return;
    started = true; markSpeaking(true); done('start');
  };
  a.onended = function () {
    if (tok !== _audioTok) return;
    markSpeaking(false); done('end');
  };
  a.onerror = function () {
    if (tok !== _audioTok) return;
    clearTimeout(_audioTimer); markSpeaking(false); done('fail', 'audio');
  };
  if (url === _audioUrl && !a.error) {
    /* 同一个词再来一次：不重新下载，直接回到 0 秒（播完后再 play() 本来也会从头开始） */
    try { a.currentTime = 0; } catch (e) { /* ignore */ }
  } else {
    a.src = url;
    _audioUrl = url;
  }
  try {
    const pr = a.play();
    if (pr && pr.catch) pr.catch(function () { /* 被自动播放策略拦了，交给下面的超时判死 */ });
  } catch (e) {
    markSpeaking(false); done('fail', 'audio'); return false;
  }
  /* 6 秒还没开始播就判死（离线 / 接口被墙 / 首包太慢）：
     长句音频本身要下载一会儿，所以给得比单词宽。 */
  _audioTimer = setTimeout(function () {
    if (tok !== _audioTok || started) return;
    markSpeaking(false);
    done('fail', navigator.onLine === false ? 'offline' : 'audio-timeout');
  }, 6000);
  return true;
}

/* 唯一的播放入口。lang 省略 = 按设置里的口音。 */
function speak(w, lang, opts) {
  const o = opts || {};
  const done = function (st, msg) { if (typeof o.onState === 'function') o.onState(st, msg); };
  const text = String(w == null ? '' : w).trim();
  if (!text) return;
  if (navigator.onLine === false) {
    /* 断网就别发请求了，直接说清楚 —— 免得用户对着「正在读」的动画等 6 秒 */
    markSpeaking(false);
    const noNet = '现在没联网 —— 发音用的是有道词典的在线音频，连上网才能读';
    done('fail', 'offline');
    if (o.auto) showSpeakWarn(noNet);
    else if (!_voiceWarned) { _voiceWarned = true; toast(noNet); }
    return;
  }
  markSpeaking(true);
  const ok = speakAudio(text, lang, function (st, msg) {
    if (st === 'start') _voiceWarned = false;
    done(st, msg);
    if (st !== 'fail') return;
    markSpeaking(false);
    const why = msg === 'audio-timeout'
      ? '发音音频没回来，网络可能太慢或被拦了 —— 过会儿再点一次 🔊'
      : '发音下载失败 —— 检查一下网络，或者换个网络再试';
    if (o.auto) showSpeakWarn(why);
    else if (!_voiceWarned) { _voiceWarned = true; toast(why); }
  });
  if (!ok) { markSpeaking(false); done('fail', 'no-audio'); }
}

/* 设置页那行灰字 / 自检失败后的补充说明，统一从这里取。
 * 以前这里在判断「装没装英语语音包」，现在只剩一件事：网络通不通。 */
function speechStatus() {
  const acc = (S && S.settings && S.settings.accent === 'uk') ? '英音' : '美音';
  if (navigator.onLine === false) {
    return { ok: false, msg: '现在没联网 —— 发音是有道词典的在线音频，连上网才能读（音标不受影响）' };
  }
  return { ok: true, msg: '有道' + acc + ' · 需要联网；断网时读不出来，音标照常看' };
}

/* 自动发音失败时，在卡片顶部留一条能看清、能点掉的提示。
 * 用 toast 不行 —— 1.8 秒就没了，用户只会觉得「这功能坏了」。
 * 但也不能每张卡都插一条（自动发音是逐卡触发的），所以整个会话只提示一次；
 * 用户点 ✕ 之后也不再打扰，想再看就去设置里的发音自检。 */
let _speakWarnShown = false;
function showSpeakWarn(msg, force) {
  const card = $('card');
  if (!card || $('speak-warn')) return;
  if (_speakWarnShown && !force) return;
  _speakWarnShown = true;
  const el = document.createElement('div');
  el.id = 'speak-warn';
  el.className = 'speak-warn';
  el.innerHTML = '<span>🔇 ' + esc(msg) + '</span>' +
    '<button class="sw-fix" type="button">怎么修</button>' +
    '<button class="sw-x" type="button" aria-label="关掉提示">✕</button>';
  card.insertBefore(el, card.firstChild);
  const fx = el.querySelector('.sw-fix');
  if (fx) fx.addEventListener('click', function () { showVoiceHelp(); });
  const xx = el.querySelector('.sw-x');
  if (xx) xx.addEventListener('click', function () { el.remove(); });
}

/* 设置页的「读一遍试试」：真的去读一个词，并把「出没出声、第几秒起播」写回灰字，
 * 别只说「正在读…」。这一行也是用户判断「要不要换网络」的唯一依据。 */
function speakSelfTest(head) {
  const el = $('set-speech-msg');
  const who = (S && S.settings && S.settings.accent === 'uk') ? '有道英音' : '有道美音';
  if (el) el.textContent = (head ? head + ' · ' : '') + '正在用' + who + '读 vocabulary …';
  _voiceWarned = false;
  const t0 = Date.now();
  speak('vocabulary', null, {
    onState: function (st, why) {
      const e2 = $('set-speech-msg');
      if (!e2 || !e2.isConnected) return;
      if (st === 'start') {
        e2.textContent = '✅ 出声了 —— ' + who + '，' +
          ((Date.now() - t0) / 1000).toFixed(1) + ' 秒起播。自动发音用的就是这个';
      } else if (st === 'end') {
        e2.textContent = '✅ 读完了 —— ' + who + '。自动发音用的就是这个';
      } else if (st === 'fail') {
        const why2 = why === 'offline' ? '没网' : (why === 'audio-timeout' ? '音频没回来' : (why || '未知'));
        e2.textContent = '❌ 没出声（' + why2 + '）。' + speechStatus().msg +
          ' —— 也可以换「英音」再试一次';
      }
    }
  });
}

/* ================= 页面切换 ================= */
function show(page) {
  if (PAGES.indexOf(page) < 0) page = 'study';
  const moved = S.page !== page;
  S.page = page; save();
  PAGES.forEach(function (p) {
    $('page-' + p).classList.toggle('hidden', p !== page);
  });
  document.querySelectorAll('#nav button').forEach(function (b) {
    const active = b.dataset.page === page;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (moved) window.scrollTo(0, 0);
  $('hints').classList.toggle('hidden', page !== 'study');
  if (page === 'books') renderBooksPage();
  else if (page === 'dict') initDictPage();
  else if (page === 'list') initListPage();
  refreshSide();
  syncLock();
}

/* ================= 词书分级页 ================= */
async function renderBooksPage() {
  const root = $('books-root');
  if (!ALL_LOADED) {
    root.innerHTML = '<p class="muted center">正在加载全部词库…</p>';
    await ensureAllBooks();
  }
  let html = '';
  for (const bid of Object.keys(BOOKS)) {
    const words = VD_DATA[bid].words;
    const total = words.length;
    let learned = 0, mastered = 0;
    for (const it of words) {
      const p = S.progress[it[0]];
      if (p) { learned++; if (p.lv >= 3) mastered++; }
    }
    const isCur = bid === S.settings.book;
    html += '<div class="bcard' + (isCur ? ' cur' : '') + '">' +
      '<div class="bhead"><b>' + esc(BOOKS[bid].name) + '</b><span class="muted">' + total + ' 词</span></div>' +
      '<div class="bar"><div class="bar-in" style="width:' + (total ? Math.round(learned / total * 100) : 0) + '%"></div></div>' +
      '<div class="bmuted muted">已背 ' + learned + ' · 已掌握 ' + mastered + ' · 未背 ' + (total - learned) + '</div>';

    if (isCur) {
      const curCh = bookChapter(bid);
      // 字母跳转条：100 章的长列表里快速定位（按首字母分段）
      const letters = [];
      CHAPTERS.forEach(function (ch, i) {
        if (!letters.length || letters[letters.length - 1].l !== ch.label[0]) {
          letters.push({ l: ch.label[0], i: i });
        }
      });
      html += '<div class="chnav">' + letters.map(function (x) {
        return '<button class="chnav-b" data-chi="' + x.i + '">' + esc(x.l) + '</button>';
      }).join('') + '</div>';
      html += '<div class="chgrid">';
      CHAPTERS.forEach(function (ch, i) {
        let l = 0;
        for (const w of ch.words) if (S.progress[w]) l++;
        const cls = (l === ch.words.length ? 'done' : (l > 0 ? 'doing' : '')) + (i === curCh ? ' cur' : '');
        html += '<button class="ch ' + cls + '" data-i="' + i + '" title="List ' + esc(ch.label) + ' · 点击查看章节词表">' +
          '<b>' + esc(ch.label) + '</b><span>' + l + '/' + ch.words.length + '</span>' +
          '<i style="width:' + Math.round(l / ch.words.length * 100) + '%"></i></button>';
      });
      html += '</div>';
      html += '<p class="bmuted muted">按首字母分组，点章节可查看词表并回看每个单词</p>';
      html += '<div class="actions" style="justify-content:flex-start">' +
        '<button class="big primary bcontinue">继续学习 List ' + esc(CHAPTERS[curCh].label) + '</button></div>';
    } else {
      html += '<div class="actions" style="justify-content:flex-start">' +
        '<button class="big bswitch" data-b="' + bid + '">切换到此书</button></div>';
    }
    html += '</div>';
  }
  root.innerHTML = html;

  root.querySelectorAll('.ch').forEach(function (b) {
    b.addEventListener('click', function () { openChapter(+b.dataset.i); });
  });
  root.querySelectorAll('.chnav-b').forEach(function (b) {
    b.addEventListener('click', function () {
      const t = root.querySelector('.ch[data-i="' + b.dataset.chi + '"]');
      if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });
  const bc = root.querySelector('.bcontinue');
  if (bc) bc.addEventListener('click', function () { PHASE = 'review'; show('study'); renderHero(); });
  root.querySelectorAll('.bswitch').forEach(function (b) {
    b.addEventListener('click', function () { switchBook(b.dataset.b); });
  });
}

function switchBook(bid) {
  parkStudySession();
  S.settings.book = bid;
  save();
  $('book').value = bid;
  prepareBook().then(function () { PHASE = 'review'; show('study'); renderHero(); });
  toast('已切换到《' + BOOKS[bid].name + '》');
}

/* ================= 章节详情弹窗 ================= */
function openChapter(i) {
  const ch = CHAPTERS[i];
  if (!ch) return;
  let learned = 0;
  for (const w of ch.words) if (S.progress[w]) learned++;
  const rows = ch.words.map(function (w) {
    const it = DEFMAP.get(w);
    return rowHtml({ w: it[0], defs: it[1], freq: isHighFreq(it) });
  }).join('');
  const allDone = learned >= ch.words.length;
  $('modal-body').innerHTML =
    '<h2>📘 List ' + esc(ch.label) + ' · ' + ch.words.length + ' 词 · 已学 ' + learned + '</h2>' +
    '<div class="actions" style="justify-content:flex-start;margin-bottom:12px">' +
    '<button id="ch-study" class="big primary">' + (allDone ? '复习本章' : '学习本章') + '</button>' +
    '<button id="ch-close" class="big">返回</button></div>' +
    '<p class="muted" style="font-size:12px;margin:-4px 0 10px">' +
    (allDone ? '本章已学完，点上面会把整章再过一遍（不会跳到下一章）'
      : '只学这一章里还没背的词，学完就停，不会串到下一章') + '</p>' +
    '<div class="rowlist">' + rows + '</div>';
  $('ch-study').addEventListener('click', function () {
    closeModal();
    startPhase('new', { chapter: i, count: S.settings.newPerDay }).then(function () { show('study'); });
  });
  $('ch-close').addEventListener('click', closeModal);
  wireRows($('modal-body'));
  $('modal').classList.remove('hidden');
}

/* ================= 多级联动：把图上的一个数字变成一批能立刻练的词 ================= */
/* 某一天到期的词。offset=0 表示「今天及更早」（和封面预测柱口径一致） */
function dayWords(offset) {
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  const lo = t0.getTime() + offset * DAY;
  const hi = lo + DAY;
  const out = [];
  for (const it of WORDS) {
    const p = S.progress[it[0]];
    if (!p || p.due == null || isParked(it[0])) continue;
    if (offset === 0 ? p.due < hi : (p.due >= lo && p.due < hi)) out.push(it[0]);
  }
  return out;
}
/* 把一组词摆成「专项练习」（不动今日计划、不占新词额度） */
function drillWith(words, label, from, mode) {
  const list = (words || []).filter(function (w) { return !!w; });
  if (!list.length) { toast('这一组没有可练的词'); return; }
  closeModal();
  startPhase('drill', { words: list, label: label || '专项练习', from: from || '', mode: mode || '' }).then(function () {
    show('study');
  });
}
function startLeechDrill() {
  const ws = leechWords();
  if (!ws.length) { toast('还没有顽固词：连续错过 ' + LEECH_AT + ' 次的词才会进这里'); return; }
  drillWith(ws.slice(0, 40), '顽固词攻坚', 'leech');
}
/* 某天到期词明细：图表 → 明细 → 直接开练，三级联动 */
function openDayWords(offset) {
  const ws = dayWords(offset);
  const label = offset === 0 ? '今天（含更早未清）' : offset + ' 天后';
  const shown = ws.slice(0, 300);
  const rows = shown.map(function (w) {
    const e = entryOf(w);
    return rowHtml({ w: e[0], defs: e[1], freq: isHighFreq(e) });
  }).join('');
  $('modal-body').innerHTML =
    '<h2>📅 ' + esc(label) + '到期 · ' + ws.length + ' 词</h2>' +
    (ws.length
      ? '<div class="actions" style="justify-content:flex-start;margin-bottom:10px">' +
        '<button id="day-go" class="big primary">现在练这 ' + ws.length + ' 个</button>' +
        '<button id="day-close" class="big">关闭</button></div>' +
        '<p class="muted" style="font-size:12px;margin:-4px 0 10px">' +
        '点词条看详情；「现在练」是单独一组，不动今天的日常计划，也不占新词额度。' +
        (ws.length > 300 ? '（仅列出前 300 个）' : '') + '</p>' +
        '<div class="rowlist">' + rows + '</div>'
      : '<p class="muted">这一天没有到期词。</p>' +
        '<div class="actions"><button id="day-close" class="big">关闭</button></div>');
  const g = $('day-go');
  if (g) g.addEventListener('click', function () { drillWith(ws, label + '到期词', 'day'); });
  const c = $('day-close');
  if (c) c.addEventListener('click', closeModal);
  wireRows($('modal-body'));
  $('modal').classList.remove('hidden');
}
/* 熟练度某一级 → 词表 → 直接开练。让统计图上的每根柱子都是可点的入口，而不是装饰 */
function openLvWords(lv) {
  const bk = (VD_DATA[S.settings.book] && VD_DATA[S.settings.book].words) || WORDS;
  const ws = [];
  for (const it of bk) {
    const p = S.progress[it[0]];
    if (!p || isParked(it[0])) continue;
    if (Math.min(p.lv || 0, 7) === lv) ws.push(it[0]);
  }
  const name = lv === 0 ? '刚接触（连答对一次都还没有）'
    : lv >= 6 ? '很牢（间隔已拉到 2 个月以上）'
      : lv >= 3 ? '已掌握（能稳定想起）'
        : '在巩固（还记得，但还不稳）';
  const rows = ws.slice(0, 300).map(function (w) {
    const e = entryOf(w);
    return rowHtml({ w: e[0], defs: e[1], freq: isHighFreq(e) });
  }).join('');
  $('modal-body').innerHTML =
    '<h2>🎚 Lv' + lv + ' · ' + ws.length + ' 词</h2>' +
    '<p class="muted" style="font-size:12px;margin:-4px 0 10px">' + name +
    '。等级由记忆强度推出来（越牢间隔越长），所以它不是「背了几个」，而是「还记得多深」。</p>' +
    (ws.length
      ? '<div class="actions" style="justify-content:flex-start;margin-bottom:10px">' +
        '<button id="lv-go" class="big primary">现在练这 ' + ws.length + ' 个</button>' +
        '<button id="lv-close" class="big">关闭</button></div>' +
        '<div class="rowlist">' + rows + '</div>'
      : '<p class="muted">这一级还没有词。</p>' +
        '<div class="actions"><button id="lv-close" class="big">关闭</button></div>');
  const g = $('lv-go');
  if (g) g.addEventListener('click', function () { drillWith(ws, 'Lv' + lv + ' 专项', 'lv'); });
  const c = $('lv-close');
  if (c) c.addEventListener('click', closeModal);
  wireRows($('modal-body'));
  $('modal').classList.remove('hidden');
}
/* 侧栏数字 → 单词本对应分组 */
function gotoList(tab) {
  listTab = tab || 'all';
  if (selMode) setSelMode(false);
  selSet.clear();
  show('list');
  renderListTabs();
  renderList();
}

/* ================= 查词页 ================= */
let dictWired = false;
async function initDictPage() {
  const res = $('dict-results');
  /* 字典 8MB，后台加载：不 await，先把两本词书的搜索结果给出来，
     加载完如果输入框里已经有字，再补一次结果 */
  ensureDict().then(function () {
    if (($('dict-search').value || '').trim()) renderDictResults();
  }, function () { /* 加载失败就只查词书，不打扰 */ });
  if (!ALL_LOADED) {
    res.innerHTML = '<p class="muted center">正在加载全部词库…</p>';
    await ensureAllBooks();
  }
  if (!dictWired) {
    dictWired = true;
    $('dict-search').addEventListener('input', renderDictResults);
  }
  renderDictResults();
  if (!IS_TOUCH && S.page === 'dict') $('dict-search').focus();
}

function renderDictResults() {
  if (!ALL_LOADED) return;
  const res = $('dict-results');
  const raw = $('dict-search').value.trim();
  const q = norm(raw);
  if (!q) {
    const h = S.shist || [];
    res.innerHTML =
      '<p class="muted center">输入单词查询释义、短语、例句与学习进度</p>' +
      (h.length
        ? '<h3 class="rsub">最近查询</h3><div class="chips">' +
          h.map(function (w) { return '<button class="chip hchip" data-w="' + esc(w) + '">' + esc(w) + '</button>'; }).join('') +
          '<button id="hclear" class="chip muted">清空</button></div>'
        : '');
    res.querySelectorAll('.hchip').forEach(function (b) {
      b.addEventListener('click', function () {
        $('dict-search').value = b.dataset.w;
        renderDictResults();
      });
    });
    const hc = res.querySelector('#hclear');
    if (hc) hc.addEventListener('click', function () {
      S.shist = []; save(); renderDictResults();
    });
    return;
  }
  const MAX = 50;
  const starts = [], mid = [];
  const headEntry = DICT.get(q) || lexEntry(q);
  for (const [w, e] of DICT) {
    if (w === q) continue;
    if (w.startsWith(q)) { if (starts.length < MAX) starts.push(e); }
    else if (w.indexOf(q) >= 0) { if (mid.length < MAX) mid.push(e); }
    if (starts.length >= MAX && mid.length >= MAX) break;
  }
  const bookRows = starts.concat(mid).slice(0, MAX);

  /* 词书没覆盖的，再从 9.8 万词的通用字典里补 —— 用户要的是「字典里的词都能查到，
     但只背考研和六级」。词书命中过的词不重复列，否则一条结果出现两次。 */
  const lexStarts = lexPrefix(q, MAX);
  const lexRows = lexStarts.concat(lexContains(q, MAX - lexStarts.length));
  const total = bookRows.length + lexRows.length + (headEntry ? 1 : 0);

  if (!total) {
    res.innerHTML = '<p class="muted center">没有找到「' + esc(raw) + '」' +
      (LEX_WORDS ? '' : '<br><span class="tinyhint">通用字典还在加载，稍等一下再试</span>') +
      '</p>';
    return;
  }

  res.innerHTML =
    '<p class="muted listcount">显示 ' + total + ' 条结果</p>' +
    (headEntry ? richCardHtml(headEntry, 'dc') : '') +
    bookRows.map(rowHtml).join('') +
    (lexRows.length ? '<h3 class="rsub">通用字典</h3>' + lexRows.map(lexRowHtml).join('') : '');
  wireRows(res);
  res.querySelectorAll('.lexrow').forEach(function (row) {
    row.addEventListener('click', function () {
      $('dict-search').value = row.dataset.lex;
      renderDictResults();
    });
  });
  if (headEntry) wireRichCard(res, headEntry, 'dc', renderDictResults);
}

function rowHtml(e) {
  const p = S.progress[e.w];
  const st = S.stars[e.w] || 0;
  const pk = parkState(e.w);
  const note = S.notes[e.w];
  const nb = confuseNeighbors(e.w);      // 混过的对手（双向），列表里也能一眼看到
  const def = note || e.defs[0] || '';
  const cls = ['row', statusClass(p),
    p && p.wrong > 0 ? 'f-wrong' : '',
    e.freq ? 'f-freq' : '',
    pk ? 'f-park' : '',
    selSet.has(e.w) ? 'sel' : ''].join(' ');
  return '<div class="' + cls + '" data-w="' + esc(e.w) + '">' +
    '<span class="rowcheck">' + (selSet.has(e.w) ? '☑' : '☐') + '</span>' +
    '<span class="dot"></span>' +
    '<span class="rword">' +
    (st ? '<i class="starmark">' + (st === 2 ? '⭐⭐' : '⭐') + '</i>' : '') +
    esc(e.w) +
    (p && p.wrong > 0 ? ' <i class="wrongmark">错' + p.wrong + '</i>' : '') +
    (nb.length ? ' <i class="cfmark" data-vs="' + esc(nb[0]) + '" title="易混：' +
      esc(nb.slice(0, 3).join(' / ')) + '（点一下看对手）">混' + nb.length + '</i>' : '') +
    (e.freq ? ' <i class="freqmark">高频</i>' : '') +
    (pk ? ' <i class="parkmark">已掌握</i>' : '') +
    (note ? ' <i class="notemark" title="有我的释义/备注">✎</i>' : '') +
    '</span>' +
    '<span class="rdef">' + esc(def.length > 30 ? def.slice(0, 30) + '…' : def) + '</span>' +
    '<button class="rowmore" data-w="' + esc(e.w) + '" title="改状态 / 改释义 / 删除">⋯</button>' +
    '</div>';
}
function wireRows(root) {
  root.querySelectorAll('.row').forEach(function (row) {
    row.addEventListener('click', function (ev) {
      if (ev.target.closest('.rowmore')) return;
      const cm = ev.target.closest('.cfmark');
      if (cm && !selMode) { openDetail(cm.dataset.vs); return; }   // 点「混N」直接看对手
      const w = row.dataset.w;
      if (selMode) {
        if (selSet.has(w)) selSet.delete(w); else selSet.add(w);
        paintSel();
        renderSelCount();
        return;
      }
      openDetail(w);
    });
  });
  root.querySelectorAll('.rowmore').forEach(function (b) {
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openRowMenu(b, b.dataset.w);
    });
  });
}

/* ================= 单词本页 ================= */
let listTab = 'all';
let listWired = false;
let selMode = false;                 // 多选模式
const selSet = new Set();            // 已勾选的词
let delArm = 0;                      // 删除按钮二次确认的计时器

async function initListPage() {
  if (!ALL_LOADED) {
    $('list-results').innerHTML = '<p class="muted center">正在加载全部词库…</p>';
    await ensureAllBooks();
    renderListTabs();
    renderList();
  } else {
    renderListTabs();
    renderList();
  }
  if (!listWired) {
    listWired = true;
    $('list-filter').addEventListener('input', function () { if (ALL_LOADED) renderList(); });
    document.querySelectorAll('#list-tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        listTab = b.dataset.t;
        if (selMode) setSelMode(false);
        selSet.clear();
        renderListTabs();
        renderList();
      });
    });
    $('redrill').addEventListener('click', function () {
      drillWith(visibleListWords(), '错词重刷', 'wrong');
    });
    $('wrong-listen').addEventListener('click', function () {
      if (navigator.onLine === false) { toast('听写需要联网播放发音'); return; }
      drillWith(visibleListWords().slice(0, 20), '错词听写', 'wrong', 'listen');
    });
    $('sel-toggle').addEventListener('click', function () { setSelMode(!selMode); });
    $('sel-all').addEventListener('click', function () { selectAllVisible(); });
    document.querySelectorAll('#sel-acts button').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.currentTarget.blur();
        bulkAct(b.dataset.act, +b.dataset.d || 0, b);
      });
    });
  }
}

function listSets() {
  const sets = { all: [], mastered: [], unseen: [], wrong: [], star: [], star2: [] };
  if (!ALL_LOADED) return sets;
  for (const e of DICT.values()) {
    const p = S.progress[e.w];
    const st = S.stars[e.w] || 0;
    const pk = parkState(e.w);
    if (st === 1) sets.star.push(e);
    else if (st === 2) sets.star2.push(e);
    if (pk === 'forever') { sets.mastered.push(e); continue; }
    if (!p) { sets.unseen.push(e); continue; }
    sets.all.push(e);
    if (p.lv >= 3) sets.mastered.push(e);
    if (p.wrong > 0) sets.wrong.push(e);
  }
  return sets;
}

function renderListTabs() {
  const sets = listSets();
  const labels = {
    all: '已背', mastered: '已掌握', unseen: '未背',
    wrong: '错词', star: '收藏', star2: '重点'
  };
  document.querySelectorAll('#list-tabs button').forEach(function (b) {
    const t = b.dataset.t;
    b.textContent = labels[t] + ' ' + (sets[t] ? sets[t].length : 0);
    b.classList.toggle('active', t === listTab);
  });
  $('sel-toggle').classList.toggle('hidden', !(sets[listTab] && sets[listTab].length));
}

/* 多选模式：行变成勾选，底部出批量操作 */
function setSelMode(on) {
  selMode = !!on;
  if (!selMode) selSet.clear();
  $('sel-toggle').textContent = selMode ? '✕ 退出多选' : '☑ 多选';
  $('sel-toggle').classList.toggle('primary', selMode);
  $('sel-all').classList.toggle('hidden', !selMode);
  $('sel-acts').classList.toggle('hidden', !selMode);
  renderSelCount();
  renderList();
}
function visibleListWords() {
  return Array.from($('list-results').querySelectorAll('.row[data-w]'), function (row) { return row.dataset.w; });
}
function selectAllVisible() {
  const words = visibleListWords();
  const allOn = words.length && words.every(function (w) { return selSet.has(w); });
  words.forEach(function (w) { if (allOn) selSet.delete(w); else selSet.add(w); });
  paintSel();
  renderSelCount();
}
function paintSel() {
  document.querySelectorAll('#list-results .row').forEach(function (r) {
    const on = selSet.has(r.dataset.w);
    r.classList.toggle('sel', on);
    const c = r.querySelector('.rowcheck');
    if (c) c.textContent = on ? '☑' : '☐';
  });
}
function renderSelCount() {
  const n = selSet.size;
  $('sel-count').textContent = selMode ? (n ? '已选 ' + n + ' 个' : '点词条勾选，或点「全选」') : '';
  const all = $('sel-all');
  if (all) all.textContent = '全选';
  const del = document.querySelector('#sel-acts button[data-act="del"]');
  if (del) { del.textContent = '🗑 删除'; del.classList.remove('armed'); }
}

function renderList() {
  const sets = listSets();
  const arr = sets[listTab] || [];
  const q = norm($('list-filter').value);
  let rows = arr.filter(function (e) { return !q || e.w.toLowerCase().indexOf(q) >= 0; });
  const total = rows.length;
  const showPractice = listTab === 'wrong' && total > 0 && !selMode;
  $('redrill').classList.toggle('hidden', !showPractice);
  const listen = $('wrong-listen');
  listen.classList.toggle('hidden', !showPractice);
  listen.textContent = '听写 ' + Math.min(20, total) + ' 个';
  if (listTab === 'wrong') {
    rows.sort(function (a, b) {   // 错得最多的排最前
      return ((S.progress[b.w] || {}).wrong || 0) - ((S.progress[a.w] || {}).wrong || 0);
    });
  }
  rows = rows.slice(0, 200);
  const res = $('list-results');
  res.classList.toggle('selmode', selMode);
  if (!total) {
    res.innerHTML = '<p class="muted center">' +
      (q ? '当前筛选没有匹配的词'
        : listTab === 'wrong' ? '错词本是空的，继续保持 👍'
        : listTab === 'mastered' ? '还没有标记为掌握的词。在「⋯」里点「已掌握」就不会再进复习'
        : (listTab === 'star' || listTab === 'star2') ? '还没有收藏单词。在学习卡片或单词详情里点 ⭐ 即可收藏'
        : '暂无单词') + '</p>';
    return;
  }
  res.innerHTML =
    '<p class="muted listcount">共 ' + total + ' 词' +
    (total > 200 ? '（仅显示前 200，可用筛选缩小范围）' : '') +
    (selMode ? ' · 点词条勾选' : ' · 点「⋯」可改状态 / 删除') + '</p>' +
    rows.map(rowHtml).join('');
  wireRows(res);
}

/* ---------- 单行操作（⋯ 下拉菜单）：改状态 / 改释义 / 删除 ---------- */
function closeRowMenu() {
  const m = document.getElementById('rowmenu');
  if (m) m.remove();
}
function openRowMenu(anchor, w) {
  closeRowMenu();
  const r = anchor.getBoundingClientRect();
  const m = document.createElement('div');
  m.id = 'rowmenu';
  m.className = 'rowmenu';
  const pk = parkState(w);
  m.innerHTML =
    '<div class="rmhead">' + esc(w) + '</div>' +
    '<button data-act="master"' + (pk === 'forever' ? ' class="on"' : '') + '>✅ 已掌握（不再复习）</button>' +
    (pk ? '<button data-act="resume">↩ 恢复复习</button>' : '') +
    '<button data-act="note">✎ 改释义 / 加备注</button>' +
    '<button data-act="del" class="danger">🗑 删除这个词</button>';
  document.body.appendChild(m);
  const mh = m.offsetHeight;
  const flip = r.bottom + 6 + mh > window.innerHeight && r.top > mh + 12;
  const top = (flip ? r.top - mh - 6 : r.bottom + 6) + window.scrollY;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 10));
  m.style.top = Math.max(8, top) + 'px';
  m.style.left = left + 'px';
  m.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      const act = b.dataset.act, d = +b.dataset.d || 0;
      closeRowMenu();
      if (act === 'note') {
        const e = DICT.get(w.toLowerCase());
        openDetail(w, true);
        return;
      }
      applyToWords([w], act, d);
    });
  });
  setTimeout(function () {
    document.addEventListener('click', function once(ev) {
      document.removeEventListener('click', once);
      if (!ev.target.closest('#rowmenu')) closeRowMenu();
    });
  }, 0);
}

/* ---------- 批量操作 ---------- */
function bulkAct(act, d, btn) {
  const words = Array.from(selSet);
  if (!words.length) { toast('先勾选几个词'); return; }
  if (act === 'drill') {
    // 勾一批词 → 直接开练：这一步是「单词本 → 学习队列」的联动
    const n = words.length;
    setSelMode(false);
    drillWith(words, '选中 ' + n + ' 个词', 'list');
    return;
  }
  if (act === 'del') {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = '再点一次确认删除 ' + words.length + ' 个';
      clearTimeout(delArm);
      delArm = setTimeout(function () { if (btn) { btn.classList.remove('armed'); btn.textContent = '🗑 删除'; } }, 4000);
      return;
    }
    clearTimeout(delArm);
  }
  applyToWords(words, act, d);
}

function applyToWords(words, act, d) {
  let msg = '';
  if (act === 'master') {
    parkWords(words);
    msg = '已掌握 ' + words.length + ' 个：不再进复习（可在「已掌握」里恢复）';
  } else if (act === 'resume') {
    unparkWords(words);
    msg = '已恢复复习 ' + words.length + ' 个';
  } else if (act === 'unstar') {
    words.forEach(function (w) { delete S.stars[w]; });
    save();
    msg = '已取消收藏 ' + words.length + ' 个';
  } else if (act === 'del') {
    deleteWords(words);
    msg = '已删除 ' + words.length + ' 个（回到未背，重新当新词学）';
  }
  selSet.clear();
  selMode = selMode && act !== 'del';
  setSelMode(selMode);
  renderListTabs();
  renderList();
  if (msg) toast(msg);
}

/* 我自己写的释义 / 备注：卡片和词条卡都挂一行 */
function noteLineHtml(w) {
  const t = S.notes[w];
  return t ? '<div class="mynote">📝 ' + esc(t) + '</div>' : '';
}

/* ================= 单词详情弹窗 ================= */
function synInlineHtml(syns) {
  if (!syns || !syns.length) return '';
  return '<div class="phinline"><span class="plabel">近义</span>' +
    esc(syns.slice(0, 4).join(' · ')) + '</div>';
}

/* 词条富卡片：查词精准命中内嵌展示 与 单词详情弹窗 共用（px 为按钮 id 前缀） */
/* ---------- 记忆曲线（详情页大图） ----------
 * 答错反馈里那张 40px 小图回答的是「今天不管它，N 天后还剩多少」；
 * 这张大图回答的是另一个问题：「这个词现在在曲线的哪一点」——
 * 横轴铺到下次复习之后再留一段余量，纵轴按这条曲线自己的落点取，所以坡度始终看得见。
 * 与 retrievability() 同源公式，图上的百分数 = 卡片上那个「记忆 x%」。 */
function memoryCurveHtml(p) {
  if (!p || p.stability == null || !p.last) return '';
  const st = Math.max(0.2, p.stability);
  const curve = function (t) { return Math.pow(1 + 19 / 81 * Math.max(0, t) / st, -0.5); };
  const elapsed = Math.max(0, (Date.now() - p.last) / DAY);
  const overdue = p.due != null && p.due <= Date.now();
  const dueIn = p.due ? Math.max(0, (p.due - Date.now()) / DAY) : 0;
  const span = Math.max(10, Math.min(365, Math.ceil(elapsed + Math.max(dueIn, 1) + Math.max(4, st * 1.4))));
  const W = 320, H = 92, L = 32, RT = 10, T = 10, B = 18;
  /* 纵轴不用 0~100%：高稳定性的词整条线本来就平，铺满 0~100% 会变成一条直线看不出东西。
     改成按「这条曲线自己会掉到哪里」取下限，坡度始终看得见，刻度也跟着变。 */
  const rEnd = curve(span);
  const LO = Math.max(0.1, Math.min(0.9, Math.min(rEnd, curve(elapsed)) - 0.04));
  const X = function (t) { return L + Math.max(0, Math.min(span, t)) / span * (W - L - RT); };
  const Y = function (r) {
    const k = Math.max(0, Math.min(1, (r - LO) / (1 - LO)));
    return T + (1 - k) * (H - T - B);
  };
  let d = '';
  for (let i = 0; i <= 80; i++) {
    const t = span * i / 80;
    d += (i ? 'L' : 'M') + X(t).toFixed(1) + ',' + Y(curve(t)).toFixed(1);
  }
  const nx = X(elapsed), ny = Y(curve(elapsed));
  const dx = X(elapsed + dueIn);
  const nowR = Math.round(curve(elapsed) * 100);
  const dueR = Math.round(curve(elapsed + dueIn) * 100);
  const showDueLine = !overdue && dueIn >= 0.4;
  const showDueLabel = showDueLine && dx - nx > 44;
  const dueLabel = p.due ? fmtDue(p.due).split('（')[0] : '';
  const midR = (1 + LO) / 2;
  return '<div class="mcurve">' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="记忆保持率曲线">' +
    '<line class="mc-axis" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - RT) + '" y2="' + (H - B) + '"></line>' +
    '<line class="mc-grid" x1="' + L + '" y1="' + Y(midR).toFixed(1) + '" x2="' + (W - RT) + '" y2="' + Y(midR).toFixed(1) + '"></line>' +
    '<path class="mc-line" d="' + d + '"></path>' +
    (showDueLine
      ? '<line class="mc-due" x1="' + dx.toFixed(1) + '" y1="' + T + '" x2="' + dx.toFixed(1) + '" y2="' + (H - B) + '"></line>'
      : '') +
    '<line class="mc-now" x1="' + nx.toFixed(1) + '" y1="' + T + '" x2="' + nx.toFixed(1) + '" y2="' + (H - B) + '"></line>' +
    '<circle class="mc-dot" cx="' + nx.toFixed(1) + '" cy="' + ny.toFixed(1) + '" r="3.4"></circle>' +
    '<text class="mc-t" x="' + (L - 4) + '" y="' + (Y(1) + 8).toFixed(1) + '" text-anchor="end">100%</text>' +
    '<text class="mc-t" x="' + (L - 4) + '" y="' + (Y(LO) + 3).toFixed(1) + '" text-anchor="end">' +
    Math.round(LO * 100) + '%</text>' +
    '<text class="mc-t" x="' + nx.toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle">今天</text>' +
    (showDueLabel
      ? '<text class="mc-t" x="' + dx.toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle">' + esc(dueLabel) + '</text>'
      : '') +
    '</svg>' +
    '<div class="mc-cap">现在约剩 <b>' + nowR + '%</b> · ' +
    (overdue ? '<span class="mc-warn">已经到期，今天就该复习</span>'
      : '下次复习（' + esc(dueLabel) + '）那天约 <b>' + dueR + '%</b>') +
    ' · 稳定性 <b>' + (Math.round(st * 10) / 10) + '</b> 天 · 难度 <b>' +
    (Math.round((p.difficulty || 5) * 10) / 10) + '</b></div>' +
    '<p class="mc-note">稳定性 = 记忆能撑多久；难度 = 这个词对你有多难。曲线越陡说明忘得越快，' +
    '答对一次会把曲线整体抬平（复习间隔因此变长）。</p>' +
    '</div>';
}

/* 词条卡的「例句」区：真题优先。
 * 为什么真题排第一：这是「这个词 2023-06 那张卷子真的考过」的证据，比任何词典例句都好记。
 * v6.9.2 起每条真题自带中文（Bing 机翻，data_raw/sent_zh.json 离线生成），字段顺序统一成
 * [英文, 中文, 出处]，交给 sentHtml 排成「英文 ——出处 / 中文」两行。
 * 真题不足 2 条时，用字典例句补足 —— 字典例句没有出处，就是「英文 / 中文」两行。 */
function paperRows(word) {
  const rows = kyUsable(word) && PAPER && PAPER[word.toLowerCase()];
  return Array.isArray(rows) ? rows : [];
}
function paperExample(row) {
  const ref = window.VD_PAPER_SOURCES && window.VD_PAPER_SOURCES[row[3]];
  return [row[0], row[2] || '', ref ? ref[0] : row[1], ref ? ref[1] : '', true];
}
function examBlockHtml(e) {
  const examples = paperRows(e.w).map(paperExample);
  const block = function (label, rows) {
    if (!rows.length) return '';
    return '<h3 class="rsub">' + label + '</h3><div class="exlist">' +
      rows.map(function (s) { return sentHtml(s, e.w, true); }).join('') + '</div>';
  };
  return block('真题例句', examples.filter(function (s) { return s[3]; })) +
    block('语料例句', examples.filter(function (s) { return !s[3]; })) +
    (e.lex && e.sents ? block('例句', e.sents.slice(0, Math.max(0, 2 - examples.length))) : '');
}

/* 学习卡（教学卡 / 答后反馈 / 拼写答案）用的一行真题：取最短的一条原文，后面跟完整出处，下一行是中文。
 * 为什么不在学习卡里也摆「真题例句」块：卡片高度已经被一屏装下卡死，多一块就会被 fitFeedback 摘掉。
 * 这里只留一条、出处接在句尾同一行内，占高约 2~3 行；真挤不下时 fitFeedback 会整块摘掉（它在 drop 末位）。 */
/* paper.js 3.9MB，不挡首屏：学习卡先渲染，真题层到了再把那一行补进去。
 * 用 cardSeq 守住「回调到达时卡片已经翻走了」的情况，别把上一个词的真题塞到新卡上。 */
function kyPaintSoon() {
  if (PAPER) return;
  const seq = cardSeq;
  ensurePaper().then(function () {
    requestAnimationFrame(function () { if (seq === cardSeq) kyPaint(); });
  });
}
function kyPaint() {
  const w = current && current[0];
  const card = $('card');
  if (!w || !card || !card.querySelector('.meaning')) return;
  const box = card.querySelector('.meaning');
  if (box.querySelector('.kyline')) return;
  const html = kyLineHtml(w);
  if (!html) return;
  const meta = box.querySelector('.meta-row');
  if (meta) meta.insertAdjacentHTML('beforebegin', html);
  else box.insertAdjacentHTML('beforeend', html);
  fitFeedback(card);          // 补完可能变高，让兜底规则再量一次
}

/* 功能词不配真题例句：给 a / the / of 配一句随机真题，读者只会觉得吵。
 * 判据是「短 + 高频虚词表」，不是词性（这里没有词性数据）。 */
const KY_SKIP = new Set(('a an the of to in on at by for and or but if as is are was were be been it its ' +
  'this that these those we you he she they i me my our your their his her them us not no do does did ' +
  'can could will would shall should may might must have has had with from up out off over into than ' +
  'then too very just also all any some more most much many such only one two').split(' '));
function kyUsable(w) {
  const k = String(w || '').toLowerCase();
  return k.length > 2 && !KY_SKIP.has(k);
}

function kyLineHtml(w) {
  const pp = paperRows(w);
  if (!pp.length) return '';
  let best = pp[0];
  for (let i = 1; i < pp.length; i++) {
    if (pp[i][0].length < best[0].length) best = pp[i];
  }
  const example = paperExample(best);
  return '<div class="kyline">' +
    '<span class="kylbl">' + (example[3] ? '真题' : '语料') + '</span>' +
    '<span class="kytxt" lang="en">' + exampleEnglishHtml(example[0], w) + '</span>' +
    sentenceSourceHtml(example, 'kysrc') +
    (example[1] ? '<span class="kyzh"><small>机翻</small> ' + esc(example[1]) + '</span>' : '') +
    '</div>';
}

function richCardHtml(e, px) {
  const p = S.progress[e.w];
  const st = S.stars[e.w] || 0;
  const pk = parkState(e.w);
  const note = S.notes[e.w] || '';
  const english = enBlockHtml(entryOf(e.w), 2);
  const wordForms = rootHtml(e.w) + familyHtml(e.w);
  const jumpExamples = paperRows(e.w).length
    ? '<button class="chip" data-entry-jump="entry-examples">看语境例句 ↓</button>' : '';
  const jumpPhrases = e.phrases.length
    ? '<button class="chip" data-entry-jump="entry-phrases">看搭配 ↓</button>' : '';
  const stTxt = e.lex ? '词典词 · 不在背诵范围'
    : pk === 'forever' ? '已掌握（手动）'
      : !p ? '未学' : (p.lv >= 3 ? '已掌握 · Lv' + p.lv : '学习中 · Lv' + p.lv);
  return '<div class="richcard">' +
    '<div class="word small">' + esc(e.w) +
    ' <button id="' + px + '-speak" class="icon" title="发音">🔊</button></div>' +
    phonHtml(e, px) +
    '<div class="tags">' +
    (e.freq ? '<span class="chip tag freq" title="ECDICT 柯林斯词频 4–5 星">高频词</span>' : '') +
    e.books.map(function (b) { return '<span class="chip tag">' + esc(BOOKS[b].name) + '</span>'; }).join('') +
    '<span class="chip tag st">' + stTxt + '</span>' +
    (p && p.wrong > 0 ? '<span class="chip tag err">错过 ' + p.wrong + ' 次</span>' : '') +
    '</div>' +
    (jumpExamples || jumpPhrases ? '<div class="chips entry-jump">' + jumpExamples + jumpPhrases + '</div>' : '') +
    noteLineHtml(e.w) +
    /* 词书里的词：一义一例（例句是 sent_pick 按词性对齐过的），塞在释义里最省地方。
       字典词（v6.7 补了 exam 层）：那批例句是按词抓的，没有「这条属于哪个义项」的信息，
       硬按顺序塞进去会出现「名词释义配动词例句」，所以释义单独渲染，例句另起一块。 */
    '<div class="meaning">' + defsHtml(e.defs, e.lex ? null : e.sents, 0, e.w) + '</div>' +
    (english ? '<details class="entry-extra"><summary>英文释义 · ECDICT</summary>' + english + '</details>' : '') +
    '<div class="entry-examples">' + examBlockHtml(e) + '</div>' +
    (e.phrases.length
      ? '<div class="entry-phrases"><h3 class="rsub">常用搭配</h3><ul class="phr">' +
        e.phrases.map(function (ph) { return '<li><b>' + esc(ph[0]) + '</b>' + esc(ph[1]) + '</li>'; }).join('') +
        '</ul></div>'
      : '') +
    (e.syns && e.syns.length
      ? '<h3 class="rsub">近义词（点击查看）</h3><div class="chips syns">' +
        e.syns.map(function (s) { return '<button class="chip synchip" data-w="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') +
        '</div>'
      : '') +
    (wordForms ? '<details class="entry-extra"><summary>拼写拆分与形近词</summary>' +
      '<p class="s-hint">根据拼写自动匹配，供助记参考。</p>' + wordForms + '</details>' : '') +
    (function () {
      const nb = confuseNeighbors(e.w);
      if (!nb.length) return '';
      return '<h3 class="rsub">易混词（你混过）</h3>' +
        '<p class="s-hint" style="margin:0 0 8px">这些是你在这个词上选错过的对手。点开对照着记，比单看释义有效。</p>' +
        '<div class="chips confs">' +
        nb.slice(0, 6).map(function (x) {
          const c = ((S.confuse[e.w] || {})[x] || 0) + ((S.confuse[x] || {})[e.w] || 0);
          return '<button class="chip cfchip" data-w="' + esc(x) + '">' + esc(x) +
            '<i class="wm">' + c + '</i></button>';
        }).join('') + '</div>';
    })() +
    memoryCurveHtml(p) +
    /* ---- 分割线以下才是操作区：查词时人是来看「这词什么意思」的，
       收藏 / 已掌握 / 删除排在最前面会把释义挤到屏幕外。 ---- */
    '<div class="cardsep"></div>' +
    '<div class="actions">' +
    '<button id="' + px + '-star1" class="big' + (st === 1 ? ' primary' : '') + '">⭐ 收藏</button>' +
    '<button id="' + px + '-star2" class="big' + (st === 2 ? ' primary' : '') + '">⭐⭐ 重点</button>' +
    '</div>' +
    /* 通用字典里的词不在任何词书里，没有队列可退：已掌握 / 删除写了也是脏数据，
       所以整排只对词书内的词显示。收藏仍然保留 —— 看到好词想记一下是正常需求。 */
    (e.lex ? '' : '<div class="actions parkrow">' +
      '<button id="' + px + '-master" class="big' + (pk === 'forever' ? ' primary' : '') + '">✅ 已掌握</button>' +
      (pk ? '<button id="' + px + '-resume" class="big">恢复复习</button>' : '') +
      '<button id="' + px + '-del" class="big danger">删除</button>' +
      '</div>') +
    (e.lex ? '<p class="s-hint lexnote">这个词来自通用字典，只作查阅 —— 不在两本词书里，不进复习队列。</p>' : '') +
    '<div class="notebox">' +
    '<textarea id="' + px + '-note" class="notein" rows="2" placeholder="写一句自己记得住的理解（会盖在词典释义上面显示）">' + esc(note) + '</textarea>' +
    '<button id="' + px + '-notesave" class="big">保存我的释义</button>' +
    '</div>' +
    '</div>';
}
function wireRichCard(root, e, px, refresh) {
  wireFamily(root);
  root.querySelectorAll('[data-entry-jump]').forEach(function (button) {
    button.addEventListener('click', function () {
      const target = root.querySelector('.' + button.dataset.entryJump);
      if (target) target.scrollIntoView({ block: 'start' });
    });
  });
  const examples = root.querySelector('.entry-examples');
  if (examples && !PAPER) ensurePaper().then(function () {
    if (PAPER && examples.isConnected) examples.innerHTML = examBlockHtml(e);
  });
  const sp = root.querySelector('#' + px + '-speak');
  if (sp) sp.addEventListener('click', function () { speak(e.w); });
  const su = root.querySelector('#' + px + '-s-us');
  if (su) su.addEventListener('click', function () { speak(e.w, 'en-US'); });
  const sku = root.querySelector('#' + px + '-s-uk');
  if (sku) sku.addEventListener('click', function () { speak(e.w, 'en-GB'); });
  root.querySelectorAll('.synchip').forEach(function (b) {
    const sw = b.dataset.w;
    /* 以前只认词书：`DICT.has()` 不通过就置灰 + 点了弹「词库中未收录」。
       现在有 9.8 万词的通用字典，近义词大多能在里面查到 ——
       所以只在「字典已经加载、且字典里也确实没有」时才置灰，点击一律交给 openDetail
       （它自己会等字典加载，查不到才 toast）。字典还在加载时不下结论。 */
    if (!DICT.has(sw.toLowerCase()) && LEX_WORDS && !lexHas(sw)) b.classList.add('dim');
    b.addEventListener('click', function () { openDetail(sw); });
  });
  /* 易混词：跳到对方的详情 —— 多级联动，一次点击就能来回对照 */
  root.querySelectorAll('.cfchip').forEach(function (b) {
    b.addEventListener('click', function () { openDetail(b.dataset.w); });
  });
  const s1 = root.querySelector('#' + px + '-star1');
  if (s1) s1.addEventListener('click', function () { setStar(e.w, 1); refresh(); });
  const s2 = root.querySelector('#' + px + '-star2');
  if (s2) s2.addEventListener('click', function () { setStar(e.w, 2); refresh(); });

  /* 已掌握 / 恢复 / 删除 */
  const mk = root.querySelector('#' + px + '-master');
  if (mk) mk.addEventListener('click', function () { applyToWords([e.w], 'master'); refresh(); });
  const rs = root.querySelector('#' + px + '-resume');
  if (rs) rs.addEventListener('click', function () { applyToWords([e.w], 'resume'); refresh(); });
  const dl = root.querySelector('#' + px + '-del');
  if (dl) dl.addEventListener('click', function () {
    if (!dl.classList.contains('armed')) {
      dl.classList.add('armed');
      dl.textContent = '再点一次确认删除';
      setTimeout(function () { dl.classList.remove('armed'); dl.textContent = '删除'; }, 4000);
      return;
    }
    deleteWords([e.w]);
    closeModal();
    toast('已删除「' + e.w + '」，回到未背');
    refresh();
  });

  /* 我的释义 / 备注 */
  const nt = root.querySelector('#' + px + '-note');
  const ns = root.querySelector('#' + px + '-notesave');
  if (ns) ns.addEventListener('click', function () {
    const t = (nt.value || '').trim();
    if (t) S.notes[e.w] = t; else delete S.notes[e.w];
    save();
    toast(t ? '已保存我的释义' : '已清空我的释义');
    refresh();
  });
}

async function openDetail(w, focusNote) {
  if (!ALL_LOADED) await ensureAllBooks();
  let e = DICT.get(w.toLowerCase());
  if (!e) {
    /* 词书里没有就翻通用字典 —— 查到就能看，只是不参与背诵 */
    if (!LEX) { try { await ensureDict(); } catch (err) { /* 没网就算了 */ } }
    e = lexEntry(String(w || '').toLowerCase());
    if (!e) { toast('未收录该单词'); return; }
  }
  // 记录查词历史（最近 12 个，去重）
  S.shist = [e.w].concat(S.shist.filter(function (x) { return x !== e.w; })).slice(0, 12);
  save();
  $('modal-body').innerHTML = richCardHtml(e, 'dt');
  wireRichCard($('modal-body'), e, 'dt', function () { openDetail(e.w); });
  $('modal').classList.remove('hidden');
  $('modal-body').scrollTop = 0;
  if (focusNote) {
    const nt = document.getElementById('dt-note');
    if (nt) { nt.scrollIntoView({ block: 'center' }); nt.focus(); }
  } else $('modal-x').focus({ preventScroll: true });
}

/* ================= 统计弹窗 ================= */
function openStats() {
  const cur = VD_DATA[S.settings.book] ? VD_DATA[S.settings.book].words : WORDS;
  let total = 0, learned = 0, learning = 0;
  const struggling = [];
  for (const it of cur) {
    total++;
    const p = S.progress[it[0]];
    if (!p) continue;
    if (p.lv >= 3) learned++;
    else { learning++; if (p.lv === 0) struggling.push(it[0]); }
  }
  const totalAll = Object.keys(S.progress).length;
  let sum = 0;
  for (const k in S.days) sum += S.days[k].n + S.days[k].r;

  // 熟练度分布（本书）
  const lvCount = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const it of cur) {
    const p = S.progress[it[0]];
    if (p) lvCount[Math.min(p.lv, 7)]++;
  }
  const maxLv = Math.max.apply(null, lvCount.concat([1]));
  const distHtml = '<div class="trend lvdist">' + lvCount.map(function (c, i) {
    return '<div class="tcol lvb" data-lv="' + i + '" title="Lv' + i + ' · ' + c + ' 词 · 点击看这批词并能直接开练">' +
      '<i style="height:' + Math.max(2, Math.round(c / maxLv * 40)) + 'px"></i>' +
      '<span>L' + i + '</span></div>';
  }).join('') + '</div>';

  /* 易混词对：所有答错时「选成了谁」的汇总。这是本应用最独有的一份数据 ——
     普通的错词本只知道错了，这里知道「错在哪」，能直接生成辨析练习。 */
  const pairs = confusePairs().slice(0, 8);
  const cfWords = confuseWords(60);
  const pairHtml = pairs.length
    ? '<div class="pairlist">' + pairs.map(function (p) {
      const da = (entryOf(p.a)[1] || [])[0] || '';
      const db = (entryOf(p.b)[1] || [])[0] || '';
      return '<div class="pair">' +
        '<div class="pair-w"><button class="pw" data-w="' + esc(p.a) + '">' + esc(p.a) + '</button>' +
        '<span class="pd">' + esc(da) + '</span></div>' +
        '<span class="pair-vs">↔</span>' +
        '<div class="pair-w"><button class="pw" data-w="' + esc(p.b) + '">' + esc(p.b) + '</button>' +
        '<span class="pd">' + esc(db) + '</span></div>' +
        '<i class="pair-n" title="混过 ' + p.n + ' 次">' + p.n + '</i>' +
        '</div>';
    }).join('') + '</div>'
    : '';

  const chips = struggling.slice(0, 300).map(function (w) {
    return '<button class="chip stw" data-w="' + esc(w) + '">' + esc(w) + '</button>';
  }).join('');

  let pkForever = 0;
  for (const w in S.pause) if (parkState(w) === 'forever') pkForever++;
  const dRec = dayRec();
  const bk = forecastBuckets();
  const maxB = Math.max.apply(null, bk.concat([1]));
  /* 记忆健康度 = 已学词当前「还记得的概率」平均值（FSRS 留存率）。
     它比「背了多少词」更能说明问题：堆了一堆快忘的词，看着进度高、其实要重来。 */
  let retSum = 0, retN = 0;
  for (const it of cur) {
    const p = S.progress[it[0]];
    if (!p || p.due == null) continue;
    const r = retrievability(p);
    if (r != null) { retSum += r; retN++; }
  }
  const health = retN ? Math.round(retSum / retN) : null;
  const healthTxt = health == null ? ''
    : health >= 85 ? '很稳' : health >= 70 ? '还行' : health >= 55 ? '偏松' : '告急';
  const healthCls = health == null ? '' : health >= 85 ? 'g-ok' : health >= 70 ? 'g-mid' : 'g-low';

  const leeches = leechWords();
  const rtModes = usableModes();
  const rtTxt = rtModes.map(function (m) {
    const a = (S.rt || {})[m] || [];
    if (a.length < 3) return '';
    return MODE_LABEL[m] + ' ' + (a.length >= 12 ? '' : '≈') + (median(a) / 1000).toFixed(1) + 's';
  }).filter(Boolean).join(' · ');

  $('modal-body').innerHTML =
    '<h2>📊 学习统计</h2>' +
    '<div class="stat-grid">' +
    '<div class="stat-cell"><b>' + streakDays() + '</b><span>连续打卡（天）</span></div>' +
    '<div class="stat-cell"><b>' + totalAll + '</b><span>累计学过（词）</span></div>' +
    '<div class="stat-cell"><b>' + sum + '</b><span>累计刷卡（次）</span></div>' +
    '</div>' +
    '<h3>记忆健康度</h3>' +
    '<div class="panel health ' + healthCls + '">' +
    '<div class="hrow"><b class="hbig">' + (health == null ? '—' : health + '%') + '</b>' +
    '<span class="hdesc">' + (health == null ? '还没有可评估的词' : healthTxt + ' · 已学 ' + retN + ' 词的当前平均留存率') + '</span></div>' +
    '<div class="bar"><div class="bar-in" style="width:' + (health || 0) + '%"></div></div>' +
    '<p class="s-hint">低于 85% 说明到期词堆着了：先把「复习」清掉再学新词，比一路往前刷更划算。' +
    (rtTxt ? '你的反应节奏：' + rtTxt + '（「磨蹭」阈值会跟着你自己的速度调）' : '') + '</p>' +
    '</div>' +
    skillProfileHtml() +
    '<h3>顽固词攻坚 · ' + leeches.length + ' 个</h3>' +
    '<div class="panel">' +
    (leeches.length
      ? '<p class="s-hint" style="margin:6px 0 10px">错过 ≥' + LEECH_AT + ' 次的词，光多刷几遍通常没用 —— ' +
        '换成「同根词 + 例句」重新建线索，再单独过一遍。</p>' +
        '<div class="actions" style="justify-content:flex-start;margin-bottom:8px">' +
        '<button id="st-leech" class="big primary">开始攻坚 ' + leeches.length + ' 个</button></div>' +
        '<div class="chips">' + leeches.slice(0, 30).map(function (w) {
          return '<button class="chip stw" data-w="' + esc(w) + '">' + esc(w) +
            ' <i class="wm">' + ((S.progress[w] || {}).wrong || 0) + '</i></button>';
        }).join('') + '</div>'
      : '<p class="s-hint" style="margin:6px 0">还没有顽固词（同一个词错过 ' + LEECH_AT + ' 次才会进这里）。继续保持 👍</p>') +
    '</div>' +
    '<h3>易混词对 · ' + pairs.length + ' 组</h3>' +
    '<div class="panel">' +
    (pairs.length
      ? '<p class="s-hint" style="margin:6px 0 10px">你答错时「把 A 的意思当成了 B」的聚合。' +
        '这种错光重复刷没用 —— 必须让两个词同场出现。点「辨析练习」后，这两词会互相进对方的选项。</p>' +
        '<div class="actions" style="justify-content:flex-start;margin-bottom:10px">' +
        '<button id="st-confuse" class="big primary">辨析练习 ' + cfWords.length + ' 个词</button></div>' +
        pairHtml
      : '<p class="s-hint" style="margin:6px 0">还没有可分析的混淆记录。答错选择题后，系统会自动记住你把哪个词的意思记串了。</p>') +
    '</div>' +
    '<h3>复习节奏是怎么算的</h3>' +
    '<div class="panel howto">' +
    '<p>每个词都记着一个「下次复习」的日期。答对 → 间隔按记忆强度往后拉（常见 3 天 → 7 天 → 14 天 → 1 个月…）；' +
    '答错或按「还不熟」→ 明天再来一次。到期那天它会自动出现在封面的「复习」里，所以你只要每天看封面就行。</p>' +
    '<p>「已掌握」＝ 手动把它从所有队列里永久拿掉，不再出现在新词和复习里。' +
    '在单词本的「⋯」里，也可以多选后批量设。当前已手动标为已掌握 <b>' + pkForever + '</b> 个。</p>' +
    '</div>' +
    '<h3>熟练度分布（本书）</h3>' + distHtml +
    '<h3>近 13 周活跃度</h3>' + heatmapHtml() +
    '<h3>本书进度（' + esc(BOOKS[S.settings.book].name) + ' · 共 ' + total + ' 词）</h3>' +
    '<div class="bar"><div class="bar-in" style="width:' + (total ? Math.round(learned / total * 100) : 0) + '%"></div></div>' +
    '<p class="muted">已掌握 ' + learned + ' · 学习中 ' + learning + ' · 未学 ' + (total - learned - learning) + '</p>' +
    '<h3>生词本（等级 0，' + struggling.length + ' 词）</h3>' +
    (chips ? '<div class="chips">' + chips + '</div>' : '<p class="muted">空空如也，继续保持 👍</p>');

  $('modal-body').querySelectorAll('.stw').forEach(function (b) {
    b.addEventListener('click', function () { speak(b.dataset.w); });
  });
  const sl = $('st-leech');
  if (sl) sl.addEventListener('click', function () { startLeechDrill(); });
  // 技能画像：一键按「每词推荐模式」开练；点单个词条看词条
  const sw = $('st-weak');
  if (sw) sw.addEventListener('click', function () { startWeakDrill(); });
  $('modal-body').querySelectorAll('.sk-wrow').forEach(function (b) {
    b.addEventListener('click', function () { openDetail(b.dataset.w); });
  });
  const sc = $('st-confuse');
  if (sc) sc.addEventListener('click', function () {
    drillWith(confuseWords(60), '易混词辨析', 'confuse');
  });
  $('modal-body').querySelectorAll('.pw').forEach(function (b) {
    b.addEventListener('click', function () { openDetail(b.dataset.w); });
  });
  // 熟练度柱子 → 这一级的词表（第四层联动：图 → 明细 → 开练）
  $('modal-body').querySelectorAll('.lvb').forEach(function (b) {
    b.addEventListener('click', function () { openLvWords(+b.dataset.lv); });
  });
  $('modal-body').querySelectorAll('.fclick').forEach(function (b) {
    b.addEventListener('click', function () { openDayWords(+b.dataset.d); });
  });
  $('modal').classList.remove('hidden');
}

function trendHtml() {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const rec = S.days[todayStr(-i)];
    days.push(rec ? rec.n + rec.r : 0);
  }
  const max = Math.max.apply(null, days.concat([1]));
  return '<div class="trend">' + days.map(function (v, i) {
    const dOff = 13 - i;
    return '<div class="tcol" title="' + todayStr(-dOff) + ' · ' + v + ' 次">' +
      '<i style="height:' + Math.max(2, Math.round(v / max * 46)) + 'px"></i>' +
      '<span>' + (dOff === 0 ? '今' : (dOff % 3 === 0 ? dOff : '')) + '</span></div>';
  }).join('') + '</div>';
}

function heatmapHtml() {
  const cells = [];
  const start = new Date(Date.now() - 90 * DAY);
  const shift = (start.getDay() + 6) % 7;   // 对齐到周一
  start.setDate(start.getDate() - shift);
  const end = Date.now();
  for (let t = start.getTime(); t <= end; t += DAY) {
    const key = fmtDate(new Date(t));
    const rec = S.days[key];
    const v = rec ? rec.n + rec.r : 0;
    const cls = v === 0 ? '' : v < 10 ? 'h1' : v < 30 ? 'h2' : v < 60 ? 'h3' : 'h4';
    cells.push('<i class="' + cls + '" title="' + key + ' · ' + v + ' 次"></i>');
  }
  return '<div class="heat">' + cells.join('') + '</div>';
}

/* ================= 侧栏：待复习 / 每日进度 / 参数直填 ================= */
function pauseCounts() {
  let forever = 0;
  for (const k in S.pause) if (S.pause[k] === 0) forever++;
  return { forever: forever };
}
const sideViewport = window.matchMedia('(max-width: 1179px)');
function isNarrow() { return sideViewport.matches; }
function clampNum(v, min, max) {
  let n = Math.round(Number(v));
  if (!isFinite(n)) n = min;
  return Math.max(min, Math.min(max, n));
}
function numInput(id, val, min, max, step) {
  return '<input id="' + id + '" type="number" min="' + min + '" max="' + max +
    '" step="' + (step || 1) + '" value="' + val + '">';
}

/* 骨架只搭一次，之后只改数字（不然输入框会在打字时被重绘打断） */
function renderSide() {
  const el = $('side');
  if (!el || el.dataset.built === '1') return;
  el.dataset.built = '1';
  el.innerHTML =
    '<div class="s-head">' +
    '<div class="s-hbox">' +
    '<div class="s-date" id="s-date"></div>' +
    '<div class="s-book" id="s-book"></div>' +
    '</div>' +
    '<button id="s-close" class="s-x" title="收起边栏，把宽度还给单词卡">✕</button>' +
    '</div>' +

    '<div class="s-card">' +
    '<div class="s-title">待复习</div>' +
    '<div class="s-big"><b id="s-due">0</b><span>个到期</span></div>' +
    '<div class="s-sub" id="s-duesub"></div>' +
    '<div class="bar"><i id="s-rbar"></i></div>' +
    '<div class="s-sub" id="s-plan"></div>' +
    '</div>' +

    '<div class="s-card">' +
    '<div class="s-title">今日进度</div>' +
    '<div class="s-line"><span>复习</span><b id="s-rdone">0 / 0</b></div>' +
    '<div class="bar"><i id="s-rprog"></i></div>' +
    '<div class="s-line"><span>新词</span><b id="s-ndone">0 / 0</b></div>' +
    '<div class="bar"><i id="s-nprog"></i></div>' +
    '</div>' +

    '<div class="s-card">' +
    '<div class="s-title">词库状态 <i class="s-tip">点数字去单词本</i></div>' +
    '<div class="s-grid">' +
    '<button class="sg" data-list="unseen"><b id="s-unseen">0</b><span>本书未背</span></button>' +
    '<button class="sg" data-list="all"><b id="s-all">0</b><span>已背</span></button>' +
    '<button class="sg" data-list="wrong"><b id="s-wrongN">0</b><span>错词</span></button>' +
    '<button class="sg" data-list="mastered"><b id="s-park">0</b><span>已掌握</span></button>' +
    '<button class="sg" data-list="star"><b id="s-star">0</b><span>收藏</span></button>' +
    '</div>' +
    '<button class="s-leech hidden" id="s-leech">🧱 顽固词 <b id="s-leech-n">0</b> 个 · 点这里攻坚</button>' +
    '</div>' +

    '<div class="s-actions">' +
    '<button id="s-go" class="big primary">开始复习</button>' +
    '</div>';

  /* 宽屏是「收起成把手」，窄屏是「关掉抽屉」—— 两个 × 本来做的是同一件事，合成一个按钮 */
  $('s-close').addEventListener('click', function () {
    if (isNarrow()) { toggleSide(false); return; }
    setSideCollapsed(true);
    toast('边栏收起 · 点屏幕右侧的「‹ 进度」再打开');
  });
  $('s-go').addEventListener('click', function (e) {
    if (e.detail) e.currentTarget.blur();
    if (isNarrow()) toggleSide(false);
    show('study');
    if (!current || $('study-main').classList.contains('hidden')) startSession();
  });
  /* 多级联动：边栏的每个数字都能点进去看那批词，而不是只当装饰 */
  el.querySelectorAll('.sg').forEach(function (b) {
    b.addEventListener('click', function () {
      if (isNarrow()) toggleSide(false);
      gotoList(b.dataset.list);
    });
  });
  const sle = $('s-leech');
  if (sle) sle.addEventListener('click', function () {
    if (isNarrow()) toggleSide(false);
    startLeechDrill();
  });
  const sdue = $('s-due');
  if (sdue) sdue.addEventListener('click', function () { openDayWords(0); });
}

function refreshSide() {
  const el = $('side');
  if (!el || el.dataset.built !== '1') return;
  if (!el.offsetParent) return;          // 窄屏收起时不白算
  const rp = reviewPlan();
  const d = dayRec();
  const bk = forecastBuckets();
  const maxB = Math.max.apply(null, bk.concat([1]));
  const pc = pauseCounts();
  const now = new Date();
  const setT = function (id, txt) { const n = $(id); if (n) n.textContent = txt; };
  const setW = function (id, pct) { const n = $(id); if (n) n.style.width = Math.max(0, Math.min(100, pct)) + '%'; };

  setT('s-date', (now.getMonth() + 1) + '月' + now.getDate() + '日 · 周' + '日一二三四五六'[now.getDay()]);
  setT('s-book', BOOKS[S.settings.book].name + ' · ' + posLabel());

  // 待复习 = 今天真实的到期总量；今天练多少受「复习范围 + 复习量」两个参数决定
  const doneR = d.r;
  const targetR = doneR + rp.list.length;         // 今日复习总目标（已做 + 待做）
  setT('s-due', rp.dueTotal);
  $('s-duesub').innerHTML = '错词 <b>' + rp.wrongCount + '</b> · 顺带过 <b>' + (rp.dueTotal - rp.wrongCount) + '</b>';
  setW('s-rbar', rp.dueTotal ? Math.round(rp.list.length / rp.dueTotal * 100) : 0);
  let plan;
  if (!rp.pool) {
    plan = rp.dueTotal
      ? '今天的到期词都不是错词，切「到期都练」才会练'
      : '今天没有到期词';
  } else if (rp.rest) {
    plan = '本轮练 <b>' + rp.list.length + '</b> 个，另有 ' + rp.rest + ' 个待复习';
  } else {
    plan = '今天清 <b>' + rp.list.length + '</b> 个 · 约 ' + Math.max(1, Math.round(rp.list.length * 8 / 60)) + ' 分钟';
  }
  $('s-plan').innerHTML = plan;

  setT('s-rdone', doneR + ' / ' + targetR);
  setW('s-rprog', targetR ? (targetR - rp.list.length) / targetR * 100 : 0);
  setT('s-ndone', Math.min(d.n, S.settings.newPerDay) + ' / ' + S.settings.newPerDay);
  setW('s-nprog', S.settings.newPerDay ? Math.min(d.n, S.settings.newPerDay) / S.settings.newPerDay * 100 : 0);

  let learnedN = 0, wrongN = 0;
  for (const it of WORDS) {
    const p = S.progress[it[0]];
    if (!p) continue;
    learnedN++;
    if ((p.wrong || 0) > 0) wrongN++;
  }
  const unseen = unseenCount();
  setT('s-unseen', unseen);
  setT('s-all', learnedN);
  setT('s-wrongN', wrongN);
  setT('s-park', pc.forever);
  setT('s-star', Object.keys(S.stars).length);
  const leechN = leechWords().length;
  setT('s-leech-n', leechN);
  const sle = $('s-leech');
  if (sle) sle.classList.toggle('hidden', !leechN);

  const go = $('s-go');
  if (go) {
    const active = !!current && !$('study-main').classList.contains('hidden');
    const left = Math.min(leftoverNew(), unseen);
    const lane = selectedStudyLane(rp);
    const resumed = pausedStudy(lane);
    go.disabled = !active && !resumed && (lane === 'review' ? !rp.list.length : !unseen);
    go.textContent = active ? '返回当前学习'
      : resumed ? (lane === 'review' ? '继续复习' : '继续学新词')
      : lane === 'review' ? (rp.list.length ? '复习 ' + rp.list.length + ' 个' : '暂无待复习')
      : left ? '学 ' + left + ' 个新词'
      : unseen ? '再学 ' + Math.min(10, unseen) + ' 个新词' : '今日任务已完成';
  }
}

/* 宽屏折叠：收起后右侧留一个「‹ 进度」把手，状态存本地 */
function applySideCollapsed() {
  document.body.classList.toggle('side-collapsed', !!S.settings.sideCollapsed);
}
function setSideCollapsed(v) {
  S.settings.sideCollapsed = !!v;
  save();
  applySideCollapsed();
  if (!v) { renderSide(); refreshSide(); }
}

function toggleSide(force) {
  const el = $('side'), sc = $('side-scrim');
  if (!el) return;
  const open = force == null ? !el.classList.contains('open') : !!force;
  el.classList.toggle('open', open);
  if (sc) sc.classList.toggle('open', open && isNarrow());
  if (open) { renderSide(); refreshSide(); }
}

/* ================= 设置弹窗 ================= */
function openWelcome(fromSettings) {
  if (!lsGet(WELCOME_KEY)) lsSet(WELCOME_KEY, 'seen');
  const body = $('modal-body');

  /* 首启导览 = 产品全貌，不是「这次更新了什么」。
     结构：主要功能（6 张卡）→ 还有这些（其余能力）→ 数据说明。
     「今日任务台」只讲背新词 / 复习旧词两条线，不列设置项；上手步骤不写在这里。
     新增功能时往对应分组补一条，别把这里改回更新日志。 */
  const main = [
    ['🏠 今日任务台', '背新词、复习旧词两条任务线各自独立，随时切换；切走再切回来，两边都接着上次的进度。'],
    ['🎯 四种练法', '识别（四选一，可先回忆再自评）· 拼写（写错逐字母对齐）· 语境（真题句挖空）· 听写（设置里开，给了提示最多记「模糊」）。<kbd>M</kbd> 随时切。'],
    ['📖 先认识，再考', '新词先出教学卡：大字 + 音标 + 一义一例 + 短语近义词，不计分。答对不自动跳，由你选「加入复习」或「还不熟」，反悔可以撤销。'],
    ['🧠 记忆与复习', 'FSRS-6 按作答自动排下次复习；错词本段内补测直到全对。答完给遗忘曲线和错因对照，可「↩ 上一个词」回滚评分，连击与结算一并还原。'],
    ['🔍 查词与真题', '两本词书之外还有 9.8 万词字典，查到的词不进背词队列。词条卡给真题例句（带年份出处）、词根词缀、短语近义词、易混词、记忆曲线，例句可整句朗读。'],
    ['🗂️ 单词本与统计', '已背 / 已掌握 / 未背 / 错词 / 收藏 / 重点六组，支持多选批量、改释义加备注。统计页有技能画像「词 × 模式」、易混词对与图表下钻，点数字就能直接开练。']
  ];
  const more = [
    ['词书与章节', 'CET-6、考研两本，可粘贴导入自己的词表；章节按 A–Z 分组，点哪章就只学哪章'],
    ['词根词缀', '答完自动拆开并逐段给中文，拼不回原词就不显示；查词时也能点开看'],
    ['已掌握 / 删除', '早会的词一键移出所有队列、不打分；删除只是清掉记录，等于回到未背'],
    ['易混辨析', '答错会记下「你把它当成了谁」，下次把这个对手塞进选项，还能一键专项同场练'],
    ['我的释义', '词条里写一句自己的理解，学习卡、单词本都会盖在词典释义上方'],
    ['收藏与历史', '☆ 两档收藏，查词历史保留最近 12 个词'],
    ['发音', '有道美音 / 英音，点 🔊 或例句右上角喇叭；需要联网。自动发音只在识别题生效'],
    ['界面', '浅色 / 深色 / 跟随系统，右侧进度边栏可收起，学习页一屏装下不出滚动条；<kbd>?</kbd> 随时看快捷键'],
    ['数据与同步', '进度存当前浏览器；用线上链接登录后可手机电脑同步，也可导出 / 导入备份'],
    ['随处可用', '一个 HTML 双击即用（单文件版），线上可装成桌面应用；离线照样查词背词']
  ];

  body.innerHTML =
    '<section id="welcome-panel" class="welcome-panel" aria-labelledby="welcome-title">' +
    '<div class="welcome-kicker">使用指南 · 完整功能</div>' +
    '<h2 id="welcome-title">欢迎使用唯单词</h2>' +
    '<p class="welcome-intro">练六级 / 考研词汇，也能查任意英文单词。用释义、搭配和真题例句理解，再交给记忆算法安排复习。全程键盘可刷，进度留在自己手里。</p>' +

    '<div class="welcome-sec">主要功能</div>' +
    '<div class="welcome-grid">' +
    main.map(function (c) {
      return '<article><h3>' + c[0] + '</h3><p>' + c[1] + '</p></article>';
    }).join('') +
    '</div>' +

    '<div class="welcome-sec">还有这些</div>' +
    '<div class="welcome-more">' +
    more.map(function (c) {
      return '<div><strong>' + c[0] + '</strong><span>' + c[1] + '</span></div>';
    }).join('') +
    '</div>' +

    '<p class="welcome-note">进度保存在当前浏览器；换设备用「设置 → 导出 / 导入备份」或在线登录同步。发音走有道在线音频，断网时读不出来，其余功能不受影响。</p>' +
    '<div class="actions">' +
    (fromSettings ? '<button id="welcome-back" class="big">返回设置</button>' : '') +
    '<button id="welcome-keys" class="big">全部快捷键</button>' +
    '<button id="welcome-done" class="big primary">开始使用</button>' +
    '</div></section>';
  $('modal').classList.remove('hidden');
  body.scrollTop = 0;
  $('welcome-done').addEventListener('click', closeModal);
  $('welcome-keys').addEventListener('click', function () { openKeys(); });
  $('modal-x').focus({ preventScroll: true });
  if (fromSettings) $('welcome-back').addEventListener('click', function () {
    openSettings();
    body.scrollTop = 0;
    $('set-welcome').focus({ preventScroll: true });
  });
}

function openSettings() {
  const s = S.settings;
  const sel = function (id, opts, cur, title) {
    return '<select id="' + id + '" class="set-select"' + (title ? ' title="' + title + '"' : '') + '>' +
      opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (String(cur) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
  };
  /* 数字行：右边一个可直填的框，下面一行灰字说明 */
  const nrow = function (id, label, val, min, max, step, unit, hint) {
    return '<div class="set-row"><label for="' + id + '">' + label + '</label>' +
      '<span class="set-num">' + numInput(id, val, min, max, step) + '<i>' + unit + '</i></span>' +
      (hint ? '<p class="s-hint">' + hint + '</p>' : '') + '</div>';
  };
  const srow = function (id, label, opts, cur, hint, title) {
    return '<div class="set-row"><label for="' + id + '">' + label + '</label>' +
      sel(id, opts, cur, title) + (hint ? '<p class="s-hint">' + hint + '</p>' : '') + '</div>';
  };
  /* 开关行。
   * 坑：原来外壳是 <span class="switch">，只有左侧文字（label[for]）能点，
   * 用户直接点那个滑块本体毫无反应 —— 这就是「自动发音开启不了」的原因。
   * 现在外壳用 <label> 包住 input，整个滑块都是可点区域，并补一个「开 / 关」文字。 */
  const swrow = function (id, label, on, hint) {
    return '<div class="set-row"><label for="' + id + '">' + label + '</label>' +
      '<label class="switch" title="点一下切换">' +
      '<input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '>' +
      '<span class="track"></span><em class="sw-txt"></em></label>' +
      (hint ? '<p class="s-hint">' + hint + '</p>' : '') + '</div>';
  };
  $('modal-body').innerHTML =
    '<h2>⚙️ 设置</h2>' +
    '<div class="panel-title">使用指南</div>' +
    '<div class="panel set-panel">' +
    swrow('set-welcome-auto', '每次启动显示导览', lsGet(WELCOME_KEY) === 'always') +
    '<div class="actions split"><button id="set-welcome" class="big">打开使用指南</button></div>' +
    '</div>' +
    '<div class="panel-title">每天的任务</div>' +
    '<div class="panel set-panel">' +
    srow('set-order', '背词顺序', [['seq', '顺序'], ['random', '乱序']], s.order || 'seq',
      '顺序：新词从 List 1 往下推，复习先练最早到期的。' +
      '乱序：新词从全书没学过的词里随机抽，复习顺序也打乱 —— ' +
      '不会靠「位置」和「前后邻居」记词，也更接近考场上的真实状态') +
    nrow('set-new', '每日新词', s.newPerDay, 0, 300, 5, '个', '填 0 时日常计划只排复习，仍可手动加学新词') +
    nrow('set-rvcap', '每轮复习量上限', s.reviewCap, 0, 999, 10, '个', '填 0 = 不限；优先练最早到期的词，一轮结束可继续复习') +
    nrow('set-batch', '新词教学节奏', s.introBatch, 0, 50, 1, '个一测', '先看 N 个教学卡再一起测；填 0 = 全学完再测') +
    swrow('set-listen', '听写模式', s.listenOn,
      '打开后顶栏多出「听写」：只放读音、不给音标，把单词拼出来。' +
      '它练的是「听得出」，比看释义拼写更难，所以默认关着 —— 想专攻听力再开') +
    srow('set-ret', '目标记忆率',
      [[0.8, '80%（宽松·省时）'], [0.85, '85%'], [0.9, '90%（推荐）'], [0.95, '95%（严格·最牢）']],
      Number(s.retention || 0.9), '越高间隔越短、复习越频繁，记得越牢') +
    '</div>' +
    '<button id="set-default" class="linkhint set-foot">恢复推荐值：新词 20 · 复习 40 · 教学 5 · 记忆率 90%</button>' +

    '<div class="panel-title">显示</div>' +
    '<div class="panel set-panel">' +
    srow('set-theme', '主题', [['auto', '跟随系统'], ['light', '浅色（暖纸）'], ['dark', '深色（柔夜）']], s.theme) +
    swrow('set-speak', '自动发音', s.autoSpeak,
      '识别题出现时自动读一遍。拼写 / 语境 / 听写题不读 —— 读出来就把答案说了') +
    /* v6.9.4：发音统一走有道在线音频，不再用浏览器/系统的语音合成。
       所以「音色」这个选项没意义了（那些是系统语音包），换成「美音 / 英音」二选一。 */
    srow('set-accent', '发音', [['us', '美音（有道）'], ['uk', '英音（有道）']], s.accent || 'us',
      '用的是有道词典的发音音频，需要联网；不再用浏览器合成的机器音') +
    '<div class="set-row"><label>发音自检</label>' +
    '<div class="vbtns">' +
    '<button id="set-testspeak" class="big" style="padding:7px 14px;font-size:13px">🔊 读一遍试试</button>' +
    '</div>' +
    '<p class="s-hint" id="set-speech-msg">' + esc(speechStatus().msg) + '</p></div>' +
    '</div>' +

    '<div class="panel-title">账号与同步</div>' +
    '<div class="panel set-panel" id="sync-panel">' + syncPanelHtml() + '</div>' +

    '<div class="panel-title">应用</div>' +
    '<div class="actions split">' +
    '<button id="set-install" class="big">安装到桌面</button>' +
    '<button id="set-update" class="big">检查更新</button>' +
    '</div>' +
    '<p class="s-hint">版本 v' + APP_VER +
    (location.protocol === 'file:' ? ' · 本地文件模式' : ' · 已支持离线使用') + '</p>' +
    '<div class="panel-title">数据</div>' +
    '<div class="actions split">' +
    '<button id="set-export" class="big">导出备份</button>' +
    '<button id="set-import" class="big">导入备份</button>' +
    '<button id="set-exportnl" class="big">导出生词本</button>' +
    '<button id="set-reset" class="big danger">清空本书进度</button>' +
    '</div>' +
    '<div class="panel-title">我的词库（粘贴一份自己的词表）</div>' +
    '<div class="actions split">' +
    '<button id="set-custom" class="big">📋 导入我的词表</button>' +
    (BOOKS.custom ? '<button id="set-custom-del" class="big danger">删除我的词库</button>' : '') +
    '</div>' +
    '<p class="muted" style="margin-top:6px;font-size:12px">一行一个词：<b>单词 + 空格/Tab/逗号 + 释义</b>。' +
    '导入后它会变成词书下拉里的「我的词库」，照样能用 FSRS、错词本和三种答题模式。' +
    (BOOKS.custom ? '当前已导入 ' + VD_DATA.custom.words.length + ' 词。' : '') + '</p>' +
    '<input type="file" id="set-file" accept="application/json" class="hidden">' +
    '<p class="muted" style="margin-top:12px;font-size:12px">进度保存在浏览器本地（localStorage），换电脑或换浏览器前请先导出备份。答错计入错词本，答对一次错词计数减一，清零后自动移出错词本。</p>';

  const onCard = function () { return !$('study-main').classList.contains('hidden'); };

  $('set-welcome').addEventListener('click', function () { openWelcome(true); });
  $('set-welcome-auto').addEventListener('change', function (e) {
    lsSet(WELCOME_KEY, e.target.checked ? 'always' : 'seen');
  });
  $('set-new').addEventListener('change', function (e) {
    const n = clampNum(e.target.value, 0, 300);
    e.target.value = n;
    S.settings.newPerDay = n; save();
    if (onCard()) renderCard(); else { updateTopbar(); renderHero(); }
    refreshSide();
  });
  $('set-batch').addEventListener('change', function (e) {
    const n = clampNum(e.target.value, 0, 50);
    e.target.value = n;
    S.settings.introBatch = n; save();
    toast(n ? '每学 ' + n + ' 个测一次' : '先学完再一起测');
  });
  const rvmodeEl = $('set-rvmode');
  if (rvmodeEl) rvmodeEl.addEventListener('change', function (e) {
    S.settings.reviewMode = e.target.value; save();
    if (!onCard()) renderHero();
    refreshSide();
    toast(e.target.value === 'wrong' ? '复习只练错词' : '复习所有到期词');
  });
  $('set-order').addEventListener('change', function (e) {
    S.settings.order = e.target.value === 'random' ? 'random' : 'seq';
    save();
    // 已经在卡片上就别打断这一张，换顺序从下一段生效
    if (!onCard()) renderHero();
    refreshSide();
    toast(S.settings.order === 'random'
      ? '乱序已开：新词全书随机抽，复习顺序也打乱'
      : '恢复顺序：新词按 List 推进，复习先练最早到期的');
  });
  $('set-rvcap').addEventListener('change', function (e) {
    const n = clampNum(e.target.value, 0, 999);
    e.target.value = n;
    S.settings.reviewCap = n; save();
    if (!onCard()) renderHero();
    refreshSide();
    toast(n ? '每轮最多复习 ' + n + ' 个' : '复习不限量');
  });
  $('set-listen').addEventListener('change', function (e) {
    const on = e.target.checked;
    S.settings.listenOn = on;
    if (!on && S.settings.mode === 'listen') S.settings.mode = 'spell';   // 关了就别停在听写卡上
    save();
    updateTopbar();
    toast(on ? '听写模式已开启：顶栏多了第四个按钮' : '听写模式已关闭');
    openSettings();    // 重绘一次，让「答题模式」下拉里的听写项跟着出现 / 消失
  });
  $('set-ret').addEventListener('change', function (e) {
    S.settings.retention = +e.target.value;
    _FSRS = null;          // 参数变了，重建调度器
    save();
    if (onCard()) renderCard(); else renderHero();
    toast('目标记忆率 ' + Math.round(S.settings.retention * 100) + '%：间隔已按新参数调整');
  });
  $('set-speak').addEventListener('change', function (e) {
    const on = e.target.checked;
    S.settings.autoSpeak = on;
    save();
    if (!on) { toast('自动发音关掉了'); return; }
    /* 打开的那一刻就读一个样例：用户立刻知道「到底有没有声」，
       而不是回到卡片上等一张识别卡出现才发现没动静 */
    speakSelfTest('自动发音已开');
  });
  const accentSel = $('set-accent');
  if (accentSel) accentSel.addEventListener('change', function (e) {
    S.settings.accent = e.target.value === 'uk' ? 'uk' : 'us';
    save();
    _voiceWarned = false;
    const el = $('set-speech-msg');
    if (el) el.textContent = '已切到' + (S.settings.accent === 'uk' ? '英音' : '美音') + ' —— 点「读一遍试试」确认能出声';
  });
  $('set-testspeak').addEventListener('click', function (e) {
    e.currentTarget.blur();
    speakSelfTest('发音自检');
  });
  $('set-theme').addEventListener('change', function (e) {
    S.settings.theme = e.target.value; save(); applyTheme();
  });
  $('set-default').addEventListener('click', function () {
    S.settings.newPerDay = 20;
    S.settings.reviewCap = 40;
    S.settings.introBatch = 5;
    S.settings.retention = 0.9;
    _FSRS = null;                       // 记忆率回来了，重建调度器
    save();
    closeModal();
    if (onCard()) renderCard(); else renderHero();
    refreshSide();
    toast('已恢复推荐值：新词 20 · 复习 40 · 教学 5 · 记忆率 90%');
  });
  $('set-export').addEventListener('click', exportData);
  $('set-install').addEventListener('click', installApp);

  /* ---- 账号与同步 ---- */
  const sySend = $('sync-send');
  if (sySend) {
    const go = function () {
      const el = $('sync-email');
      cloudSendCode(((el && el.value) || _draftEmail || '').trim());
    };
    sySend.addEventListener('click', go);
    const em = $('sync-email');
    if (em) em.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
  const syBack = $('sync-back');
  if (syBack) syBack.addEventListener('click', function () { _otp = null; _syncMsg = ''; openSettings(); });
  const syVerify = $('sync-verify');
  if (syVerify) {
    const go2 = function () { const el = $('sync-code'); cloudVerifyCode((el && el.value) || ''); };
    syVerify.addEventListener('click', go2);
    const cEl = $('sync-code');
    if (cEl) cEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go2(); } });
  }
  const syResend = $('sync-resend');
  if (syResend) syResend.addEventListener('click', function () { if (_otp) cloudSendCode(_otp.email); });
  const syNow = $('sync-now');
  if (syNow) syNow.addEventListener('click', cloudSyncNow);
  const syOut = $('sync-out');
  if (syOut) syOut.addEventListener('click', function () {
    if (!confirm('退出登录？退出后进度只留在这台设备，不再上传云端（云端那份不会删）。')) return;
    cloudSignOut();
  });
  $('set-update').addEventListener('click', function () {
    if (!confirm('检查更新会把浏览器缓存的旧版页面清掉，再重新下载最新版。\n学习进度存在本地存储里，不会丢。继续吗？')) return;
    updateCache();
  });
  $('set-exportnl').addEventListener('click', exportNotebook);
  $('set-custom').addEventListener('click', openCustomImport);
  const scd = $('set-custom-del');
  if (scd) scd.addEventListener('click', function () {
    if (!confirm('删除自定义词库？导入的词表会消失，其它词书的进度不受影响。')) return;
    removeCustomBook();
    closeModal();
    $('book').innerHTML = bookOptionsHtml();
    $('book').value = S.settings.book;
    prepareBook().then(function () { renderHero(); });
    toast('已删除自定义词库');
  });
  $('set-import').addEventListener('click', function () { $('set-file').click(); });
  $('set-file').addEventListener('change', function (e) {
    if (e.target.files[0]) importData(e.target.files[0]);
  });
  $('set-reset').addEventListener('click', function () {
    if (!confirm('确定清空《' + BOOKS[S.settings.book].name + '》这本书的学习进度吗？此操作不可撤销。')) return;
    for (const it of WORDS) delete S.progress[it[0]];
    save();
    closeModal();
    QUEUE = []; QI = 0; NEW = null; PHASE = 'review'; S.session = null;
    S.studyPaused = {};
    save();
    show('study');
    renderHero();
    toast('已清空本书进度');
  });
  $('modal').classList.remove('hidden');
}

/* 快捷键速查 */
function openKeys() {
  const rows = [
    ['1 – 4', '识别：选第 1~4 个释义'],
    ['回车', '识别：认识（自评）／ 拼写：提交答案'],
    ['Esc', '不认识，直接看答案'],
    ['空格', '答完翻到下一张（复习段用选项答对会自动翻）'],
    ['N', '学新词答对后：还不熟，明天再考（先不加入复习）'],
    ['Alt+S', '拼写 / 听写：再听一遍发音'],
    ['S', '识别：朗读当前单词'],
    ['A', '在当前卡片打开完整词条'],
    ['F', '收藏（再按设为重点，三次取消）'],
    ['K', '这个词早就会：标为已掌握，以后不再出现'],
    ['M', '在识别 / 拼写 / 语境（开了听写就多一档）之间切换'],
    ['Ctrl+Z', '上一个：回滚上一张的评分，可以重答'],
    ['Ctrl+Shift+Z', '下一个：恢复刚撤销的评分，直接往前走'],
    ['/', '跳到查词页'],
    ['?', '打开这个快捷键表'],
    ['Esc', '关闭弹窗 / 回到学习页'],
    ['空格 / 回车', '封面页：开始学习']
  ];
  $('modal-body').innerHTML =
    '<h2>⌨️ 快捷键</h2>' +
    '<p class="muted" style="font-size:12px;margin-bottom:10px">全程可以不开鼠标：1–4 答题，答完空格翻页，一路刷下去。' +
    '识别卡上一眼就会或完全不认识，也可以直接回车 / Esc 自评。</p>' +
    '<div class="kbd-grid">' + rows.map(function (r) {
      return '<div><kbd>' + esc(r[0]) + '</kbd><span>' + esc(r[1]) + '</span></div>';
    }).join('') + '</div>' +
    '<p class="muted" style="font-size:12px;margin-top:12px">评分只有三档，但不用你手动挑：答对或自评「认识」＝认识，' +
    '答得比你自己平时慢（阈值按你的反应时自动调，识别默认 6 秒、拼写 12 秒、语境 16 秒、听写 14 秒）＝模糊，答错或不认识＝不认识。</p>' +
    '<p class="muted" style="font-size:12px;margin-top:8px"><b>几种模式各练什么？</b>' +
    '识别＝看到词能想起意思（读得懂，最省力）；拼写＝给意思能写出词（写得出）；' +
    '语境＝给一句挖空的例句能把词填回去（用得上）；听写＝只听发音写出词（听得出，设置里打开）。' +
    '越往后越难，但换来的记忆更抗忘 —— ' +
    '考研/六级里真正丢分的是「认识但用不出来」，所以几种轮着练最划算。</p>' +
    '<p class="muted" style="font-size:12px;margin-top:8px"><b>复习间隔是怎么排的？</b>每个词都记着一个「下次复习」的日期，' +
    '由 FSRS 按你的表现算：学新词答对 → 默认 3 天后，答错或按「还不熟」→ 明天（1 天后）就再考一次；' +
    '复习时答对会把间隔越拉越长（7 天 → 14 天 → 一个月…），答错就缩回一天。' +
    '到期那天它会自动出现在封面的「复习」里，你不用记日子，每天看封面就行。</p>' +
    '<p class="muted" style="font-size:12px;margin-top:8px">「上一个 / 下一个」是评分回溯：往回退会把那张的进度、错词数、今日计数一起还原，' +
    '所以连着退几张也不会把统计搞乱。</p>';
  $('modal').classList.remove('hidden');
}

/* 备份文件 = 整个 S 的 JSON。
 * 缩进 2 空格方便用户用记事本瞄一眼（虽然主要还是给「导入备份」用的），
 * 结构保持平铺 —— importData 就是按 s.progress / s.settings 校验的，加外壳会读不回来。 */
function exportData() {
  try {
    const json = JSON.stringify(S, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '唯单词备份-' + todayStr() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    toast('备份已存到「下载」文件夹（' + Math.max(1, Math.round(json.length / 1024)) + ' KB）· 用「导入备份」还原');
  } catch (e) {
    alert('导出失败：' + (e && e.message ? e.message : e));
  }
}

function exportNotebook() {
  const lines = [];
  for (const it of WORDS) {
    const p = S.progress[it[0]];
    if (p && (p.lv === 0 || (p.wrong || 0) > 0)) lines.push(it[0] + '\t' + it[1].join('；'));
  }
  if (!lines.length) { toast('生词本是空的'); return; }
  const blob = new Blob(['\ufeff单词\t释义\n' + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '唯单词生词本-' + todayStr() + '.txt';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  toast('已导出 ' + lines.length + ' 个生词（Excel 可直接打开）');
}

function importData(file) {
  const r = new FileReader();
  r.onload = function () {
    try {
      const s = JSON.parse(r.result);
      if (!s || typeof s.progress !== 'object' || typeof s.settings !== 'object') throw new Error('bad');
      if (!confirm('导入将覆盖当前所有进度，确定继续吗？')) return;
      if (!lsSet(LS_KEY, JSON.stringify(s))) { alert('写入失败：浏览器不让本地保存，换个浏览器再导入'); return; }
      location.reload();
    } catch (e) { alert('备份文件无效'); }
  };
  r.readAsText(file);
}

function closeModal() {
  const modal = $('modal');
  if (modal.contains(document.activeElement)) document.activeElement.blur();
  $('modal-body').scrollTop = 0;
  modal.classList.add('hidden');
}

/* 发音排查引导。
 * v6.9.4 起发音只有一条路：有道词典的在线 mp3。所以这里不再是「装语音包」，
 * 而是「网络 / 音量 / 浏览器策略」三件事 —— 用户照 Windows 的老路径去找语音包只会更糊。 */
function showVoiceHelp() {
  const acc = (S && S.settings && S.settings.accent === 'uk') ? '英音' : '美音';
  const offline = navigator.onLine === false;

  const head = offline
    ? '<div class="panel-title">现在是断网状态</div>' +
      '<div class="panel" style="font-size:13px;line-height:1.9">' +
      '发音用的是有道词典的在线音频，<b>没网就读不出来</b>。连上网再点一次 🔊 就行。' +
      '背单词本身完全不受影响 —— 音标、释义、例句都在本地。</div>'
    : '<div class="panel-title">发音是从哪来的</div>' +
      '<div class="panel" style="font-size:13px;line-height:1.9">' +
      '点 🔊 时页面去 <b>dict.youdao.com</b> 取一段 mp3 直接播（当前是<b>' + acc + '</b>），' +
      '所以音色稳定、跨设备一致，代价是<b>必须联网</b>。' +
      '单词会随请求发给有道词典 —— 只是查发音，不带任何进度信息。</div>';

  $('modal-body').innerHTML =
    '<h2>🔈 发音没声怎么查</h2>' +
    head +
    '<div class="panel-title">按顺序排除（1 分钟）</div>' +
    '<div class="panel" style="font-size:13px;line-height:1.9">' +
    '1. 回「设置 → 发音自检」点 <b>读一遍试试</b> —— 那里会写出「第几秒起播」或者失败原因<br>' +
    '2. <b>换网络</b>：公司 / 学校网络偶尔会拦 dict.youdao.com，用手机热点试一次最直观<br>' +
    '3. <b>静音拨片</b>：iPhone 左侧拨片拨到静音，网页音频也会被一起静音<br>' +
    '4. <b>音量</b>：播放时按侧键调的是「媒体音量」，不是铃声音量<br>' +
    '5. <b>别的 App 占着音频</b>：先停掉音乐 / 视频 / 通话，再点 🔊' +
    '</div>' +
    '<div class="panel-title">「自动发音」和点 🔊 的区别</div>' +
    '<div class="panel" style="font-size:13px;line-height:1.9">' +
    '手机浏览器规定音频必须由手指点下去触发。本页会在你第一次触摸屏幕时悄悄解锁播放器，' +
    '之后自动发音才出得来；如果一进页面就停在卡片上、还没碰过屏幕，第一条自动发音可能被拦掉 —— ' +
    '碰一下屏幕，或者直接点卡片上的 🔊 就正常了。' +
    (IS_TOUCH ? '<br>微信 / QQ 内置浏览器对网页音频限制更多，遇到怪问题就点右上角「···」→ <b>在浏览器打开</b>。' : '') +
    '</div>' +
    '<div class="panel-title">实在没网也行</div>' +
    '<div class="panel" style="font-size:13px;line-height:1.9">' +
    '卡片上给了美音 / 英音两套音标，不依赖发音也能背。' +
    '单文件版（唯单词.html）在断网电脑上照样能查词、背词，只是不发声。</div>' +
    '<div class="actions" style="margin-top:14px"><button id="vh-back" class="big">回到设置</button></div>';
  $('modal').classList.remove('hidden');
  const back = $('vh-back');
  if (back) back.addEventListener('click', function () { openSettings(); });
}

/* ================= PWA：离线缓存与安装 ================= */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  installPrompt = e;
});
function registerSW() {
  // file:// 不支持 Service Worker，双击打开时自动跳过（离线本来就成立）
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // 单文件版没有 sw.js 与 manifest，别去请求一个不存在的文件
  if (window.VD_STANDALONE) return;
  navigator.serviceWorker.register('sw.js').catch(function () { /* 注册失败不影响使用 */ });
}
function installApp() {
  if (window.VD_STANDALONE) {
    toast('单文件版无法安装到桌面，用浏览器菜单「添加到主屏幕 / 收藏」即可');
    return;
  }
  if (!installPrompt) {
    toast('此浏览器暂不支持一键安装，可用菜单「添加到主屏幕」');
    return;
  }
  installPrompt.prompt();
  installPrompt.userChoice.then(function (r) {
    if (r && r.outcome === 'accepted') toast('已安装到桌面');
    installPrompt = null;
  });
}
function updateCache() {
  /* 单文件版没有 sw.js；file:// 也不注册 Service Worker —— 两种都没有缓存可清，直接重载 */
  if (window.VD_STANDALONE || location.protocol === 'file:' || !('serviceWorker' in navigator)) {
    toast('这一版没有离线缓存，直接重新加载');
    setTimeout(function () { location.reload(); }, 450);
    return;
  }
  navigator.serviceWorker.getRegistration().then(function (reg) {
    const doClear = function () {
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).then(function () { location.reload(); });
    };
    if (reg) {
      (reg.active || reg.waiting || reg.installing || {}).postMessage?.('clear');
      reg.update();
      setTimeout(doClear, 300);
    } else doClear();
  }).catch(function () { location.reload(); });
}

/* ================= 主题 ================= */
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
}

/* ================= 事件 ================= */
function wireUI() {
  const sel = $('book');
  sel.innerHTML = bookOptionsHtml();
  sel.value = S.settings.book;
  sel.addEventListener('change', function (e) { switchBook(e.target.value); });

  document.querySelectorAll('#modeseg button').forEach(function (b) {
    b.addEventListener('click', function (e) { if (e.detail) b.blur(); setMode(b.dataset.mode); });
  });
  $('btn-stats').addEventListener('click', openStats);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-keys').addEventListener('click', openKeys);
  $('btn-side').addEventListener('click', function () { toggleSide(); });
  $('side-tab').addEventListener('click', function () { setSideCollapsed(false); });
  $('side-scrim').addEventListener('click', function () { toggleSide(false); });
  const syncSideViewport = function () { toggleSide(false); refreshSide(); };
  if (sideViewport.addEventListener) sideViewport.addEventListener('change', syncSideViewport);
  else sideViewport.addListener(syncSideViewport);
  renderSide();
  $('modal-x').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) {
    if (e.target === $('modal')) closeModal();
  });
  $('sub-chapters').addEventListener('click', function () { show('books'); });
  $('sub-today').addEventListener('click', function (e) {
    if (current && (PHASE === 'new' || PHASE === 'review')) studyLane = PHASE;
    if (e.detail) e.currentTarget.blur();
    renderHero();
  });
  $('study-switch').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function (e) {
      if (e.detail) b.blur();
      startSession(b.dataset.lane);
    });
  });

  /* 例句逐句朗读：卡片反馈、词条详情、查词结果里都可能是同一套 .sent，
     所以用一次事件委托，别再给每处渲染单独 wire（漏一处就有一个按钮没反应）。 */
  document.addEventListener('click', function (ev) {
    const b = ev.target.closest ? ev.target.closest('.sent-speak') : null;
    if (!b) return;
    ev.preventDefault();
    ev.stopPropagation();
    b.blur();
    speak(b.dataset.sent || '');
  });
  $('card').addEventListener('click', function (ev) {
    const b = ev.target.closest('.study-detail');
    if (!b || !current) return;
    b.blur();
    openDetail(current[0]);
  });

  document.querySelectorAll('#nav button').forEach(function (b) {
    b.addEventListener('click', function (e) { if (e.detail) b.blur(); show(b.dataset.page); });
  });

  document.addEventListener('keydown', function (e) {
    if (!e.key || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (!$('modal').classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      else if (e.key === 'Tab' && $('welcome-panel')) {
        const first = $('modal-x'), last = $('welcome-done');
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea', 'button', 'summary', 'a'].includes(tag) || e.target.isContentEditable) return;
    // 保留输入框与浏览器原生快捷键，只在学习卡上回滚作答。
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (S.page === 'study' && !$('study-main').classList.contains('hidden') &&
          !e.altKey && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) redoStep(); else undoStep();
      }
      return;
    }

    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); openKeys(); return; }
    if (e.key === '/') { e.preventDefault(); show('dict'); $('dict-search').focus(); return; }

    /* A = 看当前词的完整详情（同根词 / 易混词 / 全部例句 / 短语），不用离开卡片。
       刷到一半想深究一个词时，这是最短路径。 */
    if (e.key && e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.altKey && !e.metaKey &&
      current && S.page === 'study' && $('modal').classList.contains('hidden')) {
      e.preventDefault();
      openDetail(current[0]);
      return;
    }

    if (S.page !== 'study') {
      if (e.key === 'Escape') show('study');
      return;
    }
    if (e.repeat && (e.key === 'Enter' || e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      return;
    }

    // 封面页：空格/回车 = 开始
    if (!$('hero').classList.contains('hidden')) {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        startSession();
      }
      return;
    }

    // 完成页：空格/回车 = 点主按钮（键盘一路不用落地，接着清 / 接着学）
    if (document.querySelector('#card .done')) {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        const db = document.querySelector('#card .done .actions button.primary');
        if (db) { e.preventDefault(); db.click(); }
      }
      return;
    }

    // 教学卡 / 顺带过：空格或回车下一个，← 上一个，Esc 跳过教学
    if (PHASE === 'browse' || (PHASE === 'new' && NEW && NEW.mode === 'intro')) {
      const isBrowse = PHASE === 'browse';
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (isBrowse) browseNext(); else introNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (isBrowse) browsePrev(); else introPrev();
      } else if (e.key === 'Escape' && !isBrowse) {
        e.preventDefault(); introSkip();
      } else if (e.key.toLowerCase() === 's' && current) {
        speak(current[0]);
      } else if (e.key.toLowerCase() === 'f' && current) {
        starCycle(current[0]);
      }
      return;
    }

    if (!current) return;
    if (cardKind === 'recog') {
      if (!quizAnswered) {
        if ((e.code === 'Space' || e.key === ' ') && !$('recall-reveal').classList.contains('hidden')) {
          e.preventDefault(); setRecallOptions(false);
        } else if (e.key >= '1' && e.key <= '4') { e.preventDefault(); answerQuiz(+e.key - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); selfAssess(true); }
        else if (e.key === 'Escape') { e.preventDefault(); selfAssess(false); }
        else if (e.key.toLowerCase() === 's' && current) speak(current[0]);
        else if (e.key.toLowerCase() === 'f' && current) starCycle(current[0]);
        else if (e.key.toLowerCase() === 'k' && !e.ctrlKey) dropWord('master');
        else if (e.key.toLowerCase() === 'm') toggleMode();
      } else {
        if (e.key === 'Enter' || e.code === 'Space' || e.key === ' ') {
          e.preventDefault();
          if (quizAnswered) grade(pendingSpell);
        } else if (e.key.toLowerCase() === 'n' && $('qhold')) {
          e.preventDefault();
          holdWord();
        } else if (e.key.toLowerCase() === 's' && current) speak(current[0]);
        else if (e.key.toLowerCase() === 'f' && current) starCycle(current[0]);
        else if (e.key.toLowerCase() === 'm') toggleMode();
      }
    } else {
      if (e.altKey && e.key.toLowerCase() === 's' && (spellChecked || $('playw'))) {
        e.preventDefault(); speak(current[0]);
      } else if (spellChecked) {
        if (e.key === 'Enter' || e.code === 'Space' || e.key === ' ') {
          e.preventDefault(); grade(pendingSpell);
        } else if (e.key.toLowerCase() === 'n' && $('hold')) {
          e.preventDefault();
          holdWord();
        } else if (e.key.toLowerCase() === 'm') toggleMode();
      } else if (e.key === 'Enter') {
        e.preventDefault(); checkSpell();
      } else if (e.key.toLowerCase() === 'm') {
        toggleMode();
      }
    }
  });
}

function toggleMode() {
  const order = usableModes();
  setMode(order[(order.indexOf(S.settings.mode) + 1) % order.length]);
}
function setMode(m) {
  if (m === 'listen' && DRILL && DRILL.mode === 'listen') return;
  if (usableModes().indexOf(m) < 0) m = 'recog';
  // 专项练习里手动换模式 = 放弃这组「按词挑模式」，用户的选择优先
  if (PHASE === 'drill' && DRILL && DRILL.mode) DRILL.mode = '';
  const changed = m !== S.settings.mode;
  S.settings.mode = m;
  save();
  updateTopbar();
  // 只有卡片正在显示时才需要重绘，封面页/完成页不动
  const onCard = !$('study-main').classList.contains('hidden') && QUEUE.length && QI < QUEUE.length;
  if (onCard) renderCard();
  if (changed) {
    toast({
      recog: '识别：看单词，从四个释义里选一个',
      spell: '拼写：看释义，把单词拼出来',
      ctx: '语境：给一句挖空的例句，把词填回去',
      listen: '听写：只放读音，把单词拼出来（听不清可反复听）'
    }[m]);
  }
}

/* ================= 启动 ================= */
function bootFatal(err) {
  const msg = (err && (err.message || err)) || '未知错误';
  try {
    if (typeof window.__VD_SHOW_FATAL === 'function') { window.__VD_SHOW_FATAL('启动失败', esc(msg)); return; }
  } catch (e) { /* ignore */ }
  const c = document.getElementById('card');
  if (c) c.innerHTML = '<p class="bad">启动失败：' + esc(msg) + '</p>';
}
(async function init() {
  try {
    applyCustomBook();      // 先挂自定义词库，再建词书下拉
    applyTheme();
    applySideCollapsed();
    wireUI();
    registerSW();
    primeAudio();      // 第一次交互时解锁播放器，自动发音才出得来
    try {
      await prepareBook();
    } catch (err) {
      $('hero').classList.add('hidden');
      $('study-main').classList.remove('hidden');
      show('study');
      $('card').innerHTML = '<p class="bad">词库加载失败：' + esc(err.message) +
        '<br><span class="muted">单文件版自带词库，出现这句说明文件被截断过 —— 重新拷一份完整的 .html。</span></p>';
      window.VD_BOOT_OK = 1;
      return;
    }
    const saved = S.session;
    if (restoreSession(saved)) {
      // 已接续到上次的位置（restoreSession 内部会 renderCard）
    } else {
      S.session = null;
      save();
      PHASE = 'review';
      renderHero();            // 落地页 = 今日任务台
    }
    show(S.page);
    const welcome = lsGet(WELCOME_KEY);
    if (!welcome || welcome === 'always') openWelcome(false);
    window.VD_BOOT_OK = 1;
    ensurePaper();          // 首屏就绪后后台加载真题
    /* 登录过才跑；不 await —— 首页不能被网络卡住 */
    cloudBootSync();
  } catch (err) {
    bootFatal(err);
  }
})();
