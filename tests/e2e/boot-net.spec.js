// Start-up, network and timer fixes (rs-v139, batch "boot-net").
//
// 1. SheetJS (vendor/xlsx.full.min.js, 882 KB) is no longer downloaded and run
//    at every start: the import/export functions load it on first use. Offline
//    it comes from the service worker's precache; without a copy the importer
//    says so.
// 2. Boot sends the practices lookup and the practice-row download while the
//    admin MFA check is still running — and still applies the row only after
//    the MFA/role gate has decided.
// 3. The dashboard's coverage-gap banner writes an audit row only when the set
//    of gaps differs from the one last logged (still at most once an hour),
//    not on every page load.
// 4. The 5-second sticky-bar / Today-button pass looks only at pages whose DOM
//    changed instead of searching every page every time.
// 5. One periodic update check: the 60-s reg.update() timer is gone; the
//    5-minute _rsUpdateCheck stays.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser, installSyntheticSupabase } = require('./helpers');

const XLSX_URL = /xlsx(\.full)?\.min\.js/;
const PHYS_CSV = { name: 'physicians.csv', mimeType: 'text/csv', buffer: Buffer.from('Last,First\nZedwick,Alpha\n') };
// No request of these tests may reach a real host (production, CDNs).
const blockOutside = context => context.route(/supabase\.co|supabase\.in|radsched\.org|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|esm\.sh/, r => r.abort());

test('SheetJS is not downloaded at start; the export and an import load it once, on first use', async ({ page }) => {
  await blockOutside(page.context());
  const xlsxRequests = [];
  page.on('request', r => { if (XLSX_URL.test(r.url())) xlsxRequests.push(r.url()); });
  await openApp(page);
  await launchSyntheticUser(page, 'admin');
  expect(await page.evaluate(() => typeof window.XLSX)).toBe('undefined');
  expect(xlsxRequests).toEqual([]);

  const download = page.waitForEvent('download');
  await page.evaluate(() => exportScheduleXLSX());
  expect((await download).suggestedFilename()).toMatch(/^RadScheduler-export-.+\.xlsx$/);
  expect(xlsxRequests.length).toBe(1);

  await page.setInputFiles('#xl-phys-file', PHYS_CSV);
  await expect(page.locator('#xl-phys-preview')).toContainText('Zedwick');
  expect(xlsxRequests.length).toBe(1);                                // loaded once, reused
});

test('offline, an import uses the service worker\'s saved SheetJS; with no copy it fails with a clear message', async ({ browser }) => {
  // No worker and the file unreachable: the importer says what is wrong.
  const bare = await browser.newContext();
  await blockOutside(bare);
  const p1 = await bare.newPage();
  await p1.route(XLSX_URL, r => r.abort('internetdisconnected'));
  await openApp(p1);
  await launchSyntheticUser(p1, 'admin');
  await p1.setInputFiles('#xl-phys-file', PHYS_CSV);
  await expect(p1.locator('#xl-phys-preview')).toContainText('The Excel library (SheetJS) could not be loaded');
  await bare.close();

  // With the worker installed: the precached copy serves the import while offline.
  const ctx = await browser.newContext();
  await blockOutside(ctx);
  const p2 = await ctx.newPage();
  await openApp(p2, '/index.html?e2e=1', { serviceWorker: true });
  await p2.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  await expect.poll(() => p2.evaluate(async () => !!(await caches.match('/vendor/xlsx.full.min.js'))), { timeout: 20000 }).toBe(true);
  expect(await p2.evaluate(() => typeof window.XLSX)).toBe('undefined');   // not run at start
  await launchSyntheticUser(p2, 'admin');
  await ctx.setOffline(true);
  const resp = p2.waitForResponse(XLSX_URL);
  await p2.setInputFiles('#xl-phys-file', PHYS_CSV);
  expect((await resp).fromServiceWorker()).toBe(true);
  await expect(p2.locator('#xl-phys-preview')).toContainText('Zedwick');
  await ctx.close();
});

