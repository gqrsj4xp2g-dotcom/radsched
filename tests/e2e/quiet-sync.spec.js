// Quiet sync (rs-v138).
//
// Loading the app, and receiving any update from another tab or device, ended in
// an automatic whole-row save plus a full re-upload of the shift mirror with
// nobody touching anything: the holiday re-sync that runs inside every remote
// apply re-filtered S.drShifts into a new array and removed + re-added every IR
// holiday call with a NEW id (nextId +10 per load). Two open sessions then saved
// back and forth for as long as both stayed open.
//
// These tests run the REAL app against the shared mock backend of
// sync-conflict.spec.js (localStorage row, atomic compare-and-swap,
// PostgREST-style timestamps, realtime echo, oversize stripping) — extended to
// count the shift-mirror writes — with live (not 'Imported history') DR and IR
// holiday assignments whose calendar side is already in step.
const { test, expect } = require('@playwright/test');
const { openApp } = require('./helpers');

function installMock() {
  const KEY = '__mock.radscheduler.';
  const lat = (a, b) => new Promise(r => setTimeout(r, a + Math.random() * (b - a)));
  const pgTs = ms => {
    if (ms == null) return null;
    const iso = new Date(ms).toISOString();
    const frac = iso.slice(20, 23).replace(/0+$/, '');
    return iso.slice(0, 19) + (frac ? '.' + frac : '') + '+00:00';
  };
  const readRow = id => { try { return JSON.parse(localStorage.getItem(KEY + id) || 'null'); } catch (_) { return null; } };
  const stats = window.__mockStats = { savedAtGets: 0, fullGets: 0, cas: 0, casOk: 0, casConflict: 0, toasts: 0,
    mirrorPosts: 0, mirrorRows: 0, mirrorIds: [], mirrorDeletes: [] };
  const rtOut = new BroadcastChannel('__mock_realtime');
  const emit = id => {
    if (window.__mockRtMute) return;            // test switch: this device misses the event
    const r = readRow(id); if (!r) return;
    // __mockRtOversize: what Realtime sends once a change passes its 1,024 KB
    // cap (production: the old + new row) — the data is stripped; id + saved_at remain.
    const msg = window.__mockRtOversize
      ? { id, saved_at: pgTs(r.saved_at_ms) }
      : { id, data: r.data, saved_at: pgTs(r.saved_at_ms) };
    rtOut.postMessage(msg);
  };
  window.__mockExternalWrite = (id, mutate) => {
    const r = readRow(id); const d = JSON.parse(r.data); mutate(d);
    const ms = Date.now(); d.savedAt = new Date(ms).toISOString(); d._originTab = 'external-device';
    localStorage.setItem(KEY + id, JSON.stringify({ data: JSON.stringify(d), saved_at_ms: ms }));
    emit(id);
  };
  window.__mockSeed = (id, dataStr, ms) => localStorage.setItem(KEY + id, JSON.stringify({ data: dataStr, saved_at_ms: ms }));
  window.__mockRow = id => { const r = readRow(id); return r ? { saved_at: pgTs(r.saved_at_ms), data: JSON.parse(r.data) } : null; };

  const q = table => {
    let cols = '*', id = null;
    const api = {
      select(c) { cols = c || '*'; return api; },
      eq(col, v) { if (col === 'id') id = v; return api; },
      order() { return api; }, limit() { return api; }, gte() { return api; }, lte() { return api; },
      in() { return api; }, neq() { return api; }, is() { return api; }, range() { return api; },
      async single() {
        if (table !== 'radscheduler') { await lat(20, 50); return { data: null, error: { code: 'PGRST116', message: 'no rows' } }; }
        const wantsData = /(^|,)\s*data\s*(,|$)/.test(cols) || cols === '*';
        if (wantsData) { stats.fullGets++; await lat(80, 160); } else { stats.savedAtGets++; await lat(40, 80); }
        const r = readRow(id);
        if (!r) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        const out = {};
        if (wantsData) out.data = r.data;
        if (/saved_at/.test(cols) || cols === '*') out.saved_at = pgTs(r.saved_at_ms);
        return { data: out, error: null };
      },
      async maybeSingle() { const r = await api.single(); return { data: r.data, error: null }; },
      then(res, rej) { return lat(20, 50).then(() => ({ data: [], error: null })).then(res, rej); },
    };
    return api;
  };
  const mock = {
    from(table) {
      return Object.assign(q(table), {
        insert: async () => { await lat(20, 50); return { data: null, error: null }; },
        upsert: async rows => {
          if (table === 'radscheduler_shifts') {
            const list = Array.isArray(rows) ? rows : [rows];
            stats.mirrorPosts++; stats.mirrorRows += list.length;
            list.forEach(x => stats.mirrorIds.push(x.kind + ':' + x.client_id));
          }
          await lat(20, 50); return { data: null, error: null };
        },
        update() { return { eq: async () => ({ data: null, error: null }) }; },
        delete() {
          let kind = null;
          const done = () => lat(20, 50).then(() => ({ data: null, error: null }));
          const chain = {
            eq(col, v) { if (col === 'kind') kind = v; return chain; },
            in(_col, ids) { if (table === 'radscheduler_shifts') ids.forEach(x => stats.mirrorDeletes.push(kind + ':' + x)); return done(); },
            then(res, rej) { return done().then(res, rej); },
          };
          return chain;
        },
      });
    },
    async rpc(name, args = {}) {
      if (name !== 'rs_save_practice_cas') { await lat(20, 50); return { data: null, error: null }; }
      stats.cas++;
      await lat(200, 320);
      const id = args.p_practice, r = readRow(id);           // atomic from here (sync)
      const cur = r ? r.saved_at_ms : null;
      const exp = args.p_expected_saved_at == null ? null : Date.parse(args.p_expected_saved_at);
      if (cur !== exp) { stats.casConflict++; return { data: { ok: false, conflict: true, current_saved_at: pgTs(cur) }, error: null }; }
      let ms = Date.now(); try { const t = Date.parse(JSON.parse(args.p_data).savedAt); if (!isNaN(t)) ms = t; } catch (_) {}
      localStorage.setItem(KEY + id, JSON.stringify({ data: args.p_data, saved_at_ms: ms }));
      stats.casOk++;
      setTimeout(() => emit(id), 70);
      return { data: { ok: true, saved_at: pgTs(ms) }, error: null };
    },
    channel() {
      const subs = []; let rtIn = null;
      const ch = {
        on(_evt, _filter, cb) { if (typeof cb === 'function') subs.push(cb); return ch; },
        subscribe(statusCb) {
          rtIn = new BroadcastChannel('__mock_realtime');
          const deliver = m => setTimeout(() => subs.forEach(cb => { try { cb({ eventType: 'UPDATE', new: m }); } catch (_) {} }), 90);
          rtIn.onmessage = ev => deliver(ev.data);
          setTimeout(() => { try { statusCb && statusCb('SUBSCRIBED'); } catch (_) {} }, 40);
          return ch;
        },
        unsubscribe() { try { rtIn && rtIn.close(); } catch (_) {} return Promise.resolve('ok'); },
        track: async () => {}, untrack: async () => {}, send: async () => {}, presenceState: () => ({}),
      };
      return ch;
    },
    removeChannel: async c => { try { c && c.unsubscribe && c.unsubscribe(); } catch (_) {} },
    functions: { invoke: async () => ({ data: null, error: { message: 'mock' } }) },
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
        listFactors: async () => ({ data: { totp: [{ id: 'e2e-totp', factor_type: 'totp', status: 'verified' }] }, error: null }),
      },
    },
  };
  _supabase = mock;
  _initSupabase = () => mock;
  _initAuthClient = () => mock;
  doLogout = async () => {};
  _initPresence = () => {};
  _startAutoRefreshTrafficLoop = () => {};
  _bootOnCallReminders = () => {};
  fsTryRestoreAutosave = () => {};
  _runDailyBackupIfDue = () => {};
  if (typeof _prBootWatcher === 'function') _prBootWatcher = () => {};
  const realToast = _toast;
  _toast = function () { stats.toasts++; return realToast.apply(this, arguments); };
}

