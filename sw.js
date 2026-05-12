// RadScheduler — service worker
// ─────────────────────────────────────────────────────────────────────────
// Strategy: stale-while-revalidate for the same-origin app shell. Live data
// (Supabase API, Realtime websockets, Maps API, GitHub API) bypasses the
// cache entirely so nothing operational is ever served stale.
//
// Bump CACHE_VERSION when you ship index.html changes so old shells are
// evicted on the next 'activate' event the moment the new SW takes control.

const CACHE_VERSION = 'rs-v21';
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
      // Tell every open client a new SW version is active so the page
      // can offer to reload (or auto-reload) and pick up the new HTML.
      // Without this, users see a one-cycle delay where the OLD shell
      // is served from cache even though the new SW is installed.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((c) =>
        c.postMessage({ type: 'rs:sw-updated', version: CACHE_VERSION })
      ))
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

// ── Push notifications ──────────────────────────────────────────────
// Display incoming push messages as native browser notifications. The
// server-side push payload (JSON: {title, body, url, tag, persist})
// gets surfaced to the user; clicking focuses an existing RadScheduler
// tab if one's open, or opens a new one to the supplied URL.
self.addEventListener('push', (e) => {
  if (!e.data) return;
  let payload = {};
  try { payload = e.data.json(); }
  catch (_) { payload = { title: 'RadScheduler', body: e.data.text() }; }
  const opts = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'rs-notif',
    data: {
      url: payload.url || '/',
      // Pass through any RadScheduler-specific markers so the
      // notificationclick handler below can route ack actions.
      rsKind:  payload.rsKind  || payload.kind || null,
      rsPhysId: payload.rsPhysId || payload.physId || null,
      rsDate:  payload.rsDate  || payload.date  || null,
    },
    requireInteraction: payload.persist === true || payload.kind === 'oncall-confirmation',
    // For on-call confirmation pushes, surface a tappable action button
    // so the user can confirm without opening the app.
    actions: payload.kind === 'oncall-confirmation'
      ? [{ action: 'oncall-ack', title: '✓ Acknowledge' }]
      : (payload.actions || []),
  };
  e.waitUntil(self.registration.showNotification(payload.title || 'RadScheduler', opts));
});

self.addEventListener('notificationclick', (e) => {
  const action = e.action || '';
  const data = e.notification.data || {};
  e.notification.close();
  // ── On-call acknowledgement path ──────────────────────────────────
  // Either a click on the explicit ✓ Acknowledge action button, or a
  // body-tap when the underlying notification was an on-call reminder.
  // We post back to any open clients so the page can write the audit
  // entry + persist S.onCallAcks. If no client is open we open one to
  // /#dashboard with an `?onCallAck` hint so the page can self-record.
  const isOnCallAck = action === 'oncall-ack' ||
    (data.rsKind === 'oncall-confirmation' && data.rsPhysId && data.rsDate);
  if (isOnCallAck && data.rsPhysId && data.rsDate) {
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.host)) {
            client.postMessage({
              type: 'rs:oncall-ack',
              physId: data.rsPhysId,
              date:   data.rsDate,
            });
            if ('focus' in client) client.focus();
            return;
          }
        }
        // No open tab — open one and let the boot wire-up notice the
        // pending ack via the URL hint.
        if (self.clients.openWindow) {
          const url = (data.url || '/') +
            (data.url && data.url.includes('?') ? '&' : '?') +
            'onCallAck=' + encodeURIComponent(data.rsPhysId + ',' + data.rsDate);
          return self.clients.openWindow(url);
        }
      })
    );
    return;
  }
  // ── Default behavior: focus an existing tab or open a new one ──────
  const targetUrl = data.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.host) && 'focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