test('boot asks for the practices list and the row while the MFA check runs; the gate still decides before data is applied', async ({ page }) => {
  await blockOutside(page.context());
  await openApp(page);
  await installSyntheticSupabase(page, { aal: 'aal1' });              // an admin who has NOT passed MFA
  const r = await page.evaluate(async () => {
    const log = [];
    const mock = window.__rsMockSupabase;
    const aal = mock.auth.mfa.getAuthenticatorAssuranceLevel;
    mock.auth.mfa.getAuthenticatorAssuranceLevel = async () => {
      log.push('mfa:start'); await new Promise(res => setTimeout(res, 400)); log.push('mfa:end'); return aal();
    };
    const from = mock.from;
    mock.from = function (t) { if (t === 'practices') log.push('practices:start'); return from.call(this, t); };
    _pullFromSupabase = async () => { log.push('row:start'); await new Promise(res => setTimeout(res, 30)); log.push('row:end'); return { _dbSavedAt: null }; };
    _applyRemoteData = () => {
      const adminUiShown = [...document.querySelectorAll('.admin-only')].some(el => el.style.display !== 'none');
      log.push('apply:mfaOk=' + _adminMfaOk() + ',adminUi=' + adminUiShown);
    };
    const base = (USERS || []).find(u => u.role === 'admin') || { id: 'e2e-admin', email: 'admin@example.com' };
    CU = { ...base, role: 'admin', first: base.first || 'E2E', last: base.last || 'Admin', practiceId: 'main' };
    _ROW_ID = 'main'; _PRACTICE_ID = 'main';
    const launch = globalThis.launchApp || Function('return launchApp')();
    launch._running = false;
    await launch();
    return log;
  });
  const at = k => r.indexOf(k);
  expect(at('mfa:end')).toBeGreaterThan(-1);
  expect(at('row:start')).toBeGreaterThan(-1);
  expect(at('row:start')).toBeLessThan(at('mfa:end'));                // overlapped, not after
  expect(at('practices:start')).toBeLessThan(at('mfa:end'));
  const apply = r.filter(x => x.startsWith('apply:'));
  expect(apply).toEqual(['apply:mfaOk=false,adminUi=false']);         // applied once, after the gate decided
  expect(r.findIndex(x => x.startsWith('apply:'))).toBeGreaterThan(at('mfa:end'));
  await expect(page.locator('#rs-admin-mfa-gate')).toBeVisible();
});

test('the coverage-gap banner writes an audit row only when the set of gaps changes (at most hourly), not per load', async ({ page }) => {
  await blockOutside(page.context());
  const gapRows = () => page.evaluate(() => (S.auditLog || []).filter(a => a.action === 'coverage.gap.detected').length);
  await openApp(page);
  await launchSyntheticUser(page, 'admin');
  expect(await page.evaluate(() => (S._coverageGaps || []).length)).toBeGreaterThan(0);
  expect(await gapRows()).toBe(1);                                    // first sight of these gaps on this device
  await page.evaluate(() => { renderDash(); renderDash(); });
  expect(await gapRows()).toBe(1);

  await page.reload({ waitUntil: 'domcontentloaded' });               // a new page load, same gaps
  await page.waitForFunction(() => typeof window.launchApp === 'function' && typeof window.renderSystemHealth === 'function');
  await launchSyntheticUser(page, 'admin');
  expect(await page.evaluate(() => (S._coverageGaps || []).length)).toBeGreaterThan(0);
  expect(await gapRows()).toBe(0);                                    // used to be one row per load

  await page.evaluate(() => {                                         // the gaps change: a holiday nobody covers
    const ds = addDays(fmtDate(new Date()), 3);
    S.holidays.push({ id: 990001, date: ds, name: 'E2E Holiday', year: +ds.slice(0, 4), physId: null, group: 'DR' });
    renderDash();
  });
  expect(await gapRows()).toBe(0);                                    // still within the hour of the last row
  await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 2 * 3600 * 1000; renderDash(); renderDash(); });
  expect(await gapRows()).toBe(1);                                    // an hour later: the changed set is logged, once
});

