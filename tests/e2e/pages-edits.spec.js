// Slow pages and edits (after rs-v138).
//
//   1. Physicians page / saving a physician: the burnout flags asked, for every
//      physician and every day of the month, "does this physician have a shift
//      today?" by scanning every DR and IR shift (2,880 full scans per render).
//      They now read the date index, which is built once per data change.
//   2. DR Schedule Builder: an empty or half-typed month box matched every DR
//      shift and drew the whole multi-year table on each keystroke. It now lists
//      nothing (a prompt) until the box holds a whole month.
//   3. Unfilled slots: one table row per gap, no cap (40,000+ elements). The
//      list now stops at 300 rows with a "N more" note and a Show all button;
//      the totals and the CSV export still carry every gap.
//   4. Tools: the data sanity check "No shift on a vacation day" scanned every
//      DR shift, IR shift, IR call, weekend call and holiday once per vacation.
//      Each array is now grouped by physician once; the result is the same.
//   5. IR call and DR weekend auto-assign previews: each physician's vacation
//      day set was rebuilt on every eligibility check. It is now built once per
//      preview (and fresh for the next one).
//
// Synthetic practices only, built in the page.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// ── Runs in the page: shared helpers on window.__pe ─────────────────────────
function pageHelpers() {
  const mk = (id, last, role, extra) => Object.assign({
    id, first: 'T', last, degree: 'MD', role, drFte: role === 'IR' ? 0 : 1, irFte: role === 'DR' ? 0 : 1, drFteDay: null,
    drSubs: [], irSubs: [], address: '', irGroup: role === 'DR' ? '' : 'South', irSitePrim: '',
    shiftElig: { s1: true, s2: true, s3: true, home: true, wknd: true, wkndSwingOnly: false },
    allowedSites: [], siteRules: [], irCallBlackouts: [], dayConditions: [], tbRules: [], callDayRules: [], siteSeqRules: [],
  }, extra || {});
  window.__pe = {
    mk,
    reset(physicians) {
      _isRestoring = true;                       // build state without queueing saves
      S.physicians = physicians;
      S.sites = [{ name: 'At Home / Remote', irGroup: null, irAnchors: [], irFillins: [] }, { name: 'Alpha', irGroup: '', irAnchors: [], irFillins: [] }];
      S.drShifts = []; S.irShifts = []; S.irCalls = []; S.weekendCalls = []; S.vacations = []; S.holidays = []; S.holidayDefs = [];
      S.openShifts = []; S.natLangRules = []; S.tumorBoards = []; S.clinics = []; S.siteSlots = {}; S.siteSlotsSubs = {};
      S.irSlots = {}; S.irShiftSlots = {}; S.wkndNeeds = {}; S.irGroups = []; S.drSubs = [];
      if (S.cfg) delete S.cfg.burnout;            // the default thresholds: 5 days in a row, 3 weekends a quarter
      S.nextId = 90000;
      _isRestoring = false;
      _markDateIdxDirty();
      window.confirm = () => true; window.alert = () => {};
    },
    go(pg) { nav(pg, document.querySelector('.snav-item[data-pg="' + pg + '"]')); },
    // count calls of a global function (a top-level function declaration)
    count(name) {
      const real = window[name]; const box = { n: 0 };
      window[name] = function () { box.n++; return real.apply(this, arguments); };
      box.restore = () => { window[name] = real; };
      return box;
    },
  };
}
const setup = async page => { await page.evaluate(`(${pageHelpers})()`); };

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=pages-edits');
  await launchSyntheticUser(page, 'admin');
  await setup(page);
});