// Runs in the page: a practice whose holiday call is already reflected on the
// calendars, exactly as the holiday sync leaves it. July 4 2027: Thu 07-01 (an
// IR daily call), Sat 07-03 and Mon 07-05 (both filed on the North weekend that
// starts Fri 07-02 — the assignment processed last, Pine's, holds that call).
// opts.drift: the calendar is out of step — Ash's daily holiday call is missing
// and Birch works a hospital shift on Oak's DR holiday.
function seedPractice(opts) {
  opts = opts || {};
  _isRestoring = true;
  const base = { first: 'T', drSubs: [], irSubs: [], address: '', shiftElig: { s1: true, wknd: true }, irCallBlackouts: [],
    siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [] };
  S.irGroups = ['North'];
  S.sites = [{ name: 'At Home / Remote', irGroup: null, irAnchors: [], irFillins: [] },
    { name: 'CHN', irGroup: null, irAnchors: [], irFillins: [] },
    { name: 'North Hosp', irGroup: 'North', irAnchors: [], irFillins: [] }];
  S.physicians = [
    Object.assign({}, base, { id: 101, last: 'Oak', role: 'DR', drFte: 1, irFte: 0, irGroup: null }),
    Object.assign({}, base, { id: 102, last: 'Birch', role: 'DR', drFte: 1, irFte: 0, irGroup: null }),
    Object.assign({}, base, { id: 201, last: 'Ash', role: 'IR', drFte: 0, irFte: 1, irGroup: 'North', irSitePrim: 'North Hosp' }),
    Object.assign({}, base, { id: 202, last: 'Elm', role: 'IR', drFte: 0, irFte: 1, irGroup: 'North', irSitePrim: 'North Hosp' }),
    Object.assign({}, base, { id: 203, last: 'Pine', role: 'IR', drFte: 0, irFte: 1, irGroup: 'North', irSitePrim: 'North Hosp' }),
  ];
  S.holidayDefs = [
    { id: 901, name: 'July 4', year: 2027, dates: ['2027-07-01', '2027-07-03', '2027-07-05'], drSlots: 1, irSlotsByGroup: { North: 1 }, notes: '' },
    { id: 902, name: 'Christmas', year: 2026, dates: ['2026-12-25'], drSlots: 1, irSlotsByGroup: { North: 1 }, notes: '' },
  ];
  S.holidays = [
    { id: 301, name: 'July 4', year: 2027, date: '2027-07-05', physId: 101, group: 'DR', notes: 'Auto-lottery (weighted)' },
    { id: 302, name: 'July 4', year: 2027, date: '2027-07-01', physId: 201, group: 'IR-North', notes: 'Auto-lottery (weighted)' },
    { id: 303, name: 'July 4', year: 2027, date: '2027-07-05', physId: 202, group: 'IR-North', notes: 'Auto-lottery (weighted)' },
    { id: 304, name: 'July 4', year: 2027, date: '2027-07-03', physId: 203, group: 'IR-North', notes: 'Auto-lottery (weighted)' },
    { id: 305, name: 'July 4', year: 2020, date: '2020-07-03', physId: 202, group: 'IR-North', notes: 'Imported history (2020)' },
  ];
  S.irCalls = [
    { id: 401, physId: 201, date: '2027-07-01', callType: 'daily', irGroup: 'North', site: '', notes: 'July 4 (Holiday)' },
    { id: 402, physId: 203, date: '2027-07-02', callType: 'weekend', irGroup: 'North', site: 'North Hosp', notes: 'July 4 (Holiday)' },
    { id: 403, physId: 202, date: '2027-07-08', callType: 'daily', irGroup: 'North', site: '', notes: '' },
  ];
  S.irShifts = [
    { id: 501, physId: 201, date: '2027-07-01', shift: '1st', site: 'North Hosp', sub: '', notes: 'Auto-paired with IR call (holiday-sync)', irGroup: 'North' },
    { id: 502, physId: 202, date: '2027-07-08', shift: '1st', site: 'North Hosp', sub: '', notes: '', irGroup: 'North' },
  ];
  S.drShifts = [
    { id: 601, physId: 101, date: '2027-07-05', shift: '1st', site: 'CHN', sub: '', notes: '' },
    { id: 602, physId: 102, date: '2027-07-05', shift: 'Home', site: 'At Home / Remote', sub: '', notes: '' },
    { id: 603, physId: 102, date: '2027-07-06', shift: '1st', site: 'CHN', sub: '', notes: '' },
    { id: 604, physId: 101, date: '2027-07-06', shift: '1st', site: 'CHN', sub: '', notes: '' },
  ];
  if (opts.drift) {
    S.irCalls = S.irCalls.filter(c => c.id !== 401);
    S.drShifts.push({ id: 605, physId: 102, date: '2027-07-05', shift: '1st', site: 'CHN', sub: '', notes: '' });
  }
  S.weekendCalls = []; S.vacations = []; S.openShifts = [];
  S.nextId = 7000;
  _isRestoring = false;
  const ms = Date.now() - 60000;
  const payload = Object.assign(_buildPersistedPayload('online'),
    { users: USERS, savedAt: new Date(ms).toISOString(), _originTab: 'seed', _schemaVersion: _SCHEMA_VERSION });
  window.__mockSeed('main', JSON.stringify(payload), ms);
}

