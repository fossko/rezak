// Carver service worker: makes the app open offline after the first visit.
//  - the page itself: network first (always the newest deployed version when online), cache as fallback
//  - hashed build assets (/assets/*: JS, workers, ONNX runtime .wasm): cache first (names change on every build)
// Model weights are cached separately by Transformers.js (Cache API "transformers-cache").
const SHELL = 'carver-shell-v1';
const ASSETS = 'carver-assets-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('carver-') && k !== SHELL && k !== ASSETS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith((async () => {
      try {
        const resp = await fetch(req);
        if (resp.ok) { const c = await caches.open(SHELL); await c.put('index', resp.clone()); }
        return resp;
      } catch {
        return (await (await caches.open(SHELL)).match('index')) || Response.error();
      }
    })());
    return;
  }
  if (url.pathname.includes('/assets/')) {
    e.respondWith((async () => {
      const c = await caches.open(ASSETS);
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const resp = await fetch(req);
      if (resp.ok && resp.type === 'basic') c.put(req, resp.clone()).catch(() => {});
      return resp;
    })());
  }
});