test('Physicians page and a physician save read the date index for burnout flags, built once per save — same flags', async ({ page }) => {
  const r = await page.evaluate(() => {
    const ym = fmtDate(new Date()).slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const monthBack = k => { const d = new Date(y, m - 1 - k, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
    const D = d => ym + '-' + String(d).padStart(2, '0');
    __pe.reset([__pe.mk(1, 'Streak', 'DR'), __pe.mk(2, 'Homer', 'DR'), __pe.mk(3, 'Mixer', 'DR'), __pe.mk(4, 'Weekender', 'DR'),
      __pe.mk(5, 'Later', 'DR'), __pe.mk(6, 'Quiet', 'DR'), __pe.mk(9, 'Irwin', 'IR'), __pe.mk(10, 'Irma', 'IR')]);
    _isRestoring = true;
    let id = 5000; const dr = [], ir = [];
    const sh = (arr, physId, date, shift, site) => arr.push({ id: id++, physId, date, shift, site: site || 'Alpha', sub: '', notes: '' });
    for (let d = 3; d <= 8; d++) sh(dr, 1, D(d), '1st');                                  // 6 days in a row
    for (let d = 1; d <= 10; d++) sh(dr, 2, D(d), 'Home', 'At Home / Remote');            // Home days never count
    sh(dr, 3, D(1), '1st'); sh(dr, 3, D(2), '2nd'); for (let d = 3; d <= 5; d++) sh(ir, 3, D(d), '1st');   // DR then IR: 5 in a row
    for (let d = 10; d <= 14; d++) sh(ir, 9, D(d), '1st');                                // 5 IR days in a row
    for (let d = 1; d <= 28; d += 2) sh(dr, 6, D(d), '1st');                              // every other day: no streak
    for (let k = 0; k < 1500; k++) sh(dr, 6, '2025-' + String(1 + k % 12).padStart(2, '0') + '-' + String(1 + k % 28).padStart(2, '0'), '1st');   // other months
    S.drShifts = dr; S.irShifts = ir;
    S.weekendCalls = [0, 1, 2].map(k => ({ id: id++, physId: 4, satDate: monthBack(k) + '-10', sunDate: monthBack(k) + '-11', sub: '', site: '', wshift: 'day', notes: '' }));
    _isRestoring = false; _markDateIdxDirty();
    // count whole-array scans of the two shift arrays, and index builds
    const scans = { n: 0 };
    ['drShifts', 'irShifts'].forEach(k => { S[k].some = function () { scans.n++; return Array.prototype.some.apply(this, arguments); }; });
    const rebuild = __pe.count('_rebuildDateIdx');
    __pe.go('physicians');
    const open = { scans: scans.n, rebuilds: rebuild.n };
    const flags = () => Object.fromEntries(S.physicians.map(p => [p.last, _physicianBurnoutFlags(p.id, ym)]));
    const chips = () => [...document.querySelectorAll('#phys-list .tag.tr')].map(e => e.getAttribute('title')).sort();
    const atOpen = { flags: flags(), chips: chips() };
    // a physician save (Edit → change a field → Save Changes)
    scans.n = 0; rebuild.n = 0;
    editPhys(6); document.getElementById('p-deg').value = 'DO'; submitPhys();
    const save = { scans: scans.n, rebuilds: rebuild.n, degree: S.physicians.find(p => p.id === 6).degree };
    // the index follows the data: 5 new days in a row for "Later" show up on the next render
    for (let d = 15; d <= 19; d++) S.drShifts.push({ id: id++, physId: 5, date: D(d), shift: '1st', site: 'Alpha', sub: '', notes: '' });
    _afterMutation();
    rebuild.restore();
    return { open, save, atOpen, after: { flags: flags(), chips: chips() }, physicians: S.physicians.length };
  });
  const expected = {
    Streak: ['6 consecutive days'], Homer: [], Mixer: ['5 consecutive days'], Weekender: ['3 weekend calls in last 3 months'],
    Later: [], Quiet: [], Irwin: ['5 consecutive days'], Irma: [],
  };
  expect(r.atOpen.flags).toEqual(expected);
  expect(r.atOpen.chips).toEqual(['3 weekend calls in last 3 months', '5 consecutive days', '5 consecutive days', '6 consecutive days']);
  expect(r.after.flags).toEqual({ ...expected, Later: ['5 consecutive days'] });
  expect(r.after.chips).toHaveLength(5);
  // the speed-up itself: no full scan of the shift arrays per physician-day (was physicians × days in month)
  expect(r.open.scans).toBeLessThan(r.physicians);
  expect(r.save.scans).toBeLessThan(r.physicians);
  expect(r.save.degree).toBe('DO');
  expect(r.save.rebuilds).toBe(1);                   // the save changed the data: the index is built once for its render
});

test('DR Schedule Builder lists nothing until the month box holds a whole month; a whole month lists exactly its shifts', async ({ page }) => {
  const r = await page.evaluate(() => {
    __pe.reset([__pe.mk(1, 'Alder', 'DR'), __pe.mk(2, 'Birch', 'DR')]);
    _isRestoring = true;
    let id = 7000; const dr = [];
    ['2026-11', '2027-02', '2027-03', '2027-04'].forEach(ym => {
      for (let d = 1; d <= 20; d++) dr.push({ id: id++, physId: 1 + d % 2, date: ym + '-' + String(d).padStart(2, '0'), shift: d % 3 ? '1st' : '2nd', site: 'Alpha', sub: '', notes: '' });
    });
    S.drShifts = dr;
    _isRestoring = false; _markDateIdxDirty();
    __pe.go('dr-builder');
    const mo = document.getElementById('drb-filter-mo'), shf = document.getElementById('drb-filter-shift');
    const show = (m, s) => {
      mo.value = m; shf.value = s || ''; renderDRBuilder();
      const trs = [...document.querySelectorAll('#drb-tbody tr')];
      return { rows: trs.length, dates: trs.map(t => (t.children[1] || {}).textContent || ''), text: document.getElementById('drb-tbody').textContent.trim() };
    };
    // a text-box month (desktop Safari's fallback) can hold a half-typed value
    const half = (() => { const real = mo; real.type = 'text'; const v = show('2027-0'); real.type = 'month'; return v; })();
    return { total: S.drShifts.length, empty: show(''), half, march: show('2027-03'), march2nd: show('2027-03', '2nd'), nov: show('2026-11') };
  });
  expect(r.total).toBe(80);
  for (const v of [r.empty, r.half]) {
    expect(v.rows).toBe(1);
    expect(v.text).toContain('Choose a month');
  }
  expect(r.march.rows).toBe(20);
  expect(r.march.dates.every(d => d.startsWith('2027-03-'))).toBe(true);
  expect(r.march.dates).toEqual([...r.march.dates].sort());
  expect(r.march2nd.rows).toBe(6);                  // days 3, 6, 9, 12, 15, 18
  expect(r.nov.rows).toBe(20);
});

test('Unfilled slots lists the first 300 gaps with an "N more" note; totals, CSV and Show all keep every gap', async ({ page }) => {
  const r = await page.evaluate(async () => {
    __pe.reset([__pe.mk(1, 'Alder', 'DR')]);
    _isRestoring = true;
    // 20 open DR positions per weekday at Alpha and nobody booked: hundreds of gaps
    for (let k = 1; k <= 5; k++) S.siteSlots['Alpha|' + k + '|1st'] = 20;
    _isRestoring = false; _markDateIdxDirty();
    document.getElementById('uf-mo').value = '2027-03';
    document.getElementById('uf-range').value = '3';
    document.getElementById('uf-cat').value = 'all';
    __pe.go('unfilled');
    const rows = () => document.querySelectorAll('#uf-list tbody tr').length;
    const total = _UF_LAST_SCAN.length;
    const first = { rows: rows(), note: (document.querySelector('#uf-list .uf-more') || {}).textContent || '', summary: document.getElementById('uf-summary').textContent.replace(/\s+/g, ' ') };
    let csv = null;
    const realClip = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { csv = t; return Promise.resolve(); } } });
    _exportUnfilledCSV();
    await new Promise(r => setTimeout(r, 50));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: realClip });
    const btn = document.querySelector('#uf-list .uf-more button'); if (btn) btn.click();
    const all = { rows: rows(), note: !!document.querySelector('#uf-list .uf-more') };
    renderUnfilled();                                  // any later draw (an edit, another device) lists 300 again
    return { total, first, csvLines: csv ? csv.split('\n').length : 0, all, again: rows() };
  });
  expect(r.total).toBeGreaterThan(600);
  expect(r.first.rows).toBe(300);
  expect(r.first.note).toContain(`Showing the first 300 of ${r.total}`);
  expect(r.first.note).toContain(`${r.total - 300} more not shown`);
  expect(r.first.summary).toContain(`${r.total} unfilled slots`);
  expect(r.csvLines).toBe(r.total + 1);              // header + every gap
  expect(r.all).toEqual({ rows: r.total, note: false });
  expect(r.again).toBe(300);
});

