// Save-conflict regressions (rs-v125).
//
// 2026-11-21: two tabs opened together, both auto-saved on boot, one lost the
// compare-and-swap — and its conflict path re-queued itself every 250 ms
// forever (≈3 requests/second plus a warning toast each time). A second bug
// made a tab "conflict" with a save it had already RECEIVED from another tab,
// because timestamps were compared as strings ("…35.42+00:00" vs "…35.420Z").
//
// These tests run the REAL app in two tabs against one shared mock backend.
// The mock lives in localStorage (shared by same-origin tabs, synchronous, so
// its compare-and-swap is atomic across tabs) and mirrors production where it
// matters: PostgREST-style saved_at text, instant-based CAS, a trigger that
// mirrors the JSON savedAt, and a realtime echo of every committed write.
const { test, expect } = require('@playwright/test');

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
  const stats = window.__mockStats = { savedAtGets: 0, fullGets: 0, cas: 0, casOk: 0, casConflict: 0, toasts: 0 };
  const rtOut = new BroadcastChannel('__mock_realtime');
  const emit = id => {
    const r = readRow(id); if (!r) return;
    // __mockRtOversize: what Realtime sends once a change passes its 1,024 KB
    // cap — fields over 64 bytes (the data) are stripped; id + saved_at remain.
    const msg = window.__mockRtOversize
      ? { id, saved_at: pgTs(r.saved_at_ms) }
      : { id, data: r.data, saved_at: pgTs(r.saved_at_ms) };
    // Reaches every OTHER BroadcastChannel object of this name — including the
    // subscription in this same page, like Postgres echoing to the writer.
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
        upsert: async () => { await lat(20, 50); return { data: null, error: null }; },
        update() { return { eq: async () => ({ data: null, error: null }) }; },
        delete() { return { eq: async () => ({ data: null, error: null }) }; },
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

async function openTab(context) {
  const page = await context.newPage();
  await page.addInitScript(() => { window.__RS_E2E_DISABLE_SW = true; });
  await page.goto('/index.html?e2e=sync', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.launchApp === 'function' && typeof _pushToSupabase === 'function');
  await page.evaluate(installMock);
  return page;
}
const seed = page => page.evaluate(() => {
  const ms = Date.now() - 60000;
  const payload = Object.assign(_buildPersistedPayload('online'),
    { users: USERS, savedAt: new Date(ms).toISOString(), _originTab: 'seed', _schemaVersion: _SCHEMA_VERSION });
  window.__mockSeed('main', JSON.stringify(payload), ms);
});
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
  unsaved: !!_hasUnsavedChanges,
  banner: !!document.getElementById('rs-conflict-banner'),
  marks: Object.keys(S.cellNotes || {}).filter(k => k.indexOf('__e2e') === 0).sort().join(','),
}));
const serverMarks = page => page.evaluate(() =>
  Object.keys(window.__mockRow('main').data.cellNotes || {}).filter(k => k.indexOf('__e2e') === 0).sort().join(','));
// A change with no user gesture behind it (what boot-time normalisers do).
const autoEdit = (page, mark) => page.evaluate(m => {
  if (!S.cellNotes) S.cellNotes = {};
  S.cellNotes['__e2e' + m] = 'x';
  triggerSave();
}, mark);
// A change a person made: real input events first.
async function userEdit(page, mark) {
  await page.mouse.click(5, 5);
  await page.keyboard.press('Shift');
  await autoEdit(page, mark);
}
async function twoTabs(browser, baseURL) {
  const context = await browser.newContext({ baseURL });
  await context.route(url => !url.href.startsWith(baseURL), route => route.abort());
  const A = await openTab(context);
  await seed(A);
  const B = await openTab(context);
  return { context, A, B };
}

test('opening the app does not save, and two tabs saving at once converge without a retry loop', async ({ browser, baseURL }) => {
  const { context, A, B } = await twoTabs(browser, baseURL);
  await Promise.all([launch(A), launch(B)]);
  await A.waitForTimeout(3500);
  const a0 = await stat(A), b0 = await stat(B);
  // Boot must not write the practice row (audit entries used to force a save).
  expect(a0.cas + b0.cas).toBe(0);

  await Promise.all([autoEdit(A, 'A'), autoEdit(B, 'B')]);
  await A.waitForTimeout(7000);
  const a1 = await stat(A), b1 = await stat(B);
  // One tab won the compare-and-swap, one lost — exactly once, with no storm.
  expect((a1.casOk - a0.casOk) + (b1.casOk - b0.casOk)).toBe(1);
  expect((a1.casConflict - a0.casConflict) + (b1.casConflict - b0.casConflict)).toBeLessThanOrEqual(1);
  expect((a1.savedAtGets - a0.savedAtGets) + (b1.savedAtGets - b0.savedAtGets)).toBeLessThanOrEqual(6);
  expect((a1.toasts - a0.toasts) + (b1.toasts - b0.toasts)).toBeLessThanOrEqual(1);
  // Nothing of the user's was pending, so the loser quietly took the saved copy.
  expect(a1.unsaved).toBe(false);
  expect(b1.unsaved).toBe(false);
  expect(a1.banner || b1.banner).toBe(false);
  expect(a1.marks).toBe(b1.marks);
  expect(await serverMarks(A)).toBe(a1.marks);
  await context.close();
});

