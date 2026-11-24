// Rules checked against the plan being built, Rebalance notes and Day-Fill in place,
// and the Define Holidays form (rs-v134).
//
// The IR shift builders and Rebalance → Procedure Shifts read sequence rules
// (at most N days in a row, rest days) from the saved schedule only, so a preview
// gave a physician with "at most 2 in a row" runs of 5. A reassigned shift kept
// the previous holder's note ("Auto-paired with IR call"), so removing a call could
// delete the wrong physician's shift. Day-Fill deleted and recreated every shift
// of the period (ids and slot labels lost). The Define Holidays form lost its
// dates when another session saved while it was open.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// Runs in the page: one South group, two sites (CHS 2 slots, STFS 2 slots every weekday).
function buildPractice(solver) {
  _isRestoring = true;
  const mk = (id, last, fte, anchor, extra) => Object.assign({
    id, first: 'T', last, role: 'IR', drFte: 0, irFte: fte, irGroup: 'South', anchorSite: anchor, irSitePrim: anchor || 'CHS', drSubs: [], irSubs: [], address: '',
    shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: ['CHS', 'STFS'],
  }, extra || {});
  S.physicians = [mk(1, 'ChsA', 1, 'CHS', { seqRules: { maxConsec: 2 } }), mk(2, 'ChsB', 1, 'CHS'), mk(3, 'StfsA', 1, 'STFS'), mk(4, 'StfsB', 1, 'STFS'), mk(5, 'Float', 0.5, null)];
  S.sites = [{ name: 'CHS', irGroup: 'South', irAnchors: [], irFillins: [] }, { name: 'STFS', irGroup: 'South', irAnchors: [], irFillins: [] }];
  S.irShiftSlots = {}; ['CHS', 'STFS'].forEach(site => { for (let d = 0; d < 7; d++) S.irShiftSlots[`${site}|${d}|1st`] = (d >= 1 && d <= 5) ? 2 : 0; });
  S.irShiftSlotLabels = {};
  S.irCalls = []; S.irShifts = []; S.drShifts = []; S.holidays = []; S.holidayDefs = []; S.weekendCalls = []; S.natLangRules = []; S.tumorBoards = []; S.clinics = []; S.vacations = [];
  S.cfg = Object.assign({}, S.cfg, { useSolver: solver, anchorPct: 80 });
  _isRestoring = false;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
}
// Runs in the page: preview one month of IR shifts; returns the preview rows.
async function previewMonth(ym) {
  nav('ir-shift-auto', document.querySelector('.snav-item[data-pg="ir-shift-auto"]'));
  const sy = document.getElementById('irsa-yr');
  if (![...sy.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; sy.appendChild(o); }
  sy.value = '2027';
  document.getElementById('irsa-period').value = 'month'; _irsaTogglePeriodInputs();
  document.getElementById('irsa-mo').value = ym; document.getElementById('irsa-grp').value = 'both';
  _irsaPreview = []; previewIRShiftAA();
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 600 && (document.getElementById('irsa-progress') || !_irsaPreview.length); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 150));
  return _irsaPreview.slice();
}
// Runs in the page: longest run of consecutive days physician pid works in rows.
function longestRun(rows, pid) {
  const ds = new Set(rows.filter(s => s.physId === pid && s.shift !== 'Home').map(s => s.date)); let best = 0;
  ds.forEach(d => { let n = 1, x = d; while (ds.has(addDays(x, -1))) { n++; x = addDays(x, -1); } best = Math.max(best, n); });
  return best;
}
// Runs in the page: Rebalance one half-year of procedure shifts ('shifts' or 'day-fill'); applies it.
async function rebalance(type, period) {
  nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
  const ry = document.getElementById('irr-yr'); if (![...ry.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ry.appendChild(o); }
  ry.value = '2027'; document.getElementById('irr-period').value = period || 'H1'; document.getElementById('irr-grp').value = 'both'; document.getElementById('irr-type').value = type;
  const dirty = _dirtySeq, undo = _undoStack.length;
  _irrPlan = null; previewIRRebalance();
  await new Promise(res => setTimeout(res, 300));
  for (let i = 0; i < 600 && !_irrPlan; i++) await new Promise(res => setTimeout(res, 50));
  const previewSideEffects = { dirty: _dirtySeq - dirty, undo: _undoStack.length - undo };
  const swaps = (_irrPlan && _irrPlan.swapsS) || 0;
  await applyIRRebalance(); await new Promise(res => setTimeout(res, 300));
  return { swaps, previewSideEffects };
}
const FN = { build: buildPractice.toString(), preview: previewMonth.toString(), run: longestRun.toString(), rebal: rebalance.toString() };

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=rule-plan');
  await launchSyntheticUser(page, 'superuser');
});

