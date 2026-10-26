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
const APP_VER = '3.0.0';

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
function nextIntervalPreview(p, g) {
  const Fk = F();
  const now = Date.now();
  if (Fk) {
    try {
      const out = Fk.next(buildFsrsCard(p, now), new Date(now), g);
      return fmtInterval(out.card.due.getTime() - now);
    } catch (e) { /* 兜底 */ }
  }
  const lv = Math.min((p ? p.lv : 0) + (g === 3 ? 1 : 0), MAX_LV);
  return INTERVALS[Math.min(lv, 7)] + '天';
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
    settings: { book: 'cet6', mode: 'recog', newPerDay: 20, autoSpeak: false, theme: 'auto', retention: 0.9 },
    progress: {},   // word -> { lv, due, wrong, lastWrong }
    days: {},       // 'YYYY-MM-DD' -> { n, r }
    books: {},      // bookId -> { chapter: 当前章节下标 }
    stars: {},      // word -> 1 收藏 | 2 重点收藏
    shist: [],      // 查词历史（最近 12 个）
    session: null,  // 会话快照（轮次巩固中途可接续）
    page: 'study'
  };
}
function loadState() {
  // 优先读 v2，其次迁移 v1（保留进度、统计与设置）
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* ignore */ }
  if (!s) {
    try { s = JSON.parse(localStorage.getItem('vocabdrill.v1')); } catch (e) { /* ignore */ }
  }
  const d = defaultState();
  if (s && typeof s === 'object') {
    s.settings = Object.assign(d.settings, s.settings || {});
    if (!BOOKS[s.settings.book]) s.settings.book = 'cet6';   // 旧数据里的四级书已并入六级
    s.progress = s.progress || {};
    for (const k in s.progress) {
      const p = s.progress[k];
      if (p.wrong == null) p.wrong = 0;
      if (p.lastWrong == null) p.lastWrong = 0;
    }
    s.days = s.days || {};
    s.books = (s.books && typeof s.books === 'object') ? s.books : {};
    s.stars = (s.stars && typeof s.stars === 'object') ? s.stars : {};
    s.shist = Array.isArray(s.shist) ? s.shist : [];
    s.session = (s.session && typeof s.session === 'object' && Array.isArray(s.session.queue)) ? s.session : null;
    s.page = PAGES.indexOf(s.page) >= 0 ? s.page : 'study';
    return s;
  }
  return d;
}
let S = loadState();
function save() { localStorage.setItem(LS_KEY, JSON.stringify(S)); }

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
async function ensureAllBooks() {
  if (ALL_LOADED) return;
  await Promise.all(Object.keys(BOOKS).map(ensureBook));
  DICT = new Map();
  for (const bid of Object.keys(BOOKS)) {
    for (const it of VD_DATA[bid].words) {
      const k = it[0].toLowerCase();
      let e = DICT.get(k);
      if (!e) {
        e = { w: it[0], defs: it[1], phrases: it[2] || [], freq: it[3] === 1,
          us: it[4] || '', uk: it[5] || '', sents: it[6] || [], syns: it[7] || [],
          rank: it[8] || 0, books: [] };
        DICT.set(k, e);
      }
      e.books.push(bid);
    }
  }
  ALL_LOADED = true;
}

/* ================= 会话队列 ================= */
let WORDS = [], DEFMAP = new Map();
let CHAPTERS = [];          // 按首字母分组的章节 [{label, words}]
let CH_COUNT = 1, CUR_CH = 0;
let QUEUE = [], QI = 0;
let sessionGrades = {};   // 本次会话每个已刷词的最后一次评分（1/2/3），驱动轮次巩固
let round = 1;            // 当前轮次：1=首轮，2+ 为巩固轮
let roundStats = [];      // 每个巩固轮开始时的待过词数
let firstPassCount = 0;   // 首轮刷卡词数（成绩单用）
let session = { n: 0, r: 0 };
let sessionMode = 'normal';   // normal | wrong
let lastUndo = null;
let revealed = false;
let spellChecked = false;
let pendingSpell = null;
let listenOpts = [], listenAnswered = false;
let current = null;

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
    if (CHAPTERS[i].words.some(function (w) { return !S.progress[w]; })) return i;
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

// opts: { chapter: 指定章节 } / { wrong: true 错词重刷 }
async function buildQueue(opts) {
  opts = opts || {};
  const book = await ensureBook(S.settings.book);
  WORDS = book.words;
  DEFMAP = new Map(WORDS.map(function (it) { return [it[0], it]; }));
  buildChapters();

  let ch = bookChapter(S.settings.book);
  if (opts.chapter != null) ch = Math.min(opts.chapter, CH_COUNT - 1);
  CUR_CH = ch;
  S.books[S.settings.book] = { chapter: ch };
  save();

  const now = Date.now();
  sessionMode = opts.wrong ? 'wrong' : 'normal';
  if (opts.wrong) {
    QUEUE = shuffle(WORDS.filter(function (it) {
      const p = S.progress[it[0]];
      return p && p.wrong > 0;
    }).map(function (it) { return it[0]; }));
  } else {
    const due = [];
    for (const it of WORDS) {
      const p = S.progress[it[0]];
      if (p && p.due <= now) due.push(it[0]);
    }
    const cwUnseen = chapterWords(ch).filter(function (w) { return !S.progress[w]; });
    const quota = Math.max(0, S.settings.newPerDay - dayRec().n);
    QUEUE = shuffle(due).concat(cwUnseen.slice(0, quota));
  }
  QI = 0; sessionGrades = {}; round = 1; roundStats = []; firstPassCount = 0;
  session = { n: 0, r: 0 }; lastUndo = null;
  S.session = null;   // 新队列 = 新会话，丢弃旧会话快照
  save();
  renderCard();
}

/* 轮次巩固：本会话内最后一次评分不是「认识」的词，都要在巩固轮再过一遍 */
function pendingWords() {
  return Object.keys(sessionGrades).filter(function (w) { return sessionGrades[w] !== 3; });
}

