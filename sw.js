/* 单词速刷 Service Worker —— 离线缓存（仅 http/https 生效，file:// 不注册）
 * 策略：
 *   - 页面导航：network-first（先拿新版，断网回退缓存）
 *   - 静态资源（css/js/data/图标）：stale-while-revalidate（先用缓存秒开，后台更新）
 * 升级资源后务必改 VER，旧缓存会在 activate 时清掉。
 */
const VER = '3.0.0';
const SHELL = 'vd-shell-' + VER;

const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/vendor/fsrs.global.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './data/cet6.js',
  './data/kaoyan.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    const c = await caches.open(SHELL);
    // 逐个装，单个 404 不拖垮整个安装；cache:'reload' 绕过 HTTP 缓存拿真·最新
    await Promise.all(PRECACHE.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () { /* 缺失项忽略 */ });
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      return (k !== SHELL && k.indexOf('vd-shell-') === 0) ? caches.delete(k) : null;
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

async function staleWhileRevalidate(req) {
  const c = await caches.open(SHELL);
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
  if (url.origin !== self.location.origin) return;   // 第三方（如发音）不拦
  if (req.mode === 'navigate') e.respondWith(networkFirst(req));
  else e.respondWith(staleWhileRevalidate(req));
});

// 设置页「立即更新」：清缓存后由页面自行刷新
self.addEventListener('message', function (e) {
  if (e.data === 'clear') {
    e.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }));
  }
});