async function openTab(context) {
  const page = await context.newPage();
  await openApp(page, '/index.html?e2e=quiet');
  await page.waitForFunction(() => typeof _pushToSupabase === 'function');
  await page.evaluate(installMock);
  return page;
}
async function practice(browser, baseURL, opts) {
  const context = await browser.newContext({ baseURL });
  await context.route(url => !url.href.startsWith(baseURL), route => route.abort());
  const A = await openTab(context);
  await A.evaluate(seedPractice, opts || {});
  return { context, A };
}
const launch = page => page.evaluate(async () => {
  const base = (USERS || []).find(u => u.role === 'superuser') || (USERS || [])[0]
    || { id: 'e2e-user', email: 'e2e@example.com', first: 'E2E', last: 'User' };
  CU = { ...base, role: 'superuser', first: base.first || 'E2E', last: base.last || 'User', practiceId: 'main' };
  _ROW_ID = 'main'; _PRACTICE_ID = 'main'; _PRACTICES = [{ id: 'main', name: 'E2E Practice' }];
  launchApp._running = false;
  await launchApp();
});
const stat = page => page.evaluate(() => ({
  ...window.__mockStats,
  mirrorIds: window.__mockStats.mirrorIds.slice(), mirrorDeletes: window.__mockStats.mirrorDeletes.slice(),
  unsaved: !!_hasUnsavedChanges,
  banner: !!document.getElementById('rs-conflict-banner'),
  nextId: S.nextId,
  irCalls: (S.irCalls || []).map(c => [c.id, c.physId, c.date, c.callType, c.irGroup, c.notes].join('|')).sort(),
  drShiftIds: (S.drShifts || []).map(s => s.id).sort((a, b) => a - b),
  irShiftIds: (S.irShifts || []).map(s => s.id).sort((a, b) => a - b),
}));
const sum = (a, b, k) => a[k] + b[k];
const delta = (after, before, k) => after[k] - before[k];
// A change a person made: real input events first.
async function userEdit(page, fn, arg) {
  await page.mouse.click(5, 5);
  await page.keyboard.press('Shift');
  await page.evaluate(fn, arg);
}
// As it stands after the holiday sync — the seed above, unchanged.
const SYNCED_CALLS = [
  '401|201|2027-07-01|daily|North|July 4 (Holiday)',
  '402|203|2027-07-02|weekend|North|July 4 (Holiday)',
  '403|202|2027-07-08|daily|North|',
];