/* 会话快照：轮次巩固中途关掉页面，回来也能接续本轮 */
function saveSession() {
  if (sessionMode !== 'normal' || (!current && !QUEUE.length)) { S.session = null; save(); return; }
  S.session = {
    book: S.settings.book,
    date: todayStr(),
    queue: QUEUE.slice(),
    qi: QI,
    grades: sessionGrades,
    round: round,
    roundStats: roundStats,
    first: firstPassCount,
    counts: { n: session.n, r: session.r },
    chapter: CUR_CH
  };
  save();
}
function restoreSession(s) {
  if (!s || s.book !== S.settings.book || s.date !== todayStr()) return;
  if (!s.queue || !s.queue.length) return;
  const q = s.queue.filter(function (w) { return DEFMAP.has(w); });
  if (!q.length) return;
  QUEUE = q;
  QI = Math.min(s.qi || 0, QUEUE.length);
  sessionGrades = s.grades || {};
  round = s.round || 1;
  roundStats = s.roundStats || [];
  firstPassCount = s.first || 0;
  session = { n: (s.counts && s.counts.n) || 0, r: (s.counts && s.counts.r) || 0 };
  sessionMode = 'normal';
  lastUndo = null;
  if (s.chapter != null && s.chapter < CHAPTERS.length) {
    CUR_CH = s.chapter;
    S.books[S.settings.book] = { chapter: CUR_CH };
    save();
  }
  renderCard();
}

/* ================= 调度 ================= */
function grade(g) {
  if (!current || QI >= QUEUE.length) return;
  const w = current[0];
  const p = S.progress[w];
  const isNew = !p;
  lastUndo = { w: w, prev: p ? JSON.parse(JSON.stringify(p)) : null,
    days: JSON.parse(JSON.stringify(S.days)),
    prevSG: Object.prototype.hasOwnProperty.call(sessionGrades, w) ? sessionGrades[w] : null };

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
  if (g !== 1 && p && p.lastWrong) np.lastWrong = p.lastWrong;
  S.progress[w] = np;

  // 记录本次会话评分，供轮次巩固使用（错词重刷模式除外）
  if (sessionMode === 'normal') sessionGrades[w] = g;

  const d = dayRec(true);
  if (isNew) { d.n++; session.n++; } else { d.r++; session.r++; }
  save();
  QI++;
  saveSession();   // 快照指向下一张卡，恢复后无缝续刷
  renderCard();
}

function undo() {
  if (!lastUndo || QI <= 0) return;
  const u = lastUndo;
  if (u.prev) S.progress[u.w] = u.prev; else delete S.progress[u.w];
  S.days = u.days;
  if (u.prevSG == null) delete sessionGrades[u.w]; else sessionGrades[u.w] = u.prevSG;
  save();
  lastUndo = null;
  QI--;
  saveSession();
  renderCard();
  toast('已撤销上一张');
}

/* ================= 渲染基础 ================= */
const $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(function () { t.classList.add('hidden'); }, 1800);
}
function statusClass(p) { return !p ? 's0' : (p.lv >= 3 ? 's2' : 's1'); }

/* 词条内容渲染助手：释义分条（词性高亮）、短语、例句（英文+中文） */
function defsHtml(defs) {
  return defs.map(function (d) {
    const m = d.match(/^([a-z]+\.)\s*(.*)$/i);
    return m
      ? '<div class="dline"><b class="pos">' + esc(m[1]) + '</b>' + esc(m[2]) + '</div>'
      : '<div class="dline">' + esc(d) + '</div>';
  }).join('');
}
function phrInlineHtml(ph) {
  if (!ph) return '';
  return '<div class="phinline"><span class="plabel">短语</span><b>' + esc(ph[0]) + '</b>' + esc(ph[1]) + '</div>';
}
function sentHtml(s) {
  if (!s) return '';
  return '<div class="sent"><span class="en">' + esc(s[0]) + '</span><span class="cn">' + esc(s[1]) + '</span></div>';
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
  $('mode').textContent = { recog: '识别模式', spell: '拼写模式', listen: '听音辨意' }[S.settings.mode] || '识别模式';
}

function updateProgressbar() {
  const pct = QUEUE.length ? Math.round(QI / QUEUE.length * 100) : 100;
  $('pbar-in').style.width = pct + '%';
}

function updateStudySub(showPos) {
  if (sessionMode === 'wrong') {
    $('study-sub-text').textContent = '错词重刷 · 共 ' + QUEUE.length + ' 词（答对即移出错词本）';
    return;
  }
  if (round > 1) {
    $('study-sub-text').textContent = '第 ' + round + ' 轮巩固 · 共 ' + QUEUE.length + ' 词' +
      (showPos === false ? '' : ' · 刷到第 ' + (QI + 1) + ' 词') +
      ' · 全部点「认识」即完成';
    return;
  }
  const cw = chapterWords(CUR_CH);
  const learned = cw.filter(function (w) { return S.progress[w]; }).length;
  $('study-sub-text').textContent =
    BOOKS[S.settings.book].name + ' · List ' + CHAPTERS[CUR_CH].label +
    ' · ' + (showPos === false ? '' : '首轮 第 ' + (QI + 1) + '/' + QUEUE.length + ' 词 · ') +
    '本章 ' + learned + '/' + cw.length;
}