test('Tools: the vacation-conflict sanity check looks at each physician\'s records once — same result as the full scan', async ({ page }) => {
  const r = await page.evaluate(() => {
    const P = []; for (let i = 1; i <= 40; i++) P.push(__pe.mk(i, 'Doc' + i, i % 5 ? 'DR' : 'IR'));
    __pe.reset(P);
    _isRestoring = true;
    let id = 20000;
    const D = (m, d) => '2027-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    // three vacations each; only the later ones (physicians 21..40) collide with anything
    for (let i = 1; i <= 40; i++) for (let m = 1; m <= 3; m++) S.vacations.push({ id: id++, physId: i, type: 'Vacation', start: D(m * 2, 10), end: D(m * 2, 14), notes: '' });
    for (let i = 1; i <= 40; i++) for (let d = 1; d <= 28; d++) {
      const hit = i > 20 && d === 12;                                                    // inside the Feb/Apr/Jun vacations
      const clear = d % 4 === 0 && (d < 10 || d > 14);                                   // outside them
      if (!clear && !hit) continue;
      for (const m of [2, 4, 6]) S.drShifts.push({ id: id++, physId: i, date: D(m, d), shift: '1st', site: 'Alpha', sub: '', notes: '' });
    }
    S.irShifts.push({ id: id++, physId: 25, date: D(4, 11), shift: '1st', site: 'Alpha' });
    S.irCalls.push({ id: id++, physId: 30, date: D(6, 13), callType: 'daily', irGroup: 'South' });
    S.weekendCalls.push({ id: id++, physId: 35, satDate: D(2, 13), sunDate: D(2, 14), sub: '', site: '', wshift: 'day' });
    S.holidays.push({ id: id++, physId: 40, date: D(4, 14), name: 'X', year: 2027, group: 'DR', notes: '' });
    _isRestoring = false; _markDateIdxDirty();
    // the full scan exactly as it was written before (reference)
    const reference = () => {
      const conflicts = [];
      const arrs = [['DR', S.drShifts, s => s.date], ['IR', S.irShifts, s => s.date], ['IR call', S.irCalls, c => c.date],
        ['Weekend call', S.weekendCalls, w => w.satDate || w.sunDate || w.date], ['Holiday', S.holidays, h => h.date]];
      for (const v of (S.vacations || [])) {
        if (!v.physId || !v.start || !v.end) continue;
        for (const [label, arr, getDate] of arrs) {
          for (const s of (arr || [])) {
            if (s.physId !== v.physId) continue;
            const d = getDate(s);
            if (d && d >= v.start && d <= v.end) { conflicts.push(`${label} on ${d} for phys=${v.physId}`); if (conflicts.length >= 50) break; }
          }
          if (conflicts.length >= 50) break;
        }
        if (conflicts.length >= 50) break;
      }
      return conflicts;
    };
    const check = _SANITY_CHECKS.find(c => c.id === 'shift-vacation-conflict');
    // count passes over S.drShifts (for…of), the scan that used to run once per vacation
    let passes = 0; const it = Array.prototype[Symbol.iterator];
    S.drShifts[Symbol.iterator] = function () { passes++; return it.call(this); };
    const got = check.fn();
    const gotPasses = passes;
    delete S.drShifts[Symbol.iterator];
    const ref = reference();
    // fewer than 50 conflicts too: drop the shifts, keep the four other collisions
    _isRestoring = true; const keep = S.drShifts; S.drShifts = keep.filter(s => !(s.physId > 20 && s.date.endsWith('-12'))); _isRestoring = false; _markDateIdxDirty();
    const few = check.fn(), fewRef = reference();
    _isRestoring = true; S.drShifts = keep; _isRestoring = false; _markDateIdxDirty();
    __pe.go('tools');
    const panel = document.getElementById('sys-health-result').textContent.replace(/\s+/g, ' ');
    return { got: { status: got.status, count: got.count, detail: got.detail }, ref, gotPasses, vacations: S.vacations.length,
      few: { status: few.status, count: few.count, detail: few.detail }, fewRef, panel };
  });
  expect(r.ref.length).toBe(50);
  expect(r.got).toEqual({ status: 'fail', count: 50, detail: `50 shift(s)/call(s) overlap a vacation. First: ${r.ref[0]} (+49 more).` });
  expect(r.fewRef).toHaveLength(4);
  expect(r.few).toEqual({ status: 'fail', count: 4, detail: `4 shift(s)/call(s) overlap a vacation. First: ${r.fewRef[0]} (+3 more).` });
  expect(r.panel).toContain('Data sanity');
  expect(r.panel).toMatch(/Data sanity\s*\d+ failed, \d+ warnings, \d+ passed/);
  // the speed-up itself: S.drShifts is walked once, not once per vacation (120 here)
  expect(r.gotPasses).toBe(1);
});