test('loading the app saves nothing and keeps every IR call id and nextId (and the Define Holidays tab saves nothing)', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL);
  await launch(A);
  await A.waitForTimeout(3500);
  const a0 = await stat(A);
  expect(a0.cas).toBe(0);
  expect(a0.unsaved).toBe(false);
  expect(a0.mirrorPosts).toBe(0);
  expect(a0.nextId).toBe(7000);
  expect(a0.irCalls).toEqual(SYNCED_CALLS);
  expect(a0.drShiftIds).toEqual([601, 602, 603, 604]);
  expect(a0.irShiftIds).toEqual([501, 502]);
  // Opening Holiday Call → Define Holidays sorted the reactive holidayDefs in place.
  await A.evaluate(() => { nav('holidays', document.querySelector('.snav-item[data-pg="holidays"]')); holTab('define'); });
  await expect(A.locator('#holdef-list')).toContainText('July 4');
  await A.waitForTimeout(2500);
  const a1 = await stat(A);
  expect(a1.cas).toBe(0);
  expect(a1.unsaved).toBe(false);
  await context.close();
});

test('two tabs left idle make no saves and no whole-row downloads', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL);
  const B = await openTab(context);
  await Promise.all([A, B].map(p => p.evaluate(() => { window.__mockRtOversize = true; })));   // production: events carry no row
  await Promise.all([launch(A), launch(B)]);
  await A.waitForTimeout(2500);
  const a0 = await stat(A), b0 = await stat(B);
  await A.waitForTimeout(12000);              // > one 10 s saved_at poll
  const a1 = await stat(A), b1 = await stat(B);
  expect(sum(a1, b1, 'cas')).toBe(0);
  expect(delta(a1, a0, 'fullGets') + delta(b1, b0, 'fullGets')).toBe(0);
  expect(sum(a1, b1, 'mirrorPosts')).toBe(0);
  expect(a1.unsaved || b1.unsaved).toBe(false);
  expect(a1.irCalls).toEqual(SYNCED_CALLS);
  expect(b1.irCalls).toEqual(SYNCED_CALLS);
  expect(a1.nextId).toBe(7000);
  await context.close();
});