function tagOf(p) {
  if (!p) return '新词';
  return p.lv >= 3 ? '复习' : '巩固';
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

/* ================= 学习页 ================= */
function renderCard() {
  updateTopbar();
  // 队列刷完且还有未过关的词 → 自动进入下一轮巩固，直到全部「认识」
  if (QI >= QUEUE.length) {
    if (sessionMode === 'normal' && pendingWords().length > 0) {
      if (round === 1) firstPassCount = Object.keys(sessionGrades).length;
      round++;
      roundStats.push({ round: round, count: pendingWords().length });
      QUEUE = shuffle(pendingWords());
      QI = 0;
      saveSession();
      toast('第 ' + round + ' 轮巩固：' + QUEUE.length + ' 词再过一遍，全部点「认识」即完成');
    } else {
      renderDone();
      return;
    }
  }
  updateStudySub();
  updateProgressbar();
  const card = $('card');
  revealed = false; spellChecked = false; pendingSpell = null;
  const w = QUEUE[QI];
  current = DEFMAP.get(w) || [w, [], []];
  const defs = current[1];
  const phrases = current[2] || [];
  const p = S.progress[w];
  card.classList.remove('pop');
  void card.offsetWidth;   // 重新触发动画
  card.classList.add('pop');

  if (S.settings.mode === 'recog') {
    const freq = current[3] === 1;
    const us = current[4] || '', sents = current[6] || [];
    const syns = current[7] || [];
    const ret = retrievability(p);
    card.innerHTML =
      '<div class="tagline">' + (round > 1 ? '第' + round + '轮巩固 · ' : '') + tagOf(p) + (freq ? ' · <span class="freqmark">高频</span>' : '') + (ret != null ? ' · 记忆 ' + ret + '%' : '') + '</div>' +
      '<div class="word">' + esc(w) +
      ' <button id="speak" class="icon" title="发音 (S)">🔊</button>' +
      ' <button id="starbtn" class="icon' + ((S.stars[w] || 0) ? ' starred' : '') + '" title="收藏：点一下收藏，再点设为重点，再点取消">' + starLabel(w) + '</button></div>' +
      (us || current[5] ? phonHtml({ us: current[4], uk: current[5] }) : '') +
      '<div id="meaning" class="meaning hidden">' +
      defsHtml(defs) +
      (phrases.length ? phrInlineHtml(phrases[0]) : '') +
      synInlineHtml(syns) +
      (sents.length ? sentHtml(sents[0]) : '') +
      '</div>' +
      '<div class="actions" id="revealrow">' +
      '<button id="reveal" class="primary big">显示释义 <kbd>空格</kbd></button>' +
      '</div>' +
      '<div class="actions">' +
      '<button class="grade g1 big" data-g="1">不认识 <kbd>1</kbd></button>' +
      '<button class="grade g2 big" data-g="2">模糊 ≈' + nextIntervalPreview(p, 2) + ' <kbd>2</kbd></button>' +
      '<button class="grade g3 big" data-g="3">认识 +' + nextIntervalPreview(p, 3) + ' <kbd>3</kbd></button>' +
      (lastUndo ? '<button id="undobtn" class="big ghost" title="撤销上一步 (Ctrl+Z)">↩ 撤销</button>' : '') +
      '</div>';  } else if (S.settings.mode === 'listen') {
    listenOpts = buildListenOptions(current);
    listenAnswered = false;
    card.innerHTML =
      '<div class="tagline">' + (round > 1 ? '第' + round + '轮巩固 · ' : '') + '听音辨意 · 听读音选释义</div>' +
      '<button id="replay" class="primary big">🔊 播放读音 <kbd>空格</kbd></button>' +
      '<div id="lopts" class="lopts">' +
      listenOpts.map(function (o, i) {
        return '<button class="big lopt" data-i="' + i + '"><span class="lnum">' + (i + 1) + '</span>' + esc(o.text) + '</button>';
      }).join('') +
      '</div>' +
      '<div id="lfb" class="spellfb"></div>' +
      '<div class="actions"><button id="lnext" class="primary big hidden">下一个 <kbd>回车</kbd></button></div>';
  } else {
    const cloze = clozeHint(w, current[6]);
    card.innerHTML =
      '<div class="tagline">拼写 · ' + tagOf(p) + '</div>' +
      '<div class="meaning prompt">' + esc(defs.join('\n')) + '</div>' +
      (cloze
        ? '<div class="sent cloze"><span class="en">' + esc(cloze) + '</span></div>'
        : '<div class="hint">' + hintPattern(w) + '</div>') +
      '<input id="spell" class="spell" autocomplete="off" autocapitalize="off" ' +
      'spellcheck="false" placeholder="输入单词后回车">' +
      '<div id="spellfb" class="spellfb"></div>' +
      '<div class="actions"><button id="skip" class="big">跳过（不认识）</button></div>';
    const inp = $('spell');
    inp.focus();
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); checkSpell(); }
    });
  }

  const sp = $('speak');
  if (sp) sp.addEventListener('click', function () { speak(w); });
  const sb = $('starbtn');
  if (sb) sb.addEventListener('click', function () { starCycle(w); });
  const sk = $('skip');
  if (sk) sk.addEventListener('click', function () { showSpellAnswer(false, true); });
  const rp = $('replay');
  if (rp) rp.addEventListener('click', function () { speak(w); });
  const nl = $('lnext');
  if (nl) nl.addEventListener('click', function () { grade(pendingSpell); });
  card.querySelectorAll('.lopt').forEach(function (b) {
    b.addEventListener('click', function () { answerListen(+b.dataset.i); });
  });
  const rv = $('reveal');
  if (rv) rv.addEventListener('click', reveal);
  const ub = $('undobtn');
  if (ub) ub.addEventListener('click', undo);
  card.querySelectorAll('.grade').forEach(function (b) {
    b.addEventListener('click', function () { grade(+b.dataset.g); });
  });

  if (S.settings.mode === 'listen') speak(w);
  else if (S.settings.mode === 'recog' && S.settings.autoSpeak) speak(w);
}

function reveal() {
  if (revealed || S.settings.mode !== 'recog') return;
  revealed = true;
  $('meaning').classList.remove('hidden');
  const rr = $('revealrow');
  if (rr) rr.classList.add('hidden');
}

