// Update-lifecycle regressions (rs-v126).
//
// How an open or returning tab moves to a newly deployed build has broken in
// three different ways (reload loop → "Update loop detected" halt → tabs that
// never update while their version pill says they are current). These tests
// replay real deploys: a small server that behaves like the production host
// serves THIS working tree under two different version numbers, and
// "deploying" is switching which one it serves.
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const OLD = 'rs-v9001';
const NEW = 'rs-v9002';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function labelled(version) {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  let sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  html = html.replace(/(const _SW_VERSION = ')rs-v\d+(';)/, `$1${version}$2`).replace(/(const _RS_HTML_BUILD = ')rs-v\d+(';)/, `$1${version}$2`);
  sw = sw.replace(/(const CACHE_VERSION = ')rs-v\d+(';)/, `$1${version}$2`);
  return { html: Buffer.from(html), sw: Buffer.from(sw) };
}

// Mimics the host: /index.html → 308 /, /reset → reset.html (+ its headers),
// unknown paths → the app (SPA rewrite), max-age=0 + ETag/304.
function startHost() {
  const builds = { [OLD]: labelled(OLD), [NEW]: labelled(NEW) };
  const state = { live: OLD, html: null };            // html: pin the page to a build regardless of `live`
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    const send = (body, type, extra = {}) => {
      const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
      const headers = Object.assign({ 'Content-Type': type, ETag: etag, 'Cache-Control': 'public, max-age=0, must-revalidate' }, extra);
      if (req.headers['if-none-match'] === etag && !extra['Cache-Control']) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (p === '/index.html') { res.writeHead(308, { Location: '/' + u.search }); return res.end(); }
    if (p === '/sw.js') return send(builds[state.live].sw, TYPES['.js']);
    if (p === '/reset') {
      const extra = { 'Cache-Control': 'no-store' };
      if (u.searchParams.get('full') === '1') extra['Clear-Site-Data'] = '"storage"';
      return send(fs.readFileSync(path.join(ROOT, 'reset.html')), TYPES['.html'], extra);
    }
    const file = path.join(ROOT, p);
    if (p !== '/' && file.startsWith(ROOT + path.sep) && /^\/(vendor|icons)\/|^\/manifest\.webmanifest$/.test(p) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    }
    return send(builds[state.html || state.live].html, TYPES['.html']);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://localhost:${server.address().port}/`,
    deploy(v) { state.live = v; },
    pinHtml(v) { state.html = v; },
    close: () => new Promise(r => server.close(r)),
  })));
}

let host;
test.beforeAll(async () => { host = await startHost(); });
test.afterAll(async () => { await host.close(); });
test.beforeEach(() => { host.deploy(OLD); host.pinHtml(null); });

async function open(context, url = host.url) {
  const page = await context.newPage();
  page.loads = 0;
  page.on('domcontentloaded', () => { if (!/^about:/.test(page.url())) page.loads++; });
  await page.goto(url);
  return page;
}
const running = page => page.evaluate(() => (typeof _RS_HTML_BUILD !== 'undefined' ? _RS_HTML_BUILD : null)).catch(() => null);
// The worker for `version` is installed and the previous one is gone.
const workerIs = (page, version) => expect.poll(() => page.evaluate(async v => {
  const keys = await caches.keys();
  const reg = await navigator.serviceWorker.getRegistration();
  return keys.length === 1 && keys[0] === 'radsched-' + v && !!(reg && reg.active) && !reg.installing && !reg.waiting;
}, version).catch(() => false), { timeout: 25000 }).toBe(true);
const checkForWorkerUpdate = page => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r && r.update())).catch(() => {});
const hide = page => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const useTheTab = async page => { await page.mouse.click(8, 8); await page.keyboard.press('Shift'); };
const quietFor = (page, ms) => page.waitForTimeout(ms);

test('a first visit and a returning visit after a deploy each load exactly once', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await open(context);
  await workerIs(first, OLD);
  await quietFor(first, 3000);
  expect(first.loads).toBe(1);
  await expect(first.locator('#rs-sw-update')).toHaveCount(0);      // no "new version" notice for the version you are on
  await first.close();

  host.deploy(NEW);
  const back = await open(context);
  await workerIs(back, NEW);
  await quietFor(back, 6000);
  expect(await running(back)).toBe(NEW);
  expect(back.loads).toBe(1);                                         // used to be 2: a reload for HTML that was already fresh
  await expect(back.locator('#rs-sw-update')).toHaveCount(0);
  await expect(back.locator('#rs-reload-halt')).toHaveCount(0);
  await context.close();
});