test('an update from another device is applied with no save back', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL);
  await A.evaluate(() => { window.__mockRtOversize = true; });
  await launch(A);
  await A.waitForTimeout(2500);
  const a0 = await stat(A);
  await A.evaluate(() => window.__mockExternalWrite('main', d => {
    d.drShifts.push({ id: 7000, physId: 102, date: '2027-07-07', shift: '1st', site: 'CHN', sub: '', notes: 'ext' });
    d.nextId = 7001;
  }));
  await expect.poll(async () => (await stat(A)).drShiftIds.includes(7000), { timeout: 5000 }).toBe(true);
  await A.waitForTimeout(3500);               // the automatic save came 1.5 s after the apply
  const a1 = await stat(A);
  expect(delta(a1, a0, 'fullGets')).toBe(1);  // the stripped event costs one download — and nothing else
  expect(a1.cas).toBe(0);
  expect(a1.mirrorPosts).toBe(0);
  expect(a1.unsaved).toBe(false);
  expect(a1.nextId).toBe(7001);
  expect(a1.irCalls).toEqual(SYNCED_CALLS);
  await context.close();
});

test('a missing holiday IR call and DR days out of step are repaired and saved exactly once', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL, { drift: true });
  await launch(A);
  await A.waitForTimeout(3500);
  const a0 = await stat(A);
  expect(a0.cas).toBe(1);
  expect(a0.casOk).toBe(1);
  // Ash's daily holiday call is back (new id), the other calls kept theirs.
  expect(a0.irCalls).toEqual([
    '402|203|2027-07-02|weekend|North|July 4 (Holiday)',
    '403|202|2027-07-08|daily|North|',
    '7000|201|2027-07-01|daily|North|July 4 (Holiday)',
  ]);
  expect(a0.nextId).toBe(7001);
  // Birch's hospital shift on Oak's DR holiday is gone; Birch's Home shift stays.
  expect(a0.drShiftIds).toEqual([601, 602, 603, 604]);
  const row = await A.evaluate(() => window.__mockRow('main').data);
  expect(row.irCalls.map(c => c.id).sort()).toEqual([402, 403, 7000]);
  expect(row.drShifts.map(s => s.id).sort()).toEqual([601, 602, 603, 604]);
  // A second tab (a second load of the repaired row) finds nothing to repair, and
  // neither tab saves again.
  const B = await openTab(context);
  await launch(B);
  await A.waitForTimeout(8000);
  const a1 = await stat(A), b1 = await stat(B);
  expect(sum(a1, b1, 'cas')).toBe(1);
  expect(b1.irCalls).toEqual(a0.irCalls);
  expect(a1.irCalls).toEqual(a0.irCalls);
  expect(b1.nextId).toBe(7001);
  expect(a1.unsaved || b1.unsaved).toBe(false);
  await context.close();
});