/* 听音辨意：正确释义 + 3 个随机干扰项 */
function buildListenOptions(entry) {
  const correctText = entry[1].join('；').slice(0, 40);
  const opts = [{ ok: true, text: correctText }];
  let guard = 0;
  while (opts.length < 4 && guard++ < 300) {
    const it = WORDS[(Math.random() * WORDS.length) | 0];
    if (!it || it[0] === entry[0] || !it[1][0]) continue;
    const t = it[1].join('；').slice(0, 40);
    if (t === correctText || opts.some(function (o) { return o.text === t; })) continue;
    opts.push({ ok: false, text: t });
  }
  return shuffle(opts);
}
function answerListen(i) {
  if (listenAnswered || !listenOpts[i]) return;
  listenAnswered = true;
  const ok = listenOpts[i].ok;
  pendingSpell = ok ? 3 : 1;
  document.querySelectorAll('#lopts .lopt').forEach(function (b, j) {
    b.disabled = true;
    if (listenOpts[j] && listenOpts[j].ok) b.classList.add('lopt-ok');
    else if (j === i) b.classList.add('lopt-bad');
  });
  const fb = $('lfb');
  fb.innerHTML =
    (ok ? '<span class="ok">✓ 正确</span>' : '<span class="bad">✗ 正确答案：</span>') +
    ' <span class="word small">' + esc(current[0]) + ' <button id="speak2" class="icon">🔊</button></span>' +
    (current[4] || current[5] ? phonHtml({ us: current[4], uk: current[5] }) : '') +
    '<div class="meaning">' + defsHtml(current[1]) +
    (current[6] && current[6].length ? sentHtml(current[6][0]) : '') + '</div>';
  fb.querySelector('#speak2').addEventListener('click', function () { speak(current[0]); });
  const nl = $('lnext');
  if (nl) nl.classList.remove('hidden');
  speak(current[0]);
}

/* 例句挖空：例句含目标词时，用挖空句替代首字母提示（语境线索，不带中文防泄底） */
function clozeHint(w, sents) {
  if (sents && sents.length) {
    const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(sents[0][0])) return sents[0][0].replace(re, '＿＿＿');
  }
  return null;
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

function checkSpell() {
  if (spellChecked) { grade(pendingSpell); return; }
  const inp = $('spell');
  const ok = norm(inp.value) === norm(current[0]);
  showSpellAnswer(ok, false);
}

function showSpellAnswer(ok, skipped) {
  if (spellChecked) return;
  spellChecked = true;
  pendingSpell = (ok && !skipped) ? 3 : 1;
  const w = current[0], defs = current[1];
  const sents = current[6] || [];
  const inp = $('spell');
  inp.disabled = true;
  inp.classList.add(ok && !skipped ? 'right' : 'wrong');
  const fb = $('spellfb');
  fb.innerHTML =
    (ok && !skipped ? '<span class="ok">✓ 正确</span>' : '<span class="bad">✗ 正确答案：</span>') +
    ' <span class="word small">' + esc(w) + ' <button id="speak2" class="icon">🔊</button></span>' +
    (current[4] || current[5] ? phonHtml({ us: current[4], uk: current[5] }) : '') +
    '<div class="meaning">' + defsHtml(defs) +
    (sents.length ? sentHtml(sents[0]) : '') + '</div>';
  fb.querySelector('#speak2').addEventListener('click', function () { speak(w); });
  $('skip').parentElement.innerHTML =
    '<button id="next" class="primary big">下一个 <kbd>回车</kbd></button>';
  $('next').addEventListener('click', function () { grade(pendingSpell); });
  speak(w);
}

