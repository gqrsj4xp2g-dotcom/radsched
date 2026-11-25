// Fixes from the review of rs-v135 (rs-v136).
//
// Year-end rollover warned only about overlaps inside the target year, so a
// "New Year's Eve" rolled onto Dec 31 sat silently on top of a New Year's Day
// observed that Friday (filed under the next year). Rebalance → Day-Fill took the
// call-paired shift ("Auto (with call)") off a physician on IR call who had
// reached quota — also when the call was one they cover for another pool — and
// gave up on a slot whose only free physician was still held for a later slot
// that day. A Holiday Call inline edit kept the old season's Year, a renamed
// holiday definition left its assignments under the old name (Auto-Assign
// staffed it twice), and the inline editor's fixed North/South group list moved
// an IR-Riverview entry to DR. Procedure Shifts took an anchor off their own
// mixed site because it was missing from their allowedSites list (the site's
// anchor/fill-in grant overrides it everywhere else). The greedy builder's slot
// rotation re-labelled shifts after their slot sequence rules were checked, and
// an old-model per-site cap ("max 1 day in a row at NA") blocked the next day
// at every site. The MCF builder got a faster solver that must give the same
// plan.
//
// Every test fails on rs-v135. The one for a member covering another pool's call
// also fails on rs-v135 + these fixes without IR call pools: it needs both.
//
// Synthetic practices only, built in the page.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// Runs in the page: shared helpers (returned as an object).
function lib(){
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const mkPhys = (id, last, group, extra) => Object.assign({ id, first: 'T', last, role: 'IR', drFte: 0, irFte: 1, irGroup: group, irSitePrim: null, anchorSite: null,
    drSubs: [], irSubs: [], address: '', shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [],
    siteSeqRules: [], allowedSites: [], seqRules: null }, extra || {});
  const clear = () => {
    S.irCalls = []; S.irShifts = []; S.drShifts = []; S.holidays = []; S.holidayDefs = []; S.weekendCalls = []; S.natLangRules = []; S.tumorBoards = [];
    S.clinics = []; S.vacations = []; S.openShifts = []; S.irShiftSlots = {}; S.irShiftSlotLabels = {}; S.irSlots = {};
  };
  // weekday slots: {site: n} → S.irShiftSlots for Mon–Fri (labels: {site: [l0, l1, …]})
  const slots = (perSite, labels) => {
    S.irShiftSlots = {}; S.irShiftSlotLabels = {};
    Object.entries(perSite).forEach(([site, n]) => { for(let d = 0; d < 7; d++){
      const k = typeof n === 'function' ? n(d) : (d >= 1 && d <= 5 ? n : 0); S.irShiftSlots[`${site}|${d}|1st`] = k;
      ((labels || {})[site] || []).forEach((l, i) => { if(i < k) S.irShiftSlotLabels[`${site}|${d}|1st#${i}`] = l; }); } });
  };
  const weekdays = (from, to) => { const out = []; let d = from; while(d <= to){ const w = parseDateLocal(d).getDay(); if(w >= 1 && w <= 5) out.push(d); d = addDays(d, 1); } return out; };
  const done = () => { _isRestoring = false; if(typeof _markDateIdxDirty === 'function') _markDateIdxDirty(); };
  const setSel = (id, v) => { const e = document.getElementById(id); if(!e) return; if(e.tagName === 'SELECT' && ![...e.options].some(o => o.value === String(v))){
    const o = document.createElement('option'); o.value = String(v); o.textContent = String(v); e.appendChild(o); } e.value = String(v); };
  // What fn writes: the saves / undo steps it queues (S is a reactive Proxy: a write queues a save) plus 1000
  // when the schedule data changed in place without one. A preview must write nothing (0). Scratch fields
  // ('_…', e.g. the greedy builder's _irsaQta on physicians before rs-v136) are left to call-pools.spec.js.
  const DATA = ['physicians', 'irShifts', 'irCalls', 'drShifts', 'vacations', 'holidays', 'holidayDefs', 'sites', 'irShiftSlots', 'irShiftSlotLabels', 'irGroups'];
  const snap = () => JSON.stringify(DATA.map(k => S[k]), (k, v) => (typeof k === 'string' && k[0] === '_' ? undefined : v));
  const writes = async fn => {
    let n = 0; const ts = window.triggerSave, us = window._undoSnapshot, s0 = snap();
    window.triggerSave = function(){ n++; return ts.apply(this, arguments); };
    if(typeof us === 'function') window._undoSnapshot = function(){ n++; return us.apply(this, arguments); };
    try { await fn(); } finally { window.triggerSave = ts; window._undoSnapshot = us; }
    return n + (snap() !== s0 ? 1000 : 0);
  };
  // Rebalance (Day-Fill / Procedure Shifts) preview for 2027, synchronously; returns _irrPlan.
  const rebalance = (typ, period) => {
    nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
    setSel('irr-yr', '2027'); setSel('irr-period', period || 'H1'); setSel('irr-grp', 'both'); setSel('irr-type', typ);
    _irrPlan = null; previewIRRebalance._deferred = true;
    try { previewIRRebalance(); } finally { previewIRRebalance._deferred = false; }
    return _irrPlan;
  };
  const applyRebalance = async () => { const c0 = window.confirm; window.confirm = () => true; try { await applyIRRebalance(); } finally { window.confirm = c0; } await wait(50); };
  // IR shift builder preview (S.cfg.useSolver picks greedy / MCF) for 2027; returns a copy of _irsaPreview.
  const shiftPreview = async (period, ym) => {
    nav('ir-shift-auto', document.querySelector('.snav-item[data-pg="ir-shift-auto"]'));
    setSel('irsa-yr', '2027'); document.getElementById('irsa-period').value = period; _irsaTogglePeriodInputs();
    document.getElementById('irsa-mo').value = ym || ''; document.getElementById('irsa-grp').value = 'both';
    _irsaPreview = []; previewIRShiftAA._stamp = '';
    if((S.cfg || {}).useSolver === 'mcf'){ previewIRShiftAA(); for(let i = 0; i < 800 && !previewIRShiftAA._stamp; i++) await wait(25); }
    else { previewIRShiftAA._deferred = true; try { previewIRShiftAA(); } finally { previewIRShiftAA._deferred = false; } }
    return _irsaPreview.map(a => Object.assign({}, a));
  };
  return { wait, mkPhys, clear, slots, weekdays, done, setSel, writes, rebalance, applyRebalance, shiftPreview };
}
const LIB = lib.toString();

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=review-v135-fixes');
  await launchSyntheticUser(page, 'superuser');
  await page.evaluate(() => { window.confirm = () => true; window.alert = () => {}; });
});