test('IR call preview builds each physician\'s vacation days once per preview, and the next preview sees new vacations', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const P = []; for (let i = 1; i <= 7; i++) P.push(__pe.mk(i, 'Ir' + i, 'IR'));
    __pe.reset(P);
    _isRestoring = true;
    S.irGroups = ['South'];
    S.cfg = Object.assign({}, S.cfg, { irDailyMaxYr: 60, irWkndMaxYr: 20, irDailyMax: 60, irWkndMax: 20, irMax: 60 });
    S.vacations = [{ id: 30001, physId: 2, type: 'Vacation', start: '2027-03-08', end: '2027-03-14', notes: '' }];
    _isRestoring = false; _markDateIdxDirty();
    const away = __pe.count('_awayDays');
    const run = async () => {
      __pe.go('ir-auto');
      const yr = document.getElementById('ira-yr');
      if (![...yr.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; yr.appendChild(o); }
      yr.value = '2027';
      document.getElementById('ira-period').value = 'month'; _iraTogglePeriodInputs();
      document.getElementById('ira-mo').value = '2027-03';
      document.getElementById('ira-type').value = 'both'; document.getElementById('ira-grp').value = 'both';
      away.n = 0;
      previewIRAA();
      await new Promise(r => setTimeout(r, 100));
      for (let i = 0; i < 600 && (previewIRAA._deferred || document.getElementById('iraa-progress')); i++) await new Promise(r => setTimeout(r, 25));
      return { calls: away.n, plan: (S.iraPreview || []).map(a => ({ physId: a.physId, date: a.date, callType: a.callType })) };
    };
    const covers = (a, d) => a.callType === 'weekend' ? (d >= a.date && d <= addDays(a.date, 3)) : a.date === d;
    const first = await run();
    const onVac2 = first.plan.filter(a => a.physId === 2 && ['08', '09', '10', '11', '12', '13', '14'].some(dd => covers(a, '2027-03-' + dd)));
    const pick = first.plan.find(a => a.callType === 'daily' && a.date >= '2027-03-16');
    S.vacations.push({ id: 30002, physId: pick.physId, type: 'Vacation', start: pick.date, end: pick.date, notes: '' });
    const second = await run();
    away.restore();
    return { first: { calls: first.calls, n: first.plan.length }, onVac2: onVac2.length, pick,
      second: { calls: second.calls, n: second.plan.length, pickAgain: second.plan.filter(a => a.physId === pick.physId && covers(a, pick.date)).length } };
  });
  expect(r.first.n).toBeGreaterThan(15);
  expect(r.onVac2).toBe(0);                          // vacation still blocks
  expect(r.second.n).toBeGreaterThan(15);
  expect(r.second.pickAgain).toBe(0);                // the new vacation is seen: the sets are per preview, not kept
  // the speed-up itself: one vacation set per physician per preview (was one per eligibility check)
  expect(r.first.calls).toBeLessThanOrEqual(7);
  expect(r.second.calls).toBeLessThanOrEqual(7);
});