function renderDone() {
  current = null;
  S.session = null; save();   // 本批结束，清除会话快照
  const card = $('card');
  const d = dayRec();

  if (sessionMode === 'wrong') {
    round = 1; roundStats = []; firstPassCount = 0;
    sessionMode = 'normal';
    updateStudySub(false);
    card.innerHTML =
      '<div class="done">' +
      '<div class="done-emoji">🎯</div>' +
      '<h2>错词刷完</h2>' +
      '<p>本次刷错词 ' + (session.n + session.r) + ' 个，答对的已移出错词本</p>' +
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
  const mastery = roundStats.length === 0
    ? '本次 ' + uniq + ' 词全部认识，一次通过 🎉'
    : '首轮 ' + firstPassCount + ' 词，巩固 ' +
      roundStats.map(function (s) { return s.count; }).join(' → ') +
      ' 词，' + roundStats.length + ' 轮巩固后全部掌握 🎉';
  // 本批结束，轮次状态归零，下一批重新计数
  round = 1; roundStats = []; firstPassCount = 0;
  updateStudySub(false);

  // 全部掌握的小庆祝彩带
  const conf = [];
  for (let i = 0; i < 14; i++) {
    conf.push('<i class="cf" style="left:' + (3 + i * 7) + '%;animation-delay:' + (i * 0.1).toFixed(2) +
      's;background:' + ['#69b58c', '#e8a33d', '#d67f70', '#7c93ff'][i % 4] + '"></i>');
  }

  const cwUnseen = chapterWords(CUR_CH).filter(function (w) { return !S.progress[w]; }).length;
  const wrongN = WORDS.filter(function (it) {
    const p = S.progress[it[0]];
    return p && p.wrong > 0;
  }).length;
  const chDone = cwUnseen === 0;

  card.innerHTML =
    '<div class="confetti">' + conf.join('') + '</div>' +
    '<div class="done">' +
    '<div class="done-emoji">🎉</div>' +
    '<h2>' + (chDone ? 'List ' + CHAPTERS[CUR_CH].label + ' 学完' : '本轮完成') + '</h2>' +
    '<p>本次会话：新词 ' + session.n + ' · 复习 ' + session.r + '</p>' +
    '<p>' + mastery + '</p>' +
    '<p>今天累计：新词 ' + d.n + ' · 复习 ' + d.r + '</p>' +
    '<div class="actions">' +
    '<button id="more" class="primary big">再学 10 个</button>' +
    (CUR_CH + 1 < CH_COUNT ? '<button id="nextch" class="big">下一章</button>' : '') +
    '<button id="gochapters" class="big">选章节</button>' +
    (wrongN ? '<button id="wrongdrill" class="big">错词重刷 (' + wrongN + ')</button>' : '') +
    '<button id="openstats" class="big">统计</button>' +
    '</div></div>';

  $('more').addEventListener('click', function () { addMoreNew(10); });
  const nx = $('nextch');
  if (nx) nx.addEventListener('click', function () { buildQueue({ chapter: CUR_CH + 1 }); });
  $('gochapters').addEventListener('click', function () { show('books'); });
  const wd = $('wrongdrill');
  if (wd) wd.addEventListener('click', function () { buildQueue({ wrong: true }); });
  $('openstats').addEventListener('click', openStats);
}

function addMoreNew(n) {
  let added = 0;
  for (const w of chapterWords(CUR_CH)) {
    if (added >= n) break;
    if (!S.progress[w]) { QUEUE.push(w); added++; }
  }
  if (added < n) {
    for (const it of WORDS) {
      if (added >= n) break;
      if (!S.progress[it[0]]) { QUEUE.push(it[0]); added++; }
    }
  }
  if (added) toast('加入 ' + added + ' 个新词');
  saveSession();
  renderCard();
}

/* ================= 语音 ================= */
function speak(w, lang) {
  try {
    const u = new SpeechSynthesisUtterance(w);
    u.lang = lang || 'en-US';
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { /* 浏览器不支持时静默 */ }
}

/* ================= 页面切换 ================= */
function show(page) {
  if (PAGES.indexOf(page) < 0) page = 'study';
  S.page = page; save();
  PAGES.forEach(function (p) {
    $('page-' + p).classList.toggle('hidden', p !== page);
  });
  document.querySelectorAll('#nav button').forEach(function (b) {
    b.classList.toggle('active', b.dataset.page === page);
  });
  $('hints').classList.toggle('hidden', page !== 'study');
  if (page === 'books') renderBooksPage();
  else if (page === 'dict') initDictPage();
  else if (page === 'list') initListPage();
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
  const bc = root.querySelector('.bcontinue');
  if (bc) bc.addEventListener('click', function () { buildQueue({}).then(function () { show('study'); }); });
  root.querySelectorAll('.bswitch').forEach(function (b) {
    b.addEventListener('click', function () { switchBook(b.dataset.b); });
  });
}

function switchBook(bid) {
  S.settings.book = bid;
  save();
  $('book').value = bid;
  buildQueue({}).then(function () { show('study'); });
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
    return rowHtml({ w: it[0], defs: it[1], freq: it[3] === 1 });
  }).join('');
  $('modal-body').innerHTML =
    '<h2>📘 List ' + esc(ch.label) + ' · ' + ch.words.length + ' 词 · 已学 ' + learned + '</h2>' +
    '<div class="actions" style="justify-content:flex-start;margin-bottom:12px">' +
    '<button id="ch-study" class="big primary">学习本章</button>' +
    '<button id="ch-close" class="big">返回</button></div>' +
    '<div class="rowlist">' + rows + '</div>';
  $('ch-study').addEventListener('click', function () {
    closeModal();
    buildQueue({ chapter: i }).then(function () { show('study'); });
  });
  $('ch-close').addEventListener('click', closeModal);
  wireRows($('modal-body'));
  $('modal').classList.remove('hidden');
}

/* ================= 查词页 ================= */
let dictWired = false;
async function initDictPage() {
  const res = $('dict-results');
  if (!ALL_LOADED) {
    res.innerHTML = '<p class="muted center">正在加载全部词库…</p>';
    await ensureAllBooks();
  }
  if (!dictWired) {
    dictWired = true;
    $('dict-search').addEventListener('input', renderDictResults);
  }
  renderDictResults();
  $('dict-search').focus();
}

function renderDictResults() {
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
  for (const e of DICT.values()) {
    const w = e.w.toLowerCase();
    if (w.startsWith(q)) { if (starts.length < MAX) starts.push(e); }
    else if (w.indexOf(q) >= 0) { if (mid.length < MAX) mid.push(e); }
    if (starts.length >= MAX && mid.length >= MAX) break;
  }
  const rows = starts.concat(mid).sort(function (a, b) {
    return a.w.toLowerCase() < b.w.toLowerCase() ? -1 : 1;
  }).slice(0, MAX);

  if (!rows.length) {
    res.innerHTML = '<p class="muted center">没有找到「' + esc(raw) + '」</p>';
    return;
  }
  // 精准命中：顶部内嵌完整词条卡（释义+短语+例句），无需点击
  let head = '';
  if (rows[0].w.toLowerCase() === q) head = richCardHtml(rows[0], 'dc');
  res.innerHTML =
    '<p class="muted listcount">找到 ' + rows.length + ' 条' + (rows.length >= MAX ? '（仅显示前 ' + MAX + '）' : '') + '</p>' +
    head +
    rows.map(rowHtml).join('');
  wireRows(res);
  if (head) wireRichCard(res, rows[0], 'dc', renderDictResults);
}

function rowHtml(e) {
  const p = S.progress[e.w];
  const st = S.stars[e.w] || 0;
  const def = e.defs[0] || '';
  const cls = ['row', statusClass(p),
    p && p.wrong > 0 ? 'f-wrong' : '',
    e.freq ? 'f-freq' : ''].join(' ');
  return '<button class="' + cls + '" data-w="' + esc(e.w) + '">' +
    '<span class="dot"></span>' +
    '<span class="rword">' +
    (st ? '<i class="starmark">' + (st === 2 ? '⭐⭐' : '⭐') + '</i>' : '') +
    esc(e.w) +
    (p && p.wrong > 0 ? ' <i class="wrongmark">错' + p.wrong + '</i>' : '') +
    (e.freq ? ' <i class="freqmark">高频</i>' : '') +
    '</span>' +
    '<span class="rdef">' + esc(def.length > 30 ? def.slice(0, 30) + '…' : def) + '</span>' +
    '</button>';
}
function wireRows(root) {
  root.querySelectorAll('.row').forEach(function (b) {
    b.addEventListener('click', function () { openDetail(b.dataset.w); });
  });
}

