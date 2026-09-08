// sw.js — سرویس‌ورکر ساده برای حالت PWA.
// نکته: مسیرهای /api هرگز کش نمی‌شوند (داده زنده جستجو/رزرو)؛ فقط فایل‌های
// استاتیک رابط کاربری به‌صورت شبکه‌اول (network-first) کش می‌شوند تا در صورت
// قطعی موقت، صفحه باز شود.
const CACHE = 'bilitfast-v1';
const CORE = [
  'index.html', 'route.html', 'login.html', 'account.html',
  'history.html', 'settings.html', 'trial.html', 'learn.html',
  'style.css', 'app.js', 'datepicker.js', 'jalaali.min.js',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // API و هر چیز غیر استاتیک همیشه مستقیم به شبکه می‌رود.
  if (url.pathname.startsWith('/api/')) return;
  if (!url.pathname.startsWith('/') || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('index.html')))
  );
});