test('DR weekend preview builds each physician\'s vacation days once per preview, and the next preview sees new vacations', async ({ page }) => {
  const r = await page.evaluate(() => {
    const P = []; for (let i = 1; i <= 6; i++) P.push(__pe.mk(i, 'Dr' + i, 'DR'));
    __pe.reset(P);
    _isRestoring = true;
    S.wkndNeeds = { '': { day: 1, swing: 0 } };
    S.vacations = [{ id: 31001, physId: 1, type: 'Vacation', start: '2027-03-06', end: '2027-03-14', notes: '' }];
    _isRestoring = false; _markDateIdxDirty();
    const away = __pe.count('_awayDays');
    const run = () => {
      __pe.go('wk-aa');
      const yr = document.getElementById('wkaa-yr');
      if (![...yr.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; yr.appendChild(o); }
      yr.value = '2027'; document.getElementById('wkaa-period').value = 'H1';
      away.n = 0;
      previewWkAA();
      return { calls: away.n, plan: _wkAAPlan.plan.map(a => ({ physId: a.physId, satDate: a.satDate })), gaps: _wkAAPlan.gaps.length };
    };
    const first = run();
    const pick = first.plan.find(a => a.satDate >= '2027-04-01');
    S.vacations.push({ id: 31002, physId: pick.physId, type: 'Vacation', start: pick.satDate, end: addDays(pick.satDate, 1), notes: '' });
    const second = run();
    away.restore();
    return { first: { calls: first.calls, n: first.plan.length, gaps: first.gaps, onVac1: first.plan.filter(a => a.physId === 1 && (a.satDate === '2027-03-06' || a.satDate === '2027-03-13')).length },
      pick, second: { calls: second.calls, n: second.plan.length, pickAgain: second.plan.filter(a => a.physId === pick.physId && a.satDate === pick.satDate).length } };
  });
  expect(r.first.n).toBe(26);                        // every H1 2027 weekend gets its one day-call
  expect(r.first.onVac1).toBe(0);
  expect(r.second.n).toBe(26);
  expect(r.second.pickAgain).toBe(0);
  expect(r.first.calls).toBeLessThanOrEqual(6);
  expect(r.second.calls).toBeLessThanOrEqual(6);
});

test('DR Schedule Builder: a whole year typed in the month box (Safari shows it as a text box) lists that year; Clear Filtered needs a month or year', async ({ page }) => {
  const r = await page.evaluate(() => {
    __pe.reset([__pe.mk(1, 'Alder', 'DR'), __pe.mk(2, 'Birch', 'DR')]);
    _isRestoring = true;
    let id = 7000; const dr = [];
    ['2026-11', '2027-02', '2027-03'].forEach(ym => {
      for (let d = 1; d <= 10; d++) dr.push({ id: id++, physId: 1 + d % 2, date: ym + '-' + String(d).padStart(2, '0'), shift: '1st', site: 'Alpha', sub: '', notes: '' });
    });
    S.drShifts = dr;
    _isRestoring = false; _markDateIdxDirty();
    __pe.go('dr-builder');
    const mo = document.getElementById('drb-filter-mo'); mo.type = 'text';
    const rows = () => document.querySelectorAll('#drb-tbody tr').length;
    mo.value = '2027'; renderDRBuilder(); const year = rows();
    const alerts = []; window.alert = m => alerts.push(String(m)); let asked = 0; window.confirm = () => { asked++; return true; };
    mo.value = ''; renderDRBuilder();
    clearDRShifts('filtered');
    const afterEmpty = S.drShifts.length;
    mo.value = '2026-1'; clearDRShifts('filtered');
    const afterHalf = S.drShifts.length;
    mo.value = '2027-03'; clearDRShifts('filtered');
    const afterMarch = S.drShifts.length;
    return { year, afterEmpty, afterHalf, afterMarch, alerts: alerts.length, asked, placeholder: mo.getAttribute('placeholder') };
  });
  expect(r.year).toBe(20);                 // every 2027 shift (Feb + Mar), as before the empty-month prompt
  expect(r.afterEmpty).toBe(30);           // empty box: nothing deleted, the user is told to pick a month
  expect(r.afterHalf).toBe(30);            // half-typed: nothing deleted
  expect(r.alerts).toBe(2);
  expect(r.asked).toBe(1);                 // only the whole month asked for confirmation
  expect(r.afterMarch).toBe(20);           // and deleted exactly March
  expect(r.placeholder).toBe('YYYY-MM');
});

test('Unfilled slots: the "N more not shown" line is printed with the capped list', async ({ page }) => {
  await page.evaluate(() => {
    __pe.reset([__pe.mk(1, 'Alder', 'DR')]);
    _isRestoring = true;
    for (let k = 1; k <= 5; k++) S.siteSlots['Alpha|' + k + '|1st'] = 20;
    _isRestoring = false; _markDateIdxDirty();
    document.getElementById('uf-mo').value = '2027-03';
    document.getElementById('uf-range').value = '3';
    document.getElementById('uf-cat').value = 'all';
    __pe.go('unfilled');
  });
  await page.emulateMedia({ media: 'print' });
  const shown = await page.evaluate(() => { const n = document.querySelector('#uf-list .uf-more'); return n ? getComputedStyle(n).display : 'missing'; });
  await page.emulateMedia({ media: 'screen' });
  expect(shown).not.toBe('none');
  expect(shown).not.toBe('missing');
});