test('a tab that received another tab\'s save can save afterwards (no false conflict)', async ({ browser, baseURL }) => {
  const { context, A, B } = await twoTabs(browser, baseURL);
  await launch(A);
  await A.waitForTimeout(1200);
  await launch(B);
  await A.waitForTimeout(3500);

  await autoEdit(A, 'A');                     // leader saves; follower hears it over BroadcastChannel
  await A.waitForTimeout(4500);
  const b0 = await stat(B);
  expect(b0.marks).toBe('__e2eA');
  await userEdit(B, 'B');                     // …then the follower saves (>3 s later, so the probe runs)
  await expect.poll(async () => serverMarks(A), { timeout: 8000 }).toBe('__e2eA,__e2eB');
  const b1 = await stat(B);
  expect(b1.casOk - b0.casOk).toBe(1);
  expect(b1.casConflict - b0.casConflict).toBe(0);
  expect(b1.toasts - b0.toasts).toBe(0);
  expect(b1.unsaved).toBe(false);
  expect(b1.banner).toBe(false);

  await B.waitForTimeout(4500);               // and back the other way: the realtime-fed leader saves
  const a0 = await stat(A);
  expect(a0.marks).toBe('__e2eA,__e2eB');
  await userEdit(A, 'C');
  await expect.poll(async () => serverMarks(A), { timeout: 8000 }).toBe('__e2eA,__e2eB,__e2eC');
  const a1 = await stat(A);
  expect(a1.casConflict - a0.casConflict).toBe(0);
  expect(a1.banner).toBe(false);
  await context.close();
});

test('a real conflict with unsent user edits shows one banner, keeps the edits, and "Load latest" recovers', async ({ browser, baseURL }) => {
  const { context, A, B } = await twoTabs(browser, baseURL);
  await B.close();
  await launch(A);
  await A.waitForTimeout(3000);
  // Another device saves while this tab is cut off from updates, so the edit
  // below is made on a stale base.
  await A.evaluate(() => { window.__holdApply = _applyRemoteData; _applyRemoteData = function () {}; });
  await A.evaluate(() => window.__mockExternalWrite('main', d => { d.cellNotes = d.cellNotes || {}; d.cellNotes.__e2eX = 'x'; }));
  await A.waitForTimeout(500);
  await A.evaluate(() => { _applyRemoteData = window.__holdApply; });

  const a0 = await stat(A);
  await userEdit(A, 'A');
  await expect(A.locator('#rs-conflict-banner')).toBeVisible({ timeout: 8000 });
  await A.waitForTimeout(5000);               // watch for a retry storm
  const a1 = await stat(A);
  expect(a1.savedAtGets - a0.savedAtGets).toBeLessThanOrEqual(3);
  expect(a1.toasts - a0.toasts).toBeLessThanOrEqual(1);
  expect(a1.casOk - a0.casOk).toBe(0);        // never overwrote the other device
  expect(a1.marks).toBe('__e2eA');            // the unsent edit is still on screen
  expect(await serverMarks(A)).toBe('__e2eX');

  await A.locator('#rs-conflict-load').click();
  await expect(A.locator('#rs-conflict-banner')).toHaveCount(0, { timeout: 8000 });
  const a2 = await stat(A);
  expect(a2.unsaved).toBe(false);
  expect(a2.marks).toBe('__e2eX');

  await userEdit(A, 'C');                     // and saving works again
  await expect.poll(async () => serverMarks(A), { timeout: 8000 }).toBe('__e2eC,__e2eX');
  await context.close();
});

test('a realtime event too large to carry the data still updates the tab', async ({ browser, baseURL }) => {
  const { context, A, B } = await twoTabs(browser, baseURL);
  await B.close();
  await launch(A);
  await A.waitForTimeout(3000);
  const a0 = await stat(A);
  await A.evaluate(() => { window.__mockRtOversize = true; });
  await A.evaluate(() => window.__mockExternalWrite('main', d => { d.cellNotes = d.cellNotes || {}; d.cellNotes.__e2eX = 'x'; }));
  // Well inside the 10 s poll interval: this must come from the event itself.
  await expect.poll(async () => (await stat(A)).marks, { timeout: 4000 }).toBe('__e2eX');
  const a1 = await stat(A);
  expect(a1.fullGets - a0.fullGets).toBe(1);
  await userEdit(A, 'A');                     // and the tab can save on top of it
  await expect.poll(async () => serverMarks(A), { timeout: 8000 }).toBe('__e2eA,__e2eX');
  expect((await stat(A)).banner).toBe(false);
  await context.close();
});