for (const solver of ['mcf', 'greedy']) {
  test(`${solver}: "at most 2 days in a row" holds inside the preview when colleagues can cover`, async ({ page }) => {
    const r = await page.evaluate(async ({ build, preview, run, solver }) => {
      const pv = new Function('return ' + preview)(), lr = new Function('return ' + run)();
      new Function('return ' + build)()(solver);
      const rows = await pv('2027-02');
      const perDay = {}; rows.forEach(a => { const k = a.physId + '|' + a.date; perDay[k] = (perDay[k] || 0) + 1; });
      return { n: rows.length, chsA: rows.filter(a => a.physId === 1).length, run: lr(rows, 1), doubles: Object.values(perDay).filter(v => v > 1).length };
    }, { ...FN, solver });
    expect(r.n).toBe(76);                                       // every slot: 19 weekdays (Presidents' Day off) × 4, five physicians
    expect(r.doubles).toBe(0);
    expect(r.chsA).toBeGreaterThan(8);
    expect(r.run).toBeLessThanOrEqual(2);                       // was: 3-5 days in a row (the rule only saw saved shifts)
  });
}

test('Rebalance → Procedure Shifts keeps a sequence rule against its own plan, gives moved shifts their own note, and a preview changes nothing', async ({ page }) => {
  const r = await page.evaluate(async ({ run, rebal }) => {
    const lr = new Function('return ' + run)(), rb = new Function('return ' + rebal)();
    _isRestoring = true;
    const mk = (id, last, rule) => ({ id, first: 'F', last, role: 'IR', drFte: 0, irFte: 1, irGroup: 'North', drSubs: [], irSubs: [], address: '', anchorSite: null,
      shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [], seqRules: rule });
    S.physicians = [mk(1, 'A', { maxConsec: 2 }), mk(2, 'B', null)];
    S.sites = [{ id: 500, name: 'NS0', irGroup: 'North', irAnchors: [], irFillins: [] }];
    S.irShiftSlots = {}; for (let d = 1; d <= 5; d++) S.irShiftSlots[`NS0|${d}|1st`] = 1; S.irShiftSlotLabels = {};
    S.drShifts = []; S.irCalls = []; S.clinics = []; S.natLangRules = []; S.tumorBoards = []; S.holidays = []; S.holidayDefs = []; S.weekendCalls = []; S.vacations = [];
    S.irShifts = []; let id = 74000;
    ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'].forEach(ym => buildCal(ym).forEach(c => { if (!c.day || c.dow < 1 || c.dow > 5) return;
      S.irShifts.push({ id: id++, physId: 2, date: c.date, shift: '1st', site: 'NS0', irGroup: 'North', notes: 'Auto-paired with IR call', sub: '', slotLabel: '' }); }));
    S.cfg = Object.assign({}, S.cfg, { useSolver: 'greedy', skipUniversalHolidays: true, anchorPct: 70 });
    _isRestoring = false; if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
    const before = new Map(S.irShifts.map(s => [s.id, s.physId])), total = S.irShifts.length;
    const first = await rb('shifts', 'H1');
    const moved = S.irShifts.filter(s => before.get(s.id) !== s.physId);
    const second = await rb('shifts', 'H1');
    window.confirm = realConfirm; window.alert = realAlert;
    return { total, after: S.irShifts.length, a: S.irShifts.filter(s => s.physId === 1).length, run: lr(S.irShifts, 1), moved: moved.length,
      movedNotes: [...new Set(moved.map(s => s.notes))], preview: first.previewSideEffects, second: second.swaps };
  }, FN);
  expect(r.after).toBe(r.total);
  expect(r.a).toBeGreaterThan(40);                             // A takes a fair part of the half-year…
  expect(r.run).toBeLessThanOrEqual(2);                        // …never more than 2 days in a row (was: runs of 5)
  expect(r.movedNotes).toEqual(['Rebalanced']);                // was: the old holder's 'Auto-paired with IR call'
  expect(r.preview).toEqual({ dirty: 0, undo: 0 });            // previewing neither saves nor touches undo
  expect(r.second).toBe(0);
});

