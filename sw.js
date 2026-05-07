// RadScheduler — service worker
// ─────────────────────────────────────────────────────────────────────────
// Strategy: stale-while-revalidate for the same-origin app shell. Live data
// (Supabase API, Realtime websockets, Maps API, GitHub API) bypasses the
// cache entirely so nothing operational is ever served stale.
//
// Bump CACHE_VERSION when you ship index.html changes so old shells are
// evicted on the next 'activate' event the moment the new SW takes control.

const CACHE_VERSION = 'rs-v1';
const CACHE_NAME = 'radsched-' + CACHE_VERSION;

// The set of URLs we want available offline. Keep this minimal — every new
// entry costs install-time bandwidth on every device.
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.svg',
];

self.addEventListener('install', (e) => {
  // Best-effort cache: a missing icon shouldn't kill the install.
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Only handle same-origin GETs. Anything else (Supabase API, Maps,
  // POST mutations, websockets, GitHub deploy) bypasses the cache.
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((resp) => {
          // Cache successful 200 responses for next visit.
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE_NAME)
              .then((c) => c.put(e.request, copy))
              .catch(() => {});
          }
          return resp;
        })
        .catch(() => cached || Promise.reject(new Error('offline')));

      // stale-while-revalidate: return cached immediately if we have it,
      // refresh in the background.
      return cached || network;
    })
  );
});

// Page-driven cache-bust (used by Settings → Offline Support → Re-check).
self.addEventListener('message', (e) => {
  if (e.data === 'rs:clear-cache') {
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() =>
        self.clients.matchAll().then((cs) =>
          cs.forEach((c) => c.postMessage('rs:cache-cleared'))
        )
      );
  }
});
