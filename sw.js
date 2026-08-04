// RadScheduler — service worker
// ─────────────────────────────────────────────────────────────────────────
// Strategy: stale-while-revalidate for the same-origin app shell. Live data
// (Supabase API, Realtime websockets, Maps API, GitHub API) bypasses the
// cache entirely so nothing operational is ever served stale.
//
// Bump CACHE_VERSION when you ship index.html changes so old shells are
// evicted on the next 'activate' event the moment the new SW takes control.

const CACHE_VERSION = 'rs-v118';
const CACHE_NAME = 'radsched-' + CACHE_VERSION;

// The set of URLs we want available offline. Keep this minimal — every new
// entry costs install-time bandwidth on every device.
// Self-hosted runtime deps (audit fix 2026-07): supabase-js is required to
// boot/login; xlsx for import. Precached so the app works offline and cannot
// be broken by a CDN-blocking network. Served same-origin via the handler below.
// NOTE: keep this array string-literals only (the smoke-check scans it by regex).
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.svg',
  '/vendor/supabase.js',
  '/vendor/xlsx.full.min.js',
];

// Third-party runtime dependencies the app needs to BOOT. They load
// parser-blocking from CDNs; without caching, a CDN outage or an offline
// launch left the app unable to start at all (audit fix 2026-07). Both CDNs
// send CORS headers, so we can precache real (non-opaque) responses and serve
// them cache-first. Keep these version-pinned so a silent upstream bump can't
// poison the cache. Update in lockstep with the <script src> tags in index.html.
const CDN_DEPS = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];
const CDN_HOSTS = new Set(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net']);

self.addEventListener('install', (e) => {
  // Best-effort cache: a missing icon or a CDN hiccup shouldn't kill install.
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.all([
        ...SHELL.map((u) => c.add(u).catch(() => {})),
        ...CDN_DEPS.map((u) => fetch(u, { mode: 'cors' })
          .then((r) => (r && r.ok) ? c.put(u, r) : null).catch(() => null)),
      ]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) =>
        // Old-version caches: delete entirely. CURRENT cache: REFRESH the HTML
        // shell from the network (audit fix 2026-07) instead of DELETING it.
        // Deleting the shell prevented a stale shell being served, but it also
        // left NO offline fallback — an offline launch right after a deploy had
        // no shell at all and showed the browser error page. Refreshing keeps a
        // shell available offline while guaranteeing it is the fresh one;
        // network-first still fetches live when online. If the refresh fails
        // (offline during activate), the existing shell stays as the fallback.
        k !== CACHE_NAME
          ? caches.delete(k)
          : caches.open(k).then((c) => Promise.all(['/', '/index.html'].map((u) =>
              fetch(u, { cache: 'no-store' })
                .then((r) => (r && r.status === 200 && r.type === 'basic') ? c.put(u, r.clone()) : null)
                .catch(() => null)
            ))).catch(() => {})
      )))
      .then(() => self.clients.claim())
      // Tell every open client a new SW version is active so the page
      // can offer to reload (or auto-reload) and pick up the new HTML.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((c) =>
        c.postMessage({ type: 'rs:sw-updated', version: CACHE_VERSION })
      ))
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;

  // ── Boot-critical CDN deps (xlsx, supabase-js): CACHE-FIRST ──
  // Serve the precached copy so the app can start during a CDN outage or an
  // offline launch (audit fix 2026-07). Revalidate in the background so a
  // version-pinned bump still lands eventually. Never blocks boot on the network.
  if (CDN_HOSTS.has(url.hostname)) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const net = fetch(e.request).then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return resp;
        }).catch(() => cached || Promise.reject(new Error('offline')));
        return cached || net;
      })
    );
    return;
  }

  // Only handle same-origin GETs. Anything else (Supabase API, Maps,
  // POST mutations, websockets, GitHub deploy) bypasses the cache.
  if (url.origin !== self.location.origin) return;

  // ── NEVER serve OR cache sw.js itself ──
  // Audit fix (rs-v71): the build-pill displayed an old version
  // string even after a fresh deploy because the SW's general
  // fetch handler was caching sw.js on first load, then returning
  // the cached copy whenever the page asked. That made the page's
  // version check (`fetch('/sw.js')`) read the OLD version string,
  // and the page never realized a new SW was available. sw.js MUST
  // hit the network so the browser's SW-update plumbing — which
  // does its own cache-busting via updateViaCache:'none' — can
  // detect new builds.
  if (url.pathname === '/sw.js' || url.pathname.endsWith('/sw.js')){
    return; // let the browser handle it directly (no SW intercept)
  }

  // ── Navigation / HTML shell: NETWORK-FIRST ──
  // The HTML shell (index.html, / ) used to be stale-while-revalidate,
  // which meant a force-reload kept showing the OLD page from cache
  // while the new version was fetched silently for "next time". Users
  // would force-reload three or four times before seeing a deploy.
  // Network-first means: when online, the user always gets the
  // freshest shell on the very first reload. Cache is the offline
  // fallback only.
  const isNavigation = e.request.mode === 'navigate'
    || (e.request.destination === 'document')
    || url.pathname === '/'
    || url.pathname.endsWith('/index.html');
  if (isNavigation) {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then((cached) => cached || Promise.reject(new Error('offline'))))
    );
    return;
  }

  // ── Static assets: stale-while-revalidate (manifest, icons, etc.) ──
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached || Promise.reject(new Error('offline')));
      return cached || network;
    })
  );
});

// Page-driven cache-bust (used by Settings → Offline Support → Re-check)
// and skip-waiting (used by the auto-update flow on the page side —
// when the page detects a new SW reached "installed" while we still
// have a controller, it posts {type:'rs:skip-waiting'} so the new SW
// activates immediately, fires 'controllerchange' on the page, and
// the page reloads on the fresh shell).
self.addEventListener('message', (e) => {
  const data = e.data;
  if (data === 'rs:clear-cache') {
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() =>
        self.clients.matchAll().then((cs) =>
          cs.forEach((c) => c.postMessage('rs:cache-cleared'))
        )
      );
    return;
  }
  if (data && data.type === 'rs:skip-waiting') {
    self.skipWaiting();
    return;
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
        // AUDIT FIX (2026-07 deep dive): build the URL via the URL API so the
        // query lands BEFORE the hash. data.url is '/#dashboard'; naive string
        // concat produced '/#dashboard?onCallAck=...', where the param is part
        // of the FRAGMENT — page-side searchParams.get('onCallAck') returned
        // null and the acknowledgment was silently dropped. URL.searchParams
        // places the query correctly (/?onCallAck=...#dashboard).
        if (self.clients.openWindow) {
          const u = new URL(data.url || '/', self.location.origin);
          u.searchParams.set('onCallAck', data.rsPhysId + ',' + data.rsDate);
          return self.clients.openWindow(u.toString());
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
