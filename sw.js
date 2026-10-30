/* 单词速刷 Service Worker —— 离线缓存（仅 http/https 生效，file:// 不注册）
 *
 * 两个缓存分开，避免为了更新代码重下 3.4MB 词库：
 *   SHELL（shell）: html/css/js/manifest/图标，安装时预缓存，带重试
 *   DATA （data） : data/*.js 词库（每个 1.6~1.8MB），首次访问时按需缓存（stale-while-revalidate）
 *
 * 策略：
 *   - 页面导航：network-first（先拿新版，断网回退缓存）
 *   - data/*.js：stale-while-revalidate，写 DATA 缓存
 *   - 其余静态资源：stale-while-revalidate，写 SHELL 缓存
 * 升级资源后务必同时改这里的 VER 和 app.js 的 APP_VER。
 */
const VER = '3.4.0';
const SHELL = 'vd-shell-' + VER;
const DATA = 'vd-data-' + VER;

const CORE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/vendor/fsrs.global.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

async function precache(c) {
  // 逐个重试：GitHub Pages 偶发连接中断，一张失败不该拖垮整个安装
  await Promise.all(CORE.map(async function (u) {
    for (let i = 0; i < 3; i++) {
      try { await c.add(new Request(u, { cache: 'reload' })); return; } catch (e) { /* retry */ }
    }
  }));
}

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    await precache(await caches.open(SHELL));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      const ours = k.indexOf('vd-shell-') === 0 || k.indexOf('vd-data-') === 0;
      return (ours && k !== SHELL && k !== DATA) ? caches.delete(k) : null;
    }));
    await self.clients.claim();
  })());
});

async function networkFirst(req) {
  const c = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res && res.ok) c.put('./index.html', res.clone());
    return res;
  } catch (err) {
    return (await c.match(req)) || (await c.match('./index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(req, name) {
  const c = await caches.open(name);
  const cached = await c.match(req);
  const updating = fetch(req).then(function (res) {
    if (res && res.ok) c.put(req, res.clone());
    return res;
  }).catch(function () { return null; });
  return cached || (await updating) || Response.error();
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域（发音等）不拦
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
  const isData = /\/data\/[^/]+\.js$/.test(url.pathname);
  e.respondWith(staleWhileRevalidate(req, isData ? DATA : SHELL));
});

// 设置页「立即更新」：清缓存后由页面自行刷新
self.addEventListener('message', function (e) {
  if (e.data === 'clear') {
    e.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }));
  }
});