/* ================= 单词本页 ================= */
let listTab = 'all';
let listWired = false;
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
        renderListTabs();
        renderList();
      });
    });
    $('redrill').addEventListener('click', function () {
      buildQueue({ wrong: true }).then(function () { show('study'); });
    });
  }
}

function listSets() {
  const sets = { all: [], mastered: [], unseen: [], wrong: [], star: [], star2: [] };
  if (!ALL_LOADED) return sets;
  for (const e of DICT.values()) {
    const p = S.progress[e.w];
    const st = S.stars[e.w] || 0;
    if (st === 1) sets.star.push(e);
    else if (st === 2) sets.star2.push(e);
    if (!p) { sets.unseen.push(e); continue; }
    sets.all.push(e);
    if (p.lv >= 3) sets.mastered.push(e);
    if (p.wrong > 0) sets.wrong.push(e);
  }
  return sets;
}

function renderListTabs() {
  const sets = listSets();
  const labels = { all: '已背', mastered: '已掌握', unseen: '未背', wrong: '错词', star: '收藏', star2: '重点' };
  document.querySelectorAll('#list-tabs button').forEach(function (b) {
    const t = b.dataset.t;
    b.textContent = labels[t] + ' ' + sets[t].length;
    b.classList.toggle('active', t === listTab);
  });
  $('list-head').classList.toggle('hidden', !(listTab === 'wrong' && sets.wrong.length));
}

function renderList() {
  const sets = listSets();
  const arr = sets[listTab];
  const q = norm($('list-filter').value);
  const total = arr.filter(function (e) { return !q || e.w.toLowerCase().indexOf(q) >= 0; }).length;
  let rows = arr.filter(function (e) { return !q || e.w.toLowerCase().indexOf(q) >= 0; });
  if (listTab === 'wrong') {
    rows.sort(function (a, b) {   // 错得最多的排最前
      return ((S.progress[b.w] || {}).wrong || 0) - ((S.progress[a.w] || {}).wrong || 0);
    });
  }
  rows = rows.slice(0, 200);
  const res = $('list-results');
  if (!total) {
    res.innerHTML = '<p class="muted center">' +
      (listTab === 'wrong' ? '错词本是空的，继续保持 👍'
        : (listTab === 'star' || listTab === 'star2') ? '还没有收藏单词。在学习卡片或单词详情里点 ⭐ 即可收藏'
        : '暂无单词') + '</p>';
    return;
  }
  res.innerHTML =
    '<p class="muted listcount">共 ' + total + ' 词' +
    (total > 200 ? '（仅显示前 200，可用筛选缩小范围）' : '') + '</p>' +
    rows.map(rowHtml).join('');
  wireRows(res);
}

/* ================= 单词详情弹窗 ================= */
function synInlineHtml(syns) {
  if (!syns || !syns.length) return '';
  return '<div class="phinline"><span class="plabel">近义</span>' +
    esc(syns.slice(0, 4).join(' · ')) + '</div>';
}

/* 词条富卡片：查词精准命中内嵌展示 与 单词详情弹窗 共用（px 为按钮 id 前缀） */
function richCardHtml(e, px) {
  const p = S.progress[e.w];
  const st = S.stars[e.w] || 0;
  const stTxt = !p ? '未学' : (p.lv >= 3 ? '已掌握 · Lv' + p.lv : '学习中 · Lv' + p.lv);
  return '<div class="richcard">' +
    '<div class="word small">' + esc(e.w) +
    ' <button id="' + px + '-speak" class="icon" title="发音">🔊</button></div>' +
    phonHtml(e, px) +
    '<div class="tags">' +
    (e.freq ? '<span class="chip tag freq">高频词' + (e.rank ? ' #' + e.rank : '') + '</span>' : '') +
    e.books.map(function (b) { return '<span class="chip tag">' + esc(BOOKS[b].name) + '</span>'; }).join('') +
    '<span class="chip tag st">' + stTxt + '</span>' +
    (p && p.wrong > 0 ? '<span class="chip tag err">错过 ' + p.wrong + ' 次</span>' : '') +
    '</div>' +
    '<div class="actions">' +
    '<button id="' + px + '-star1" class="big' + (st === 1 ? ' primary' : '') + '">⭐ 收藏</button>' +
    '<button id="' + px + '-star2" class="big' + (st === 2 ? ' primary' : '') + '">⭐⭐ 重点收藏</button>' +
    '</div>' +
    '<div class="meaning">' + defsHtml(e.defs) + '</div>' +
    (e.syns && e.syns.length
      ? '<h3 class="rsub">近义词（点击查看）</h3><div class="chips syns">' +
        e.syns.map(function (s) { return '<button class="chip synchip" data-w="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') +
        '</div>'
      : '') +
    (e.phrases.length
      ? '<h3 class="rsub">常用短语</h3><ul class="phr">' +
        e.phrases.map(function (ph) { return '<li><b>' + esc(ph[0]) + '</b>' + esc(ph[1]) + '</li>'; }).join('') +
        '</ul>'
      : '') +
    (e.sents.length
      ? '<h3 class="rsub">例句</h3><div class="sents">' + e.sents.map(sentHtml).join('') + '</div>'
      : '') +
    '</div>';
}
function wireRichCard(root, e, px, refresh) {
  const sp = root.querySelector('#' + px + '-speak');
  if (sp) sp.addEventListener('click', function () { speak(e.w); });
  const su = root.querySelector('#' + px + '-s-us');
  if (su) su.addEventListener('click', function () { speak(e.w, 'en-US'); });
  const sku = root.querySelector('#' + px + '-s-uk');
  if (sku) sku.addEventListener('click', function () { speak(e.w, 'en-GB'); });
  root.querySelectorAll('.synchip').forEach(function (b) {
    if (!DICT.has(b.dataset.w.toLowerCase())) b.classList.add('dim');   // 词库外的近义词置灰
    b.addEventListener('click', function () {
      const sw = b.dataset.w;
      if (DICT.has(sw.toLowerCase())) openDetail(sw);
      else toast('词库中未收录「' + sw + '」');
    });
  });
  const s1 = root.querySelector('#' + px + '-star1');
  if (s1) s1.addEventListener('click', function () { setStar(e.w, 1); refresh(); });
  const s2 = root.querySelector('#' + px + '-star2');
  if (s2) s2.addEventListener('click', function () { setStar(e.w, 2); refresh(); });
}

async function openDetail(w) {
  if (!ALL_LOADED) await ensureAllBooks();
  const e = DICT.get(w.toLowerCase());
  if (!e) { toast('未收录该单词'); return; }
  // 记录查词历史（最近 12 个，去重）
  S.shist = [e.w].concat(S.shist.filter(function (x) { return x !== e.w; })).slice(0, 12);
  save();
  $('modal-body').innerHTML = richCardHtml(e, 'dt');
  wireRichCard($('modal-body'), e, 'dt', function () { openDetail(e.w); });
  $('modal').classList.remove('hidden');
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
    return '<div class="tcol" title="Lv' + i + ' · ' + c + ' 词">' +
      '<i style="height:' + Math.max(2, Math.round(c / maxLv * 40)) + 'px"></i>' +
      '<span>L' + i + '</span></div>';
  }).join('') + '</div>';

  const chips = struggling.slice(0, 300).map(function (w) {
    return '<button class="chip stw" data-w="' + esc(w) + '">' + esc(w) + '</button>';
  }).join('');

  $('modal-body').innerHTML =
    '<h2>📊 学习统计</h2>' +
    '<div class="stat-grid">' +
    '<div class="stat-cell"><b>' + streakDays() + '</b><span>连续打卡（天）</span></div>' +
    '<div class="stat-cell"><b>' + totalAll + '</b><span>累计学过（词）</span></div>' +
    '<div class="stat-cell"><b>' + sum + '</b><span>累计刷卡（次）</span></div>' +
    '</div>' +
    '<h3>近 14 天趋势</h3>' + trendHtml() +
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