test('returning to an unchanged tab reads only saved_at; a changed one is still refreshed', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL);
  await launch(A);
  await A.waitForTimeout(8000);               // past the 5 s "just saved" guard of the return handler
  const flip = state => A.evaluate(s => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  const a0 = await stat(A);
  await flip('hidden');
  await flip('visible');
  await A.waitForTimeout(1500);
  const a1 = await stat(A);
  expect(delta(a1, a0, 'fullGets')).toBe(0);
  expect(delta(a1, a0, 'savedAtGets')).toBeGreaterThanOrEqual(1);
  // Changed while the tab was away (and this device missed the event): one download, applied.
  await flip('hidden');
  await A.evaluate(() => { window.__mockRtMute = true; });
  await A.evaluate(() => window.__mockExternalWrite('main', d => { d.cellNotes = d.cellNotes || {}; d.cellNotes.__e2eX = 'x'; }));
  await A.waitForTimeout(700);
  await flip('visible');
  await expect.poll(async () => A.evaluate(() => !!(S.cellNotes || {}).__e2eX), { timeout: 5000 }).toBe(true);
  const a2 = await stat(A);
  expect(delta(a2, a1, 'fullGets')).toBeGreaterThanOrEqual(1);
  expect(a2.cas).toBe(a1.cas);
  await context.close();
});

test('after an update from another device the shift mirror receives only what changed', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL);
  await launch(A);
  await A.waitForTimeout(2500);
  // The tab's first save mirrors every shift once (nothing is known about the table yet).
  await userEdit(A, () => { S.drShifts.find(s => s.id === 603).notes = 'own-1'; triggerSave(); });
  await expect.poll(async () => (await stat(A)).mirrorPosts, { timeout: 8000 }).toBeGreaterThan(0);
  await A.waitForTimeout(500);
  const a0 = await stat(A);
  expect(a0.mirrorRows).toBe(9);              // 4 DR + 2 IR shifts + 3 IR calls

  // Another device edits one shift and deletes another; this tab applies it.
  await A.evaluate(() => window.__mockExternalWrite('main', d => {
    d.drShifts.find(s => s.id === 604).notes = 'ext';
    d.irShifts = d.irShifts.filter(s => s.id !== 502);
  }));
  await expect.poll(async () => A.evaluate(() => (S.drShifts.find(s => s.id === 604) || {}).notes), { timeout: 5000 }).toBe('ext');
  // …then a person edits a shift here.
  await userEdit(A, () => { S.drShifts.find(s => s.id === 601).notes = 'own-2'; triggerSave(); });
  await expect.poll(async () => (await stat(A)).mirrorRows, { timeout: 15000 }).toBeGreaterThan(a0.mirrorRows);
  await A.waitForTimeout(800);
  const a1 = await stat(A);
  const sent = a1.mirrorIds.slice(a0.mirrorIds.length).sort();
  expect(sent).toEqual(['dr:601', 'dr:604']);
  expect(a1.mirrorDeletes.slice(a0.mirrorDeletes.length)).toEqual(['ir:502']);
  expect(a1.casConflict).toBe(0);
  expect(a1.banner).toBe(false);
  await context.close();
});