test('the 5-second sticky-bar pass looks only at pages whose DOM changed, and still does its job', async ({ page }) => {
  await blockOutside(page.context());
  await page.addInitScript(() => {
    // Take the pass out of its 5-s timer so the test can run it on demand, and
    // count the per-page searches it makes.
    const si = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) {
      if (typeof fn === 'function' && ms === 5000 && /rs-sticky-bar/.test(String(fn))) { window.__stickyPass = fn; return si.call(window, () => {}, 3600000); }
      return si.call(window, fn, ms, ...rest);
    };
    window.__monthScans = [];
    const q = Element.prototype.querySelector;
    Element.prototype.querySelector = function (sel) { if (sel === 'input[type="month"]') window.__monthScans.push(this.id || '?'); return q.call(this, sel); };
  });
  await openApp(page);
  await launchSyntheticUser(page, 'admin');
  const pass = () => page.evaluate(() => { window.__monthScans.length = 0; window.__stickyPass(); return window.__monthScans.slice(); });
  await pass();                                                       // catch up with everything boot drew
  expect(await page.locator('#page-dr-cal .rs-sticky-bar').count()).toBe(1);
  expect(await pass()).toEqual([]);                                   // nothing changed → nothing searched

  await page.evaluate(() => document.getElementById('page-fte').appendChild(document.createElement('div')));
  expect([...new Set(await pass())]).toEqual(['page-fte']);           // one page changed → only it is searched

  await page.evaluate(() => document.querySelector('#page-dr-cal .rs-sticky-bar').classList.remove('rs-sticky-bar'));
  await pass();
  expect(await page.locator('#page-dr-cal .rs-sticky-bar').count()).toBe(1);   // still re-applied

  await page.evaluate(() => {                                         // a brand-new page appears
    const pg = document.createElement('div'); pg.className = 'page'; pg.id = 'page-dr-weekends-e2e';
    pg.innerHTML = '<div class="flexe"><input type="month"></div>';
    document.getElementById('page-fte').parentNode.appendChild(pg);
  });
  const scanned = await pass();
  expect(scanned).toContain('page-dr-weekends-e2e');
  expect(await page.locator('#page-dr-weekends-e2e .flexe.rs-sticky-bar').count()).toBe(1);
});

test('one periodic update check: the 60-second timers make no service-worker update, the 5-minute one checks once', async ({ page }) => {
  await blockOutside(page.context());
  await page.addInitScript(() => {
    window.__intervals = [];
    const si = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) { if (typeof fn === 'function') window.__intervals.push({ fn, ms }); return si.call(window, fn, ms, ...rest); };
    window.__swUpdates = 0;
    const up = ServiceWorkerRegistration.prototype.update;
    ServiceWorkerRegistration.prototype.update = function () { window.__swUpdates++; return up.apply(this, arguments); };
  });
  const buildChecks = [];
  page.on('request', r => { if (/\/sw\.js\?_=/.test(r.url()) && r.method() === 'GET') buildChecks.push(r.url()); });
  await openApp(page, '/index.html?e2e=1', { serviceWorker: true });
  await page.waitForFunction(() => window.__swUpdates >= 1, null, { timeout: 20000 });     // the one check on this page load
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  await expect.poll(() => buildChecks.length, { timeout: 10000 }).toBeGreaterThanOrEqual(1);  // _rsUpdateCheck('boot')
  await page.waitForTimeout(500);

  // One tick of every 60-second timer: none of them may ask for a worker update.
  const n60 = await page.evaluate(() => { const due = window.__intervals.filter(i => i.ms === 60000); due.forEach(i => { try { i.fn(); } catch (_) {} }); return due.length; });
  expect(n60).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__swUpdates)).toBe(1);

  // One tick of the 5-minute timer: exactly one look at the server's build.
  const before = buildChecks.length;
  await page.evaluate(() => { window.__intervals.filter(i => i.ms === 5 * 60 * 1000).forEach(i => i.fn()); });
  await expect.poll(() => buildChecks.length - before, { timeout: 10000 }).toBe(1);
  await page.waitForTimeout(500);
  expect(buildChecks.length - before).toBe(1);
  expect(await page.evaluate(() => typeof _RS_HTML_BUILD === 'string' && !document.getElementById('rs-reload-halt'))).toBe(true);
});
