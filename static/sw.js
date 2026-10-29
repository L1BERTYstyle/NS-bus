// Service worker: кэширует оболочку приложения, данные API всегда берутся из сети.
const CACHE = 'nsbus-v4';
const SHELL = ['./', 'index.html', 'app.css', 'i18n.js', 'app.js', 'vendor/leaflet.js', 'vendor/leaflet.css', 'icon.svg', 'manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.startsWith('/api/') || e.request.method !== 'GET') return;
  // network-first: свежая версия, при отсутствии сети — из кэша
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