test('a tab in use is not reloaded by a deploy; the notice updates it on click', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  await workerIs(page, OLD);
  await useTheTab(page);
  host.deploy(NEW);
  await checkForWorkerUpdate(page);
  await expect(page.locator('#rs-sw-update')).toContainText(NEW, { timeout: 25000 });
  await quietFor(page, 5000);
  expect(page.loads).toBe(1);                                         // nothing happened behind the user's back
  expect(await running(page)).toBe(OLD);
  await page.locator('#rs-sw-update-reload').click();
  await expect.poll(() => running(page), { timeout: 15000 }).toBe(NEW);
  expect(new URL(page.url()).search).toBe('');                        // the cache-bust marker does not linger in the address bar
  await context.close();
});

test('an idle hidden tab moves to the new build by itself — even one loaded without a controlling worker', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  await workerIs(page, OLD);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.reload', { ignoreCache: true });              // hard reload: the page is NOT controlled by the worker
  await page.waitForFunction(() => typeof _rsUpdateCheck === 'function');
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);
  const before = page.loads;
  await hide(page);
  host.deploy(NEW);
  await page.evaluate(() => { _rsUpdateCheck('test'); });             // what the 5-minute timer does; no worker event involved
  await expect.poll(() => running(page), { timeout: 30000 }).toBe(NEW);
  await quietFor(page, 5000);
  expect(page.loads - before).toBe(1);                                // one move, not a loop
  await expect(page.locator('#rs-reload-halt')).toHaveCount(0);
  await context.close();
});

test('if the server keeps serving the old page, the tab retries once, says so, and never halts', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await open(context);
  await workerIs(first, OLD);
  await first.close();

  host.deploy(NEW);
  host.pinHtml(OLD);                                                  // sw.js is new, the page stays old: a stuck edge
  const page = await open(context);
  await expect(page.locator('#rs-sw-update')).toContainText(NEW, { timeout: 30000 });
  await quietFor(page, 12000);
  expect(page.loads).toBeLessThanOrEqual(2);                          // the first load + at most one automatic retry
  expect(await running(page)).toBe(OLD);
  await expect(page.locator('#rs-reload-halt')).toHaveCount(0);

  host.pinHtml(null);                                                 // the edge catches up; the notice is the way forward
  await page.locator('#rs-sw-update-reload').click();
  await expect.poll(() => running(page), { timeout: 15000 }).toBe(NEW);
  await context.close();
});

test('the reset page clears the worker and caches, keeps the sign-in, and returns to the app', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  await workerIs(page, OLD);
  await page.evaluate(() => {
    localStorage.setItem('rs.e2e.signin', 'kept');
    sessionStorage.setItem('rs.reloadTimes', '[1,2,3]');
    sessionStorage.setItem('rs.upd.rs-vX', '{"n":3,"t":1}');
  });

  await page.goto(host.url + 'reset?stay=1');
  await expect(page.locator('#title')).toHaveText('Reset complete', { timeout: 30000 });
  const after = await page.evaluate(async () => ({
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    caches: (await caches.keys()).length,
    guards: Object.keys(sessionStorage).filter(k => /^rs\.(reloadTimes|autoHeal|upd)/.test(k)).length,
    signin: localStorage.getItem('rs.e2e.signin'),
  }));
  expect(after).toEqual({ workers: 0, caches: 0, guards: 0, signin: 'kept' });

  await page.goto(host.url + 'reset');                                // without ?stay it continues into the app
  await expect.poll(() => running(page), { timeout: 30000 }).toBe(OLD);
  expect(new URL(page.url()).pathname).toBe('/');

  await page.goto(host.url + 'reset?full=1&stay=1');
  await expect(page.locator('#title')).toHaveText('Reset complete', { timeout: 30000 });
  expect(await page.evaluate(() => localStorage.getItem('rs.e2e.signin'))).toBeNull();
  await context.close();
});