// Undo steps back through whole-state snapshots, each taken just AFTER a change
// (triggerSave). A load or an update from another device used to leave its own
// snapshot only as a side effect of the needless re-sync save; now that such an
// apply saves nothing it must still leave one, with no save.
const drAdd = (page, note, date) => userEdit(page, ([n, dt]) => {
  S.drShifts.push({ id: S.nextId++, physId: 101, date: dt, shift: '1st', site: 'CHN', sub: '', notes: n });
  triggerSave();
}, [note, date]);
const hasNote = (page, n) => page.evaluate(x => S.drShifts.some(s => s.notes === x), n);
const srvHasNote = (page, n) => page.evaluate(x => window.__mockRow('main').data.drShifts.some(s => s.notes === x), n);
async function undoUntilGone(page, note, max) {
  for (let i = 0; i < max && await hasNote(page, note); i++) {
    await page.waitForTimeout(700);
    await page.evaluate(() => undoLastEdit());
  }
}
const extAdd = (page, id, note, date) => page.evaluate(([i, n, dt]) => window.__mockExternalWrite('main', d => {
  d.drShifts.push({ id: i, physId: 102, date: dt, shift: '1st', site: 'CHN', sub: '', notes: n });
}), [id, note, date]);

test('Undo after an update from another device keeps that update; the first edit after a load can be undone', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL);
  await launch(A);
  await A.waitForTimeout(2500);
  // The first edit after a load.
  await drAdd(A, 'E0', '2027-07-12');
  await expect.poll(() => srvHasNote(A, 'E0'), { timeout: 8000 }).toBe(true);
  await undoUntilGone(A, 'E0', 2);
  expect(await hasNote(A, 'E0')).toBe(false);
  await expect.poll(() => srvHasNote(A, 'E0'), { timeout: 8000 }).toBe(false);
  // An edit here, three updates from another device, another edit here.
  await A.waitForTimeout(800);
  await drAdd(A, 'E1', '2027-07-13');
  await expect.poll(() => srvHasNote(A, 'E1'), { timeout: 8000 }).toBe(true);
  await A.waitForTimeout(800);
  const n1 = await A.evaluate(() => _undoStack.length);
  for (const [id, note, date] of [[990001, 'R1', '2027-07-14'], [990002, 'R2', '2027-07-15'], [990003, 'R3', '2027-07-16']]) {
    await extAdd(A, id, note, date);
    await expect.poll(() => hasNote(A, note), { timeout: 8000 }).toBe(true);
    await A.waitForTimeout(400);
  }
  // Updates with no edit here in between share one undo entry (soft: BASE gave each its own).
  expect.soft(await A.evaluate(() => _undoStack.length)).toBe(n1 + 1);
  await A.waitForTimeout(800);
  await drAdd(A, 'E3', '2027-07-19');
  await expect.poll(() => srvHasNote(A, 'E3'), { timeout: 8000 }).toBe(true);
  // Undo until the last edit is gone: only it goes.
  await undoUntilGone(A, 'E3', 3);
  expect(await hasNote(A, 'E3')).toBe(false);
  for (const n of ['E1', 'R1', 'R2', 'R3']) expect(await hasNote(A, n)).toBe(true);
  await expect.poll(() => srvHasNote(A, 'E3'), { timeout: 8000 }).toBe(false);
  for (const n of ['E1', 'R1', 'R2', 'R3']) expect(await srvHasNote(A, n)).toBe(true);
  expect(await A.evaluate(() => _undoStack.length)).toBeGreaterThan(0);   // E1 can still be undone
  const a = await stat(A);
  expect(a.casConflict).toBe(0);
  expect(a.banner).toBe(false);
  await context.close();
});