/* ================= 设置弹窗 ================= */
function openSettings() {
  const s = S.settings;
  $('modal-body').innerHTML =
    '<h2>⚙️ 设置</h2>' +
    '<div class="form-row"><label>每日新词数</label>' +
    '<select id="set-new">' + [10, 20, 30, 50].map(function (v) {
      return '<option value="' + v + '"' + (s.newPerDay === v ? ' selected' : '') + '>' + v + '</option>';
    }).join('') + '</select></div>' +
    '<div class="form-row"><label>学习模式</label>' +
    '<select id="set-mode"><option value="recog"' + (s.mode === 'recog' ? ' selected' : '') + '>识别（看词选义）</option>' +
    '<option value="spell"' + (s.mode === 'spell' ? ' selected' : '') + '>拼写（看义写词）</option>' +
    '<option value="listen"' + (s.mode === 'listen' ? ' selected' : '') + '>听音辨意（听音选义）</option></select></div>' +
    '<div class="form-row"><label>目标记忆率</label>' +
    '<select id="set-ret" title="越高复习越频繁、记得越牢">' +
    [[0.8, '80%（宽松·省时）'], [0.85, '85%'], [0.9, '90%（推荐）'], [0.95, '95%（严格·最牢）']].map(function (o) {
      return '<option value="' + o[0] + '"' + (Number(s.retention || 0.9) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select></div>' +
    '<div class="form-row"><label>自动发音</label>' +
    '<input type="checkbox" id="set-speak"' + (s.autoSpeak ? ' checked' : '') + '></div>' +
    '<div class="form-row"><label>主题</label>' +
    '<select id="set-theme"><option value="auto"' + (s.theme === 'auto' ? ' selected' : '') + '>跟随系统</option>' +
    '<option value="light"' + (s.theme === 'light' ? ' selected' : '') + '>浅色</option>' +
    '<option value="dark"' + (s.theme === 'dark' ? ' selected' : '') + '>深色</option></select></div>' +
    '<h3>应用</h3>' +
    '<div class="actions" style="justify-content:flex-start">' +
    '<button id="set-install" class="big">安装到桌面</button>' +
    '<button id="set-update" class="big" title="清空离线缓存并重新加载">立即更新</button>' +
    '</div>' +
    '<p class="muted" style="margin-top:8px;font-size:12px">版本 v' + APP_VER +
    (location.protocol === 'file:' ? ' · 本地文件模式' : ' · 已支持离线使用') + '</p>' +
    '<h3>数据</h3>' +
    '<div class="actions" style="justify-content:flex-start">' +
    '<button id="set-export" class="big">导出备份</button>' +
    '<button id="set-import" class="big">导入备份</button>' +
    '<button id="set-exportnl" class="big">导出生词本</button>' +
    '<button id="set-reset" class="big danger">清空本书进度</button>' +
    '</div>' +
    '<input type="file" id="set-file" accept="application/json" class="hidden">' +
    '<p class="muted" style="margin-top:12px;font-size:12px">进度保存在浏览器本地（localStorage），换电脑或换浏览器前请先导出备份。答错计入错词本，答对一次错词计数减一，清零后自动移出错词本。</p>';

  $('set-new').addEventListener('change', function (e) {
    S.settings.newPerDay = +e.target.value; save(); buildQueue({});
  });
  $('set-mode').addEventListener('change', function (e) {
    S.settings.mode = e.target.value; save(); renderCard();
  });
  $('set-ret').addEventListener('change', function (e) {
    S.settings.retention = +e.target.value;
    _FSRS = null;          // 参数变了，重建调度器
    save(); renderCard();
    toast('目标记忆率 ' + Math.round(S.settings.retention * 100) + '%：间隔已按新参数调整');
  });
  $('set-speak').addEventListener('change', function (e) {    S.settings.autoSpeak = e.target.checked; save();
  });
  $('set-theme').addEventListener('change', function (e) {
    S.settings.theme = e.target.value; save(); applyTheme();
  });
  $('set-export').addEventListener('click', exportData);
  $('set-install').addEventListener('click', installApp);
  $('set-update').addEventListener('click', function () {
    if (!confirm('将清空离线缓存并重新加载，学习进度不受影响。继续吗？')) return;
    updateCache();
  });
  $('set-exportnl').addEventListener('click', exportNotebook);
  $('set-import').addEventListener('click', function () { $('set-file').click(); });
  $('set-file').addEventListener('change', function (e) {
    if (e.target.files[0]) importData(e.target.files[0]);
  });
  $('set-reset').addEventListener('click', function () {
    if (!confirm('确定清空《' + BOOKS[S.settings.book].name + '》这本书的学习进度吗？此操作不可撤销。')) return;
    for (const it of WORDS) delete S.progress[it[0]];
    save(); buildQueue({}); closeModal();
    toast('已清空本书进度');
  });
  $('modal').classList.remove('hidden');
}

function exportData() {
  const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vocab-drill-backup-' + todayStr() + '.json';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  toast('备份已导出');
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
  a.download = 'vocab-notebook-' + todayStr() + '.txt';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  toast('已导出 ' + lines.length + ' 个生词');
}

function importData(file) {
  const r = new FileReader();
  r.onload = function () {
    try {
      const s = JSON.parse(r.result);
      if (!s || typeof s.progress !== 'object' || typeof s.settings !== 'object') throw new Error('bad');
      if (!confirm('导入将覆盖当前所有进度，确定继续吗？')) return;
      localStorage.setItem(LS_KEY, JSON.stringify(s));
      location.reload();
    } catch (e) { alert('备份文件无效'); }
  };
  r.readAsText(file);
}

function closeModal() { $('modal').classList.add('hidden'); }

/* ================= PWA：离线缓存与安装 ================= */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  installPrompt = e;
});
function registerSW() {
  // file:// 不支持 Service Worker，双击打开时自动跳过（离线本来就成立）
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(function () { /* 注册失败不影响使用 */ });
}
function installApp() {
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
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') {
    location.reload();
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
  sel.innerHTML = Object.keys(BOOKS).map(function (id) {
    return '<option value="' + id + '">' + BOOKS[id].name + '</option>';
  }).join('');
  sel.value = S.settings.book;
  sel.addEventListener('change', function (e) { switchBook(e.target.value); });

  $('mode').addEventListener('click', toggleMode);
  $('btn-stats').addEventListener('click', openStats);
  $('btn-settings').addEventListener('click', openSettings);
  $('modal-x').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) {
    if (e.target === $('modal')) closeModal();
  });
  $('sub-chapters').addEventListener('click', function () { show('books'); });

  document.querySelectorAll('#nav button').forEach(function (b) {
    b.addEventListener('click', function () { show(b.dataset.page); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (!$('modal').classList.contains('hidden')) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') return;

    if (S.page !== 'study') {
      if (e.key === '/') {
        e.preventDefault();
        show('dict');
        $('dict-search').focus();
      } else if (e.key === 'Escape' && S.page !== 'study') {
        show('study');
      }
      return;
    }

    if (S.settings.mode === 'recog') {
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); revealed ? grade(3) : reveal(); }
      else if (e.key === '1') grade(1);
      else if (e.key === '2') grade(2);
      else if (e.key === '3') grade(3);
      else if (e.key.toLowerCase() === 's' && current) speak(current[0]);
      else if (e.key.toLowerCase() === 'f' && current) starCycle(current[0]);
      else if (e.key.toLowerCase() === 'm') toggleMode();
    } else if (S.settings.mode === 'listen') {
      if (!listenAnswered) {
        if (e.key >= '1' && e.key <= '4') { e.preventDefault(); answerListen(+e.key - 1); }
        else if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (current) speak(current[0]); }
        else if (e.key.toLowerCase() === 'm') toggleMode();
      } else if (e.key === 'Enter' || e.code === 'Space' || e.key === ' ') {
        e.preventDefault(); grade(pendingSpell);
      } else if (e.key.toLowerCase() === 'm') {
        toggleMode();
      }
    } else {
      if (e.key === 'Enter') { e.preventDefault(); spellChecked ? grade(pendingSpell) : checkSpell(); }
      else if ((e.code === 'Space' || e.key === ' ') && spellChecked) { e.preventDefault(); grade(pendingSpell); }
      else if (e.key.toLowerCase() === 'm') toggleMode();
    }
  });
}

function toggleMode() {
  const order = ['recog', 'spell', 'listen'];
  S.settings.mode = order[(order.indexOf(S.settings.mode) + 1) % 3];
  save();
  renderCard();
  toast({ recog: '识别模式：看单词想意思', spell: '拼写模式：看释义写单词', listen: '听音辨意：听读音选释义' }[S.settings.mode]);
}

/* ================= 启动 ================= */
(async function init() {
  applyTheme();
  wireUI();
  registerSW();
  try {
    const saved = S.session;
    await buildQueue();
    restoreSession(saved);   // 恢复上次未完成的会话（轮次巩固中途退出也能接续）
    show(S.page);
  } catch (err) {
    show('study');
    $('card').innerHTML = '<p class="bad">词库加载失败：' + esc(err.message) +
      '<br><span class="muted">请确认 data/ 目录完整，且不要单独移动 index.html。</span></p>';
  }
})();