test('Rebalance → Day-Fill keeps shift ids and slot labels', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, rebal }) => {
    const pv = new Function('return ' + preview)(), mk = new Function('return ' + build)(), rb = new Function('return ' + rebal)();
    mk('mcf');
    S.physicians[0].seqRules = null;
    const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
    await pv('2027-01'); applyIRShiftAA(); await new Promise(res => setTimeout(res, 200));
    S.irShifts.forEach((x, i) => { x.slotLabel = 'L' + (i % 4); });
    // a manual skew: Float hands a third of their January shifts to ChsB where ChsB is free
    S.irShifts.filter(x => x.physId === 5).forEach((x, i) => { if (i % 3 === 0 && !S.irShifts.some(y => y.physId === 2 && y.date === x.date)) x.physId = 2; });
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const before = new Map(S.irShifts.map(x => [x.id, x.date + '|' + x.site + '|' + x.slotLabel]));
    await rb('day-fill', 'H1');
    window.confirm = realConfirm; window.alert = realAlert;
    const kept = S.irShifts.filter(x => before.has(x.id));
    const perDay = {}; S.irShifts.filter(x => x.shift !== 'Home').forEach(x => { const k = x.physId + '|' + x.date; perDay[k] = (perDay[k] || 0) + 1; });
    return { before: before.size, kept: kept.length, sameSlot: kept.every(x => before.get(x.id) === x.date + '|' + x.site + '|' + x.slotLabel),
      labelled: S.irShifts.filter(x => x.slotLabel).length, doubles: Object.values(perDay).filter(v => v > 1).length };
  }, FN);
  expect(r.kept / r.before).toBeGreaterThan(0.9);              // was: every shift deleted and recreated (0 ids kept)
  expect(r.sameSlot).toBe(true);
  expect(r.labelled).toBeGreaterThanOrEqual(r.kept);           // was: every slot label lost
  expect(r.doubles).toBe(0);
});

test('Define Holidays keeps the open holiday\'s dates when another session saves, and a new holiday\'s Year follows its dates', async ({ page }) => {
  const r = await page.evaluate(() => {
    _isRestoring = true;
    S.holidayDefs = [{ id: 9001, name: 'Christmas Day', year: 2027, dates: ['2027-12-24', '2027-12-25'], drSlots: 1, irSlotsByGroup: {} },
      { id: 9002, name: 'Labor Day', year: 2027, dates: ['2027-09-06'], drSlots: 1, irSlotsByGroup: {} }];
    S.holidays = [];
    _isRestoring = false;
    const $ = id => document.getElementById(id);
    const chips = () => [...document.querySelectorAll('#holdef-dates-list > span')].map(s => s.textContent.replace('×', '').trim());
    const addDate = dt => { $('holdef-add-date').value = dt; holdefAddDate(); };
    const remote = mut => {
      const d = {}; _PERSISTED_KEYS.forEach(k => { if (S[k.key] !== undefined) d[k.key] = JSON.parse(JSON.stringify(S[k.key])); });
      mut(d); S._lastLocalChange = 0; S._lastSaved = new Date(); d.savedAt = new Date(Date.now() + 60000).toISOString();
      _applyRemoteData(d); _refreshCurrentPage();
    };
    const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
    nav('holidays', document.querySelector('.snav-item[data-pg="holidays"]')); holTab('define');
    editHolDef(9001);
    remote(d => { d.holidayDefs.find(x => x.id === 9002).notes = 'remote edit'; });
    const chipsAfterRemote = chips();
    addDate('2027-12-27'); submitHolDef();
    const saved = S.holidayDefs.find(x => x.id === 9001).dates.slice().sort();
    const remoteKept = S.holidayDefs.find(x => x.id === 9002).notes;
    cancelHolDef();
    $('holdef-name').value = 'Thanksgiving'; $('holdef-name').dispatchEvent(new Event('input')); addDate('2027-11-25');
    const thanks = $('holdef-year').value; cancelHolDef();
    $('holdef-name').value = "New Year's Day"; $('holdef-name').dispatchEvent(new Event('input'));
    ['2028-12-30', '2028-12-31', '2029-01-01'].forEach(addDate);
    const ny = $('holdef-year').value; cancelHolDef();
    window.confirm = realConfirm; window.alert = realAlert;
    return { chipsAfterRemote: chipsAfterRemote.length, saved, remoteKept, thanks, ny };
  });
  expect(r.chipsAfterRemote).toBe(2);                          // was: 0 (the refresh cleared the form)
  expect(r.saved).toEqual(['2027-12-24', '2027-12-25', '2027-12-27']);   // was: only the new date
  expect(r.remoteKept).toBe('remote edit');
  expect(r.thanks).toBe('2027');                               // was: always 2026
  expect(r.ny).toBe('2029');                                   // the Sat-to-Mon New Year block belongs to the January year
});