test('after a load that repaired the holiday calendar, Undo of the next edit keeps the repair', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL, { drift: true });
  await launch(A);
  await A.waitForTimeout(3500);
  const a0 = await stat(A);
  expect(a0.cas).toBe(1);
  expect(a0.irCalls).toContain('7000|201|2027-07-01|daily|North|July 4 (Holiday)');
  await A.waitForTimeout(800);
  await drAdd(A, 'E1', '2027-07-12');
  await expect.poll(() => srvHasNote(A, 'E1'), { timeout: 8000 }).toBe(true);
  await undoUntilGone(A, 'E1', 2);
  expect(await hasNote(A, 'E1')).toBe(false);
  await expect.poll(() => srvHasNote(A, 'E1'), { timeout: 8000 }).toBe(false);
  const a1 = await stat(A);
  expect(a1.irCalls).toEqual(a0.irCalls);       // Ash's repaired holiday call is still there
  expect(a1.drShiftIds).toEqual(a0.drShiftIds); // and Birch's hospital shift on Oak's holiday still gone
  const row = await A.evaluate(() => window.__mockRow('main').data);
  expect(row.irCalls.map(c => c.id).sort()).toEqual([402, 403, 7000]);
  expect(row.drShifts.map(s => s.id).sort()).toEqual([601, 602, 603, 604]);
  expect(a1.casConflict).toBe(0);
  await context.close();
});

test('a holiday renamed, or a primary site changed, on another device updates the kept holiday call once (same id)', async ({ browser, baseURL }) => {
  const { context, A } = await practice(browser, baseURL);
  await A.evaluate(() => { window.__mockRtOversize = true; });
  await launch(A);
  await A.waitForTimeout(2500);
  const a0 = await stat(A);
  expect(a0.cas).toBe(0);
  // Another device renames Ash's July 4 assignment (as a definition rename does) and moves Pine's primary site,
  // without running the holiday sync itself.
  await A.evaluate(() => window.__mockExternalWrite('main', d => {
    d.holidays.forEach(h => { if (h.id === 302) h.name = 'Independence Day'; });
    d.physicians.forEach(p => { if (p.id === 203) p.irSitePrim = 'CHN'; });
  }));
  await expect.poll(async () => (await stat(A)).irCalls.some(c => c.startsWith('401|') && c.endsWith('Independence Day (Holiday)')), { timeout: 6000 }).toBe(true);
  await A.waitForTimeout(3500);
  const a1 = await stat(A);
  expect(a1.irCalls).toEqual([
    '401|201|2027-07-01|daily|North|Independence Day (Holiday)',   // same id, note follows the new name
    '402|203|2027-07-02|weekend|North|July 4 (Holiday)',
    '403|202|2027-07-08|daily|North|',
  ]);
  const site402 = await A.evaluate(() => S.irCalls.find(c => c.id === 402).site);
  expect(site402).toBe('CHN');                                       // weekend call follows the new primary site
  expect(delta(a1, a0, 'cas')).toBe(1);                              // the repair is saved, once
  expect(a1.nextId).toBe(a0.nextId);                                 // no call re-created
  const row = await A.evaluate(() => window.__mockRow('main').data);
  expect(row.irCalls.find(c => c.id === 401).notes).toBe('Independence Day (Holiday)');
  expect(row.irCalls.find(c => c.id === 402).site).toBe('CHN');
  // A second load of the repaired row finds nothing to change.
  const B = await openTab(context);
  await launch(B);
  await A.waitForTimeout(6000);
  const a2 = await stat(A), b2 = await stat(B);
  expect(sum(a2, b2, 'cas') - a1.cas).toBe(0);
  expect(a2.unsaved || b2.unsaved).toBe(false);
  await context.close();
});