test('Year-end rollover: a new date that is already a holiday of another season is flagged', async ({ page }) => {
  // Rolling 2026 → 2027. "New Year's Eve" 2026-12-31 lands on 2027-12-31, which the official New Year's Day
  // 2028 block (Jan 1 2028 is a Saturday: observed Fri Dec 31 2027) already holds — filed under 2028, so
  // invisible to a check of the 2027 season only. "NY" 2027 also holds the source date 2026-12-31.
  const r = await page.evaluate(async lib => {
    const L = new Function('return ' + lib)()();
    const nyd28 = officialUSHolidays(2028).find(h => /new year/i.test(h.name));
    const slots = { drSlots: 1, irSlotsByGroup: { North: 1, South: 1 } };
    _isRestoring = true;
    L.clear();
    S.holidayDefs = [
      Object.assign({ id: 21, name: "New Year's Eve", year: 2026, dates: ['2026-12-31'] }, slots),
      Object.assign({ id: 22, name: 'Thanksgiving', year: 2026, dates: ['2026-11-26', '2026-11-27'] }, slots),
      Object.assign({ id: 23, name: 'NY', year: 2027, dates: ['2026-12-31', '2027-01-01'] }, slots),
      Object.assign({ id: 24, name: "New Year's Day", year: 2028, dates: nyd28.dates.slice(), notes: 'Official' }, slots),
    ];
    S.nextId = Math.max(S.nextId || 0, 1000);
    L.done();
    nav('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'reports'); await L.wait(30);
    document.getElementById('yr-target').value = '2027'; previewYearRollover();
    // the plan row, and whether its rendered row in the wizard carries the ⚠ flag
    const shown = n => { const tr = [...document.querySelectorAll('#yr-result tr')].find(x => (x.children[1] || {}).textContent?.trim() === n); return tr ? tr.textContent.includes('⚠') : null; };
    const row = n => { const p = _yrRolloverPlan.items.find(x => x.name === n) || {}; return { status: p.status, dst: p.dst, warn: p.warn || '', flagged: shown(n) }; };
    return { nyd28: nyd28.dates, nye: row("New Year's Eve"), tg: row('Thanksgiving'),
      footnote: [...document.querySelectorAll('#yr-result .note.nw')].length };
  }, LIB);
  expect(r.nyd28).toContain('2027-12-31');
  expect(r.nye.status).toBe('add');
  expect(r.nye.dst).toEqual(['2027-12-31']);
  expect(r.nye.flagged).toBe(true);                    // the admin sees the row flagged (was: no warning)
  expect(r.tg.flagged).toBe(false);
  expect(r.nye.warn).toContain('2027-12-31');          // the target date, shared with …
  expect(r.nye.warn).toContain("New Year's Day");      // … the 2028 season's New Year's Day
  expect(r.nye.warn).toContain('2026-12-31');          // its source date is already "NY" 2027
  expect(r.tg.status).toBe('add');
  expect(r.tg.warn).toBe('');                          // no overlap, no warning
  expect(r.footnote).toBeGreaterThan(0);               // the shared-day footnote is shown
});

// Runs in the page: North (N1, 1 slot) with Caller and Other, South (S1, 1 slot) with Southy. Caller holds
// every N1 shift of H1 2027 (far past their quota) and is on daily IR call on Tue 2027-06-15 — in North, or
// (pool 'South') covering South's call. Their N1 shift that day is the call-paired "Auto (with call)" one.
function onCallPractice(lib, pool){
  const L = new Function('return ' + lib)()();
  _isRestoring = true;
  L.clear();
  S.irGroups = ['North', 'South'];
  S.sites = [{ name: 'N1', irGroup: 'North', irAnchors: [], irFillins: [] }, { name: 'S1', irGroup: 'South', irAnchors: [], irFillins: [] }];
  L.slots({ N1: 1, S1: 1 });
  S.physicians = [L.mkPhys(1, 'Caller', 'North', Object.assign({ irSitePrim: 'N1' }, pool === 'South' ? { irCallPools: ['South'] } : {})),
    L.mkPhys(2, 'Other', 'North', { irSitePrim: 'N1' }), L.mkPhys(3, 'Southy', 'South', { irSitePrim: 'S1' })];
  S.cfg = Object.assign({}, S.cfg, { anchorPct: 80 });
  const CALL = '2027-06-15';
  let id = 7000;
  L.weekdays('2027-01-01', '2027-06-30').forEach(d => {
    S.irShifts.push({ id: id++, physId: 1, date: d, shift: '1st', site: 'N1', irGroup: 'North', slotLabel: '', sub: '', notes: d === CALL ? 'Auto (with call)' : 'Auto' });
    S.irShifts.push({ id: id++, physId: 3, date: d, shift: '1st', site: 'S1', irGroup: 'South', slotLabel: '', sub: '', notes: 'Auto' });
  });
  S.irCalls.push({ id: id++, physId: 1, date: CALL, callType: 'daily', irGroup: pool, site: '', notes: pool === 'North' ? 'Auto' : 'Auto (covering South)' });
  S.nextId = 100000;
  L.done();
  return L;
}
async function dayFillOnCall(lib, prac, pool){
  const L = new Function('return ' + lib)()();
  new Function('return ' + prac)()(lib, pool);
  let plan = null;
  const queued = await L.writes(() => { plan = L.rebalance('day-fill', 'H1'); });
  const holder = (list, d) => (list.find(s => s.date === d && s.site === 'N1') || {}).physId || null;
  const before = { mon: holder(plan.shifts, '2027-06-14'), wed: holder(plan.shifts, '2027-06-16') };
  const applied = await L.writes(() => L.applyRebalance());   // positive control for the counter
  const on = S.irShifts.filter(s => s.date === '2027-06-15' && s.shift !== 'Home').map(s => ({ physId: s.physId, site: s.site, notes: s.notes }));
  return { queued, applied, plan: { call: holder(plan.shifts, '2027-06-15'), ...before }, on };
}

test('Day-Fill keeps the call-paired shift of the physician on IR call who has reached quota', async ({ page }) => {
  const r = await page.evaluate(({ lib, fn, prac }) => (new Function('return ' + fn)())(lib, prac, 'North'),
    { lib: LIB, fn: dayFillOnCall.toString(), prac: onCallPractice.toString() });
  expect(r.queued).toBe(0);                 // the preview writes nothing to S …
  expect(r.applied).toBeGreaterThan(1000);  // … while Apply both changes the schedule and queues its save
  expect(r.plan.mon).toBe(2);               // past quota, Caller gives up their June shifts …
  expect(r.plan.wed).toBe(2);
  expect(r.plan.call).toBe(1);              // … but not the one on their call day
  expect(r.on).toEqual([{ physId: 1, site: 'N1', notes: 'Auto (with call)' }, { physId: 3, site: 'S1', notes: 'Auto' }]);
});

test('Day-Fill keeps the own-group shift of a member covering another pool\'s weekday call', async ({ page }) => {
  // Caller (North) covers South's daily call on 2027-06-15: on call in North too (_irsaXPoolOnCall), as the
  // builders place them — their procedure shift that day stays at their own site. Needs both the on-call
  // quota bypass (review fix) and Day-Fill reading cross-pool calls (call pools): fails on rs-v135, on rs-v135
  // with the review fixes only, and with call pools only.
  const r = await page.evaluate(({ lib, fn, prac }) => (new Function('return ' + fn)())(lib, prac, 'South'),
    { lib: LIB, fn: dayFillOnCall.toString(), prac: onCallPractice.toString() });
  expect(r.queued).toBe(0);
  expect(r.plan.mon).toBe(2);
  expect(r.plan.wed).toBe(2);
  expect(r.plan.call).toBe(1);
  expect(r.on).toEqual([{ physId: 1, site: 'N1', notes: 'Auto (with call)' }, { physId: 3, site: 'S1', notes: 'Auto' }]);
});

// Runs in the page: Holiday Call practice. Pools North / South / Riverview, two North and two South
// physicians and one Riverview physician; Thanksgiving 2026 and 2027 with one IR slot per pool, "NY" 2027
// (Dec 31 2026 + Jan 1 2027). Opens Holiday Call → Assignments. Returns page-side helpers.
async function holidayPractice(lib){
  const L = new Function('return ' + lib)()();
  _isRestoring = true;
  L.clear();
  S.irGroups = ['North', 'South', 'Riverview'];
  S.physicians = [L.mkPhys(501, 'NorthA', 'North'), L.mkPhys(502, 'NorthB', 'North'), L.mkPhys(601, 'SouthA', 'South'), L.mkPhys(602, 'SouthB', 'South'), L.mkPhys(701, 'RiverA', 'Riverview')];
  const sl = { drSlots: 0, irSlotsByGroup: { North: 1, South: 1, Riverview: 1 } };
  S.holidayDefs = [
    Object.assign({ id: 1, name: 'Thanksgiving', year: 2026, dates: ['2026-11-26', '2026-11-27'] }, sl),
    Object.assign({ id: 2, name: 'Thanksgiving', year: 2027, dates: ['2027-11-25', '2027-11-26'] }, sl),
    Object.assign({ id: 3, name: 'NY', year: 2027, dates: ['2026-12-31', '2027-01-01'] }, sl),
  ];
  S.nextId = Math.max(S.nextId || 0, 9000);
  L.done();
  nav('holidays', document.querySelector('.snav-item[data-pg="holidays"]')); await L.wait(20);
  const tabs = () => document.querySelectorAll('#hol-tabs .tab');
  holTab('assignments', tabs()[1]);
  const f = document.getElementById('holf-yr'); if(f) f.value = '';
  return {
    add: (physId, date, group, name, year) => { const h = { id: S.nextId++, name, date, year, physId, group, sub: '', notes: '' }; S.holidays.push(h); return h.id; },
    // how many physicians Auto-Assign would draw for that holiday and pool (0: its slot is filled)
    draws: (name, year, grp) => { holTab('autoassign', tabs()[2]); document.getElementById('haa-year').value = String(year); document.getElementById('haa-grp').value = grp;
      previewHolRandom(); const n = (_holRandomPreview || []).filter(a => a.defName === name && a.group === grp).length; holTab('assignments', tabs()[1]); return n; },
    applyDraws: async (year) => { holTab('autoassign', tabs()[2]); document.getElementById('haa-year').value = String(year); document.getElementById('haa-grp').value = 'all';
      previewHolRandom(); if((_holRandomPreview || []).length) await applyHolRandom(); await L.wait(20); holTab('assignments', tabs()[1]); },
    // inline edit on the Assignments tab: returns the pool the editor showed
    edit: (id, chg) => { startEditHoliday(id); const shown = (document.getElementById(`hol-edit-grp-${id}`) || {}).value;
      Object.entries(chg).forEach(([k, v]) => { const e = document.getElementById(`hol-edit-${k}-${id}`); if(e) e.value = String(v); });
      saveEditHoliday(id); return shown; },
    renameDef: (defId, name) => { holTab('define', tabs()[0]); editHolDef(defId); document.getElementById('holdef-name').value = name; submitHolDef(); holTab('assignments', tabs()[1]); },
    entry: id => { const h = S.holidays.find(x => x.id === id); return h ? { name: h.name, year: h.year, date: h.date, group: h.group, notes: h.notes } : null; },
  };
}
const HOL = holidayPractice.toString();

test('Holiday Call: an inline edit onto a 2027 holiday files the entry under 2027', async ({ page }) => {
  const r = await page.evaluate(async ({ lib, hol }) => {
    const L = new Function('return ' + lib)()();
    const H = await (new Function('return ' + hol)())(lib);
    const id = H.add(501, '2026-11-26', 'IR-North', 'Thanksgiving', 2026);
    let open2027 = 0;
    const queued = await L.writes(() => { open2027 = H.draws('Thanksgiving', 2027, 'IR-North'); });
    H.edit(id, { date: '2027-11-25' });                 // moved to Thanksgiving 2027; the Year box still says 2026
    return { queued, entry: H.entry(id), open2027, after2027: H.draws('Thanksgiving', 2027, 'IR-North'), after2026: H.draws('Thanksgiving', 2026, 'IR-North') };
  }, { lib: LIB, hol: HOL });
  expect(r.queued).toBe(0);        // an Auto-Assign preview writes nothing
  expect(r.open2027).toBe(1);
  expect(r.entry).toEqual({ name: 'Thanksgiving', year: 2027, date: '2027-11-25', group: 'IR-North', notes: '' });
  expect(r.after2027).toBe(0);     // the 2027 slot is filled: Auto-Assign does not draw it again
  expect(r.after2026).toBe(1);     // and the 2026 one is open again
});

test('Define Holidays: renaming a holiday carries its assignments, so Auto-Assign does not staff it twice', async ({ page }) => {
  const r = await page.evaluate(async ({ lib, hol }) => {
    const H = await (new Function('return ' + hol)())(lib);
    const ids = [H.add(501, '2026-11-26', 'IR-North', 'Thanksgiving', 2026), H.add(501, '2026-11-27', 'IR-North', 'Thanksgiving', 2026),
      H.add(601, '2026-11-26', 'IR-South', 'Thanksgiving', 2026), H.add(601, '2026-11-27', 'IR-South', 'Thanksgiving', 2026),
      H.add(701, '2026-11-26', 'IR-Riverview', 'Thanksgiving', 2026), H.add(701, '2026-11-27', 'IR-Riverview', 'Thanksgiving', 2026)];
    H.renameDef(1, 'Thanksgiving Day');
    const draws = ['IR-North', 'IR-South', 'IR-Riverview'].map(g => H.draws('Thanksgiving Day', 2026, g));
    await H.applyDraws(2026);
    const perDay = {};
    S.holidays.filter(h => +h.year === 2026 && ['2026-11-26', '2026-11-27'].includes(h.date)).forEach(h => { const k = h.group + ' ' + h.date; perDay[k] = (perDay[k] || 0) + 1; });
    return { names: ids.map(id => H.entry(id).name + ' ' + H.entry(id).year), draws, perDay };
  }, { lib: LIB, hol: HOL });
  // one physician per pool and day after Auto-Assign, as before the rename (was: two — the old entries under
  // "Thanksgiving" and a fresh draw for "Thanksgiving Day", whose slots looked open)
  expect(r.perDay).toEqual({ 'IR-North 2026-11-26': 1, 'IR-North 2026-11-27': 1, 'IR-South 2026-11-26': 1, 'IR-South 2026-11-27': 1,
    'IR-Riverview 2026-11-26': 1, 'IR-Riverview 2026-11-27': 1 });
  expect(r.draws).toEqual([0, 0, 0]);                              // nothing left to draw
  expect(r.names).toEqual(Array(6).fill('Thanksgiving Day 2026')); // the entries follow the definition
});

test('Holiday Call: an inline edit of an IR-Riverview entry keeps its pool', async ({ page }) => {
  const r = await page.evaluate(async ({ lib, hol }) => {
    const H = await (new Function('return ' + hol)())(lib);
    const id = H.add(701, '2026-12-31', 'IR-Riverview', 'NY', 2027);
    const shown = H.edit(id, { notes: 'swap ok' });     // a notes-only edit
    return { shown, entry: H.entry(id) };
  }, { lib: LIB, hol: HOL });
  expect(r.shown).toBe('IR-Riverview');
  expect(r.entry).toEqual({ name: 'NY', year: 2027, date: '2026-12-31', group: 'IR-Riverview', notes: 'swap ok' });
});

test('Day-Fill: a slot whose only free physician was held for another group\'s mixed site is filled at the end of the day', async ({ page }) => {
  // North: N1, N2, N3 (1 slot each); South: S1 and the mixed site SX (anchor 201, North fill-in 103). On
  // Mondays 103 holds SX instead of N3. Day-Fill (North first) keeps 103 free for SX when N3 comes up, then
  // SX goes back to its anchor 201 — so N3 is retried at the end of the day and 103 takes it.
  const r = await page.evaluate(async lib => {
    const L = new Function('return ' + lib)()();
    _isRestoring = true;
    L.clear();
    S.irGroups = ['North', 'South'];
    S.sites = [{ name: 'N1', irGroup: 'North', irAnchors: [], irFillins: [] }, { name: 'N2', irGroup: 'North', irAnchors: [], irFillins: [] }, { name: 'N3', irGroup: 'North', irAnchors: [], irFillins: [] },
      { name: 'S1', irGroup: 'South', irAnchors: [], irFillins: [] }, { name: 'SX', irGroup: 'South', irAnchors: [201], irFillins: [103] }];
    L.slots({ N1: 1, N2: 1, N3: 1, S1: 1, SX: 1 });
    S.physicians = [L.mkPhys(101, 'N101', 'North'), L.mkPhys(102, 'N102', 'North'), L.mkPhys(103, 'N103', 'North'), L.mkPhys(201, 'S201', 'South', { anchorSite: 'SX' }), L.mkPhys(202, 'S202', 'South')];
    S.cfg = Object.assign({}, S.cfg, { skipUniversalHolidays: false, anchorPct: 70 });
    let id = 900000;
    const days = L.weekdays('2027-01-01', '2027-06-30');
    days.forEach(d => { const mon = parseDateLocal(d).getDay() === 1;
      const sh = (physId, site, irGroup, notes) => S.irShifts.push({ id: id++, physId, date: d, shift: '1st', site, irGroup, slotLabel: '', sub: '', notes: notes || '' });
      sh(101, 'N1', 'North'); sh(102, 'N2', 'North'); if(!mon) sh(103, 'N3', 'North');
      sh(mon ? 103 : 201, 'SX', mon ? 'North' : 'South', mon ? 'Auto (cross-group fill-in)' : ''); sh(202, 'S1', 'South'); });
    S.nextId = 1000000;
    L.done();
    let plan = null;
    const queued = await L.writes(() => { plan = L.rebalance('day-fill', 'H1'); });
    const unfillable = +(((document.getElementById('irr-preview') || {}).textContent || '').match(/Unfillable\s*(\d+)/) || [0, -1])[1];
    await L.applyRebalance();
    const cover = {}, per = {};
    S.irShifts.filter(s => s.date >= '2027-01-01' && s.date <= '2027-06-30' && s.shift !== 'Home').forEach(s => {
      cover[s.date + '|' + s.site] = (cover[s.date + '|' + s.site] || 0) + 1; per[s.physId + '|' + s.date] = (per[s.physId + '|' + s.date] || 0) + 1; });
    const mondays = days.filter(d => parseDateLocal(d).getDay() === 1);
    return { queued, unfillable, planN: plan.shifts.length, slots: days.length * 5,
      empty: days.reduce((n, d) => n + ['N1', 'N2', 'N3', 'S1', 'SX'].filter(s => !cover[d + '|' + s]).length, 0),
      doubles: Object.values(per).filter(v => v > 1).length + Object.values(cover).filter(v => v > 1).length,
      mondays: mondays.length, n3By103: mondays.filter(d => S.irShifts.some(s => s.physId === 103 && s.date === d && s.site === 'N3')).length,
      sxBy201: mondays.filter(d => S.irShifts.some(s => s.physId === 201 && s.date === d && s.site === 'SX')).length };
  }, LIB);
  expect(r.queued).toBe(0);
  expect(r.mondays).toBe(26);
  expect(r.sxBy201).toBe(26);           // SX goes back to its anchor on Mondays …
  expect(r.n3By103).toBe(26);           // … and the fill-in takes N3 instead of leaving it empty
  expect(r.unfillable).toBe(0);
  expect(r.planN).toBe(r.slots);
  expect(r.empty).toBe(0);
  expect(r.doubles).toBe(0);
});

test('Procedure Shifts: an anchor keeps their own mixed site although their allowedSites list leaves it out', async ({ page }) => {
  // North: N1, N2 and the mixed site RV (anchor 101, fill-in 103), 1 slot each. 101's allowedSites is ['N1'];
  // the site's anchor grant overrides that (as in the builders and _irsaEligibleForSlot). 101 holds RV
  // every weekday, 102 N1, 103 N2 on Mon/Wed/Fri.
  const r = await page.evaluate(async lib => {
    const L = new Function('return ' + lib)()();
    _isRestoring = true;
    L.clear();
    S.irGroups = ['North'];
    S.sites = [{ name: 'N1', irGroup: 'North', irAnchors: [], irFillins: [] }, { name: 'N2', irGroup: 'North', irAnchors: [], irFillins: [] },
      { name: 'RV', irGroup: 'North', irAnchors: [101], irFillins: [103] }];
    L.slots({ N1: 1, N2: 1, RV: 1 });
    S.physicians = [L.mkPhys(101, 'Anchor', 'North', { anchorSite: 'RV', allowedSites: ['N1'] }), L.mkPhys(102, 'N102', 'North'), L.mkPhys(103, 'Fillin', 'North')];
    S.cfg = Object.assign({}, S.cfg, { skipUniversalHolidays: false, anchorPct: 70 });
    let id = 900000;
    L.weekdays('2027-01-01', '2027-06-30').forEach(d => { const w = parseDateLocal(d).getDay();
      S.irShifts.push({ id: id++, physId: 101, date: d, shift: '1st', site: 'RV', irGroup: 'North', sub: '', notes: '' });
      S.irShifts.push({ id: id++, physId: 102, date: d, shift: '1st', site: 'N1', irGroup: 'North', sub: '', notes: '' });
      if(w % 2 === 1) S.irShifts.push({ id: id++, physId: 103, date: d, shift: '1st', site: 'N2', irGroup: 'North', sub: '', notes: '' }); });
    S.nextId = 1000000;
    L.done();
    let plan = null;
    const queued = await L.writes(() => { plan = L.rebalance('shifts', 'H1'); });
    const rv = plan.shifts.filter(e => e.site === 'RV');
    return { queued, rv: rv.length, keptBy101: rv.filter(e => e.physId === 101 && !e.constrained).length,
      to: [...new Set(rv.filter(e => e.physId !== 101).map(e => e.physId))], constrained: (plan.failedS || []).length };
  }, LIB);
  expect(r.queued).toBe(0);
  expect(r.rv).toBe(129);
  expect(r.constrained).toBe(0);            // nobody left on a shift they "cannot" work
  expect(r.keptBy101).toBeGreaterThan(100); // the anchor keeps (nearly all) their RV shifts
  r.to.forEach(id => expect(id).toBe(103)); // what moves goes to the site's fill-in
});

test('Greedy builder: the slot rotation keeps a "max 1 day in a row on CHN1" rule', async ({ page }) => {
  // CHN: 2 labelled slots (CHN1, CHN2) every weekday, two physicians who both work every weekday, each with a
  // site sequence rule on the slot label CHN1. The rotation's day-of-month offset repeats from Mar 31 to Apr 1.
  const r = await page.evaluate(async lib => {
    const L = new Function('return ' + lib)()();
    _isRestoring = true;
    L.clear();
    S.irGroups = ['North', 'South'];
    S.sites = [{ name: 'CHN', irGroup: 'North', irAnchors: [], irFillins: [] }];
    L.slots({ CHN: 2 }, { CHN: ['CHN1', 'CHN2'] });
    S.physicians = [1, 2].map(i => L.mkPhys(i, 'P' + i, 'North', { irSitePrim: 'CHN', siteSeqRules: [{ site: 'CHN', slotLabel: 'CHN1', maxConsec: 1 }] }));
    S.cfg = Object.assign({}, S.cfg, { useSolver: 'greedy', anchorPct: 80 });
    L.done();
    let pv = [];
    const queued = await L.writes(async () => { pv = await L.shiftPreview('H1'); });
    const on1 = new Set(pv.filter(a => a.slotLabel === 'CHN1').map(a => a.physId + '|' + a.date));
    const perDay = {}; pv.forEach(a => { (perDay[a.date] = perDay[a.date] || []).push(a.slotLabel); });
    return { queued, n: pv.length,
      breaks: pv.filter(a => a.slotLabel === 'CHN1' && on1.has(a.physId + '|' + addDays(a.date, 1))).map(a => a.physId + ' ' + a.date),
      days: Object.keys(perDay).length, twoLabels: Object.values(perDay).filter(l => [...l].sort().join() === 'CHN1,CHN2').length };
  }, LIB);
  expect(r.queued).toBe(0);
  expect(r.n).toBe(2 * r.days);
  expect(r.twoLabels).toBe(r.days);        // each day: one on CHN1, one on CHN2
  expect(r.breaks).toEqual([]);            // nobody on CHN1 two days running (was: Mar 31 + Apr 1)
});

test('A per-site "max days in a row" cap only blocks a shift at its own site', async ({ page }) => {
  const r = await page.evaluate(async lib => {
    const L = new Function('return ' + lib)()();
    // Unit: siteRules [{site: NA, maxConsec: 1}], an NA shift on Mon 2027-03-01.
    _isRestoring = true;
    L.clear();
    S.irGroups = ['North', 'South'];
    S.sites = [{ name: 'NA', irGroup: 'North', irAnchors: [], irFillins: [] }, { name: 'NB', irGroup: 'North', irAnchors: [], irFillins: [] }];
    const p = L.mkPhys(1, 'Solo', 'North', { irSitePrim: 'NA', siteRules: [{ site: 'NA', maxConsec: 1 }] });
    S.physicians = [p];
    S.irShifts = [{ id: 10, physId: 1, date: '2027-03-01', shift: '1st', site: 'NA', irGroup: 'North', notes: '', sub: '', slotLabel: '' }];
    L.done();
    const unit = { otherSite: !!sequenceOk(p, '2027-03-02', '2027-03', 'NB', ''), sameSite: !!sequenceOk(p, '2027-03-02', '2027-03', 'NA', ''),
      noSite: !!sequenceOk(p, '2027-03-02', '2027-03', '', '') };
    // Builder: Solo alone, NA on Mon/Wed/Fri, NB on Tue/Thu — March 2027 needs them every weekday.
    _isRestoring = true;
    S.irShifts = [];
    L.slots({ NA: d => (d === 1 || d === 3 || d === 5) ? 1 : 0, NB: d => (d === 2 || d === 4) ? 1 : 0 });
    S.cfg = Object.assign({}, S.cfg, { useSolver: 'greedy', anchorPct: 80 });
    L.done();
    const pv = await L.shiftPreview('month', '2027-03');
    return { unit, n: pv.length, days: L.weekdays('2027-03-01', '2027-03-31').length, relaxed: pv.filter(a => /relax/i.test(a.notes || '')).length };
  }, LIB);
  expect(r.unit.otherSite).toBe(true);   // NB the day after NA: allowed (was blocked)
  expect(r.unit.sameSite).toBe(false);   // NA two days running: still blocked
  expect(r.unit.noSite).toBe(false);     // a caller naming no site still gets the cap
  expect(r.n).toBe(r.days);
  expect(r.relaxed).toBe(0);             // no shift needed the rule relaxed (was: every NB day)
});

// rs-v135 (live, Vercel) on the practice below: Feb 2027, 19 weekdays × 4 slots. (The GitHub Pages mirror,
// whose managed blocks are regenerated from older src/parts, gives a different plan here — rs-v135's mirror too.)
const EXPECT_MCF = { n: 76, hash: '5a3bb185' };
test('MCF builder: the fast solver gives the same plan as the original one (fixed small case)', async ({ page }) => {
  const r = await page.evaluate(async lib => {
    const L = new Function('return ' + lib)()();
    _isRestoring = true;
    L.clear();
    const mk = (id, last, fte, anchor) => L.mkPhys(id, last, 'South', { irFte: fte, anchorSite: anchor, irSitePrim: anchor || 'CHS', allowedSites: ['CHS', 'STFS'] });
    S.irGroups = ['North', 'South'];
    S.physicians = [mk(1, 'ChsA', 1, 'CHS'), mk(2, 'ChsB', 1, 'CHS'), mk(3, 'StfsA', 1, 'STFS'), mk(4, 'StfsB', 0.5, 'STFS'), mk(5, 'Float', 1, null)];
    S.sites = [{ name: 'CHS', irGroup: 'South', irAnchors: [], irFillins: [] }, { name: 'STFS', irGroup: 'South', irAnchors: [], irFillins: [] }];
    L.slots({ CHS: 2, STFS: 2 }, { CHS: ['CHS1', 'CHS2'], STFS: ['STFS1', 'STFS2'] });
    S.physicians[1].seqRules = { maxConsec: 3 };
    S.physicians[2].siteSeqRules = [{ site: 'STFS', slotLabel: 'STFS1', minRest: 1 }];
    S.irCalls = ['2027-02-03', '2027-02-10', '2027-02-17'].map((d, i) => ({ id: 800 + i, physId: 5, date: d, callType: 'daily', irGroup: 'South', site: '', notes: 'Auto' }));
    S.vacations = [{ id: 900, physId: 1, start: '2027-02-08', end: '2027-02-12', type: 'Vacation' }];
    S.cfg = Object.assign({}, S.cfg, { useSolver: 'mcf', anchorPct: 80 });
    L.done();
    const sig = pv => pv.map(a => [a.physId, a.date, a.site, a.slotLabel || '', a.shift, a.notes || ''].join('|')).sort().join('\n');
    const hash = s => { let h = 0x811c9dc5; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
    const fast = typeof _mcfSolveFast === 'function' ? _mcfSolveFast : null;
    let used = 0;
    if(fast) _mcfSolveFast = function(){ const out = fast.apply(this, arguments); if(out) used++; return out; };
    let a = [], b = [];
    try {
      a = await L.shiftPreview('month', '2027-02');
      if(fast) _mcfSolveFast = null;                  // the original loop inside _mcfSolve
      b = await L.shiftPreview('month', '2027-02');
    } finally { if(fast) _mcfSolveFast = fast; }
    return { n: a.length, hash: hash(sig(a)), same: sig(a) === sig(b), fast: !!fast, used };
  }, LIB);
  expect(r.n).toBe(EXPECT_MCF.n);
  expect(r.hash).toBe(EXPECT_MCF.hash);    // rs-v135's plan for this practice, byte for byte
  expect(r.same).toBe(true);
  expect(r.fast).toBe(true);
  expect(r.used).toBeGreaterThan(0);        // the fast solver ran (and did not decline the network)
});
