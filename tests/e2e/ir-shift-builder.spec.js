// IR shift auto-assign (rs-v129).
//
// The min-cost-flow solver put one physician on two (or three) slots of the
// same day and on days they were on vacation — e.g. Healey on both STFS slots
// on 2027-01-08 during a vacation week. The greedy solver sent anchored
// physicians to the other site while colleagues anchored there sat idle.
// Apply replaced every non-Home IR shift from July to December whatever
// period was previewed.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// Runs in the page: one South group, two sites (CHS 2 slots, STFS 2 slots every weekday).
function buildPractice(solver) {
  _isRestoring = true;
  const mk = (id, last, fte, anchor, extra) => Object.assign({
    id, first: 'T', last, role: 'IR', drFte: 0, irFte: fte, irGroup: 'South', anchorSite: anchor, irSitePrim: anchor || 'CHS', drSubs: [], irSubs: [], address: '',
    shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: ['CHS', 'STFS'],
  }, extra || {});
  S.physicians = [mk(1, 'ChsA', 1, 'CHS'), mk(2, 'ChsB', 1, 'CHS'), mk(3, 'StfsA', 1, 'STFS'), mk(4, 'StfsB', 1, 'STFS'), mk(5, 'Float', 0.5, null)];
  S.sites = [{ name: 'CHS', irGroup: 'South', irAnchors: [], irFillins: [] }, { name: 'STFS', irGroup: 'South', irAnchors: [], irFillins: [] }];
  S.irShiftSlots = {}; ['CHS', 'STFS'].forEach(site => { for (let d = 0; d < 7; d++) S.irShiftSlots[`${site}|${d}|1st`] = (d >= 1 && d <= 5) ? 2 : 0; });
  S.irShiftSlotLabels = { 'STFS|5|1st#0': 'SF1', 'STFS|5|1st#1': 'SF2' };
  S.irCalls = []; S.irShifts = []; S.drShifts = []; S.holidays = []; S.holidayDefs = []; S.weekendCalls = []; S.natLangRules = []; S.tumorBoards = []; S.clinics = [];
  S.vacations = [
    { id: 7001, physId: 3, start: '2027-01-02', end: '2027-01-10', type: 'Vacation' },   // StfsA away the first full week
    { id: 7002, physId: 1, start: '2027-01-16', end: '2027-01-24', type: 'Vacation' },
  ];
  S.cfg = Object.assign({}, S.cfg, { useSolver: solver, anchorPct: 80 });
  _isRestoring = false;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
}
// Runs in the page: preview one month and summarise it.
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
  const pv = _irsaPreview.slice();
  const perDay = {}; pv.forEach(a => { const k = a.physId + '|' + a.date; perDay[k] = (perDay[k] || 0) + 1; });
  const away = pv.filter(a => _awayDays(a.physId).has(a.date)).map(a => `${a.physId}:${a.date}`);
  const anchored = S.physicians.filter(p => p.anchorSite).map(p => { const mine = pv.filter(a => a.physId === p.id); return { last: p.last, n: mine.length, atAnchor: mine.filter(a => a.site === p.anchorSite).length }; });
  return { n: pv.length, doubles: Object.values(perDay).filter(v => v > 1).length, away, anchored, text: document.getElementById('irsa-box').textContent.replace(/\s+/g, ' ') };
}
const FN = { build: buildPractice.toString(), preview: previewMonth.toString() };

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=ir-shift-builder');
  await launchSyntheticUser(page, 'superuser');
});

for (const solver of ['mcf', 'greedy']) {
  test(`${solver}: one slot per physician per day, nobody on vacation, anchors kept at their own site`, async ({ page }) => {
    const r = await page.evaluate(async ({ build, preview, solver }) => {
      const run = new Function('return ' + preview)();
      new Function('return ' + build)()(solver);
      return await run('2027-01');
    }, { ...FN, solver });
    expect(r.n).toBeGreaterThan(60);
    expect(r.doubles).toBe(0);                                 // was: the same physician on SF1 and SF2
    expect(r.away).toEqual([]);                                // was: placed during a vacation week
    r.anchored.forEach(x => expect(x.atAnchor / x.n, `${x.last}: ${x.atAnchor} of ${x.n} at anchor`).toBeGreaterThanOrEqual(0.8));
  });
}

test('Apply adds the previewed month only, keeps every existing shift, and is refused when the schedule changed', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    // (functions are created before the first await: the page's CSP forbids new Function() later)
    const run = new Function('return ' + preview)(), mk = new Function('return ' + build)();
    mk('mcf');
    S.irShifts.push({ id: 880001, physId: 2, date: '2027-03-10', shift: '1st', site: 'CHS', irGroup: 'South', notes: 'Manual', sub: '' });
    S.irShifts.push({ id: 880002, physId: 4, date: '2027-08-11', shift: '1st', site: 'STFS', irGroup: 'South', notes: 'Manual', sub: '' });
    S.irShifts.push({ id: 880003, physId: 1, date: '2027-01-12', shift: '1st', site: 'CHS', irGroup: 'South', notes: 'Manual', sub: '' });
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const asked = []; const realConfirm = window.confirm, realAlert = window.alert;
    window.confirm = m => { asked.push(String(m)); return true; }; window.alert = m => { asked.push(String(m)); };
    const out = {};
    const p1 = await run('2027-01');
    const before = S.irShifts.length;
    applyIRShiftAA(); await new Promise(res => setTimeout(res, 200));
    out.first = { previewed: p1.n, added: S.irShifts.length - before, kept: [880001, 880002, 880003].map(id => S.irShifts.some(s => s.id === id)),
      outside: S.irShifts.filter(s => !s.date.startsWith('2027-01')).length, confirm: asked[asked.length - 1] };
    // a fresh preview, then the schedule changes before Apply
    mk('mcf');
    await run('2027-02');
    S.irShifts.push({ id: 880009, physId: 5, date: '2027-02-17', shift: '1st', site: 'CHS', irGroup: 'South', notes: 'Manual', sub: '' });
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const b2 = S.irShifts.length;
    applyIRShiftAA(); await new Promise(res => setTimeout(res, 200));
    out.stale = { added: S.irShifts.length - b2, box: document.getElementById('irsa-box').textContent };
    window.confirm = realConfirm; window.alert = realAlert;
    return out;
  }, FN);
  expect(r.first.added).toBe(r.first.previewed);
  expect(r.first.kept).toEqual([true, true, true]);          // was: everything from July to December deleted
  expect(r.first.outside).toBe(2);
  expect(r.first.confirm).toContain('Existing shifts are kept');
  expect(r.stale.added).toBe(0);
  expect(r.stale.box).toContain('Click Preview again');
});

test('Clear Period removes only the selected half-month', async ({ page }) => {
  const r = await page.evaluate(({ build }) => {
    new Function('return ' + build)()('mcf');
    [['2027-01-05', 1], ['2027-01-14', 3], ['2027-01-15', 2], ['2027-01-16', 4], ['2027-02-03', 1], ['2027-07-07', 2]].forEach(([d, pid], i) =>
      S.irShifts.push({ id: 881000 + i, physId: pid, date: d, shift: '1st', site: 'CHS', irGroup: 'South', notes: 'Manual', sub: '' }));
    S.irShifts.push({ id: 881100, physId: 5, date: '2027-01-06', shift: 'Home', site: 'At Home / Remote', irGroup: 'South', notes: '', sub: '' });
    nav('ir-shift-auto', document.querySelector('.snav-item[data-pg="ir-shift-auto"]'));
    const sy = document.getElementById('irsa-yr');
    if (![...sy.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; sy.appendChild(o); }
    sy.value = '2027'; document.getElementById('irsa-period').value = 'semi-1'; _irsaTogglePeriodInputs();
    document.getElementById('irsa-mo').value = '2027-01'; document.getElementById('irsa-grp').value = 'both';
    const realConfirm = window.confirm; let asked = ''; window.confirm = m => { asked = String(m); return true; };
    clearIRShiftsPeriod();
    window.confirm = realConfirm;
    return { left: S.irShifts.map(s => s.date + (s.shift === 'Home' ? ' Home' : '')).sort(), asked };
  }, FN);
  expect(r.left).toEqual(['2027-01-06 Home', '2027-01-16', '2027-02-03', '2027-07-07']);   // was: July cleared, January untouched
  expect(r.asked).toContain('2027-01-01 to 2027-01-15');
});

test('min-cost-flow fills every slot the greedy can when colleagues are away for months (no ceiling on extra shifts)', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    const run = new Function('return ' + preview)(), mk = new Function('return ' + build)();
    const count = async solver => {
      mk(solver);
      S.vacations.push({ id: 7101, physId: 3, start: '2027-01-01', end: '2027-01-31', type: 'Vacation' });
      S.vacations.push({ id: 7102, physId: 4, start: '2027-01-01', end: '2027-01-31', type: 'Vacation' });
      if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
      return await run('2027-01');
    };
    return { mcf: await count('mcf'), greedy: await count('greedy') };
  }, FN);
  // Two of five away all month: the other three can hold at most three of the four daily slots.
  expect(r.mcf.doubles).toBe(0);
  expect(r.mcf.away).toEqual([]);
  expect(r.mcf.n).toBe(r.greedy.n);                          // was: stopped at quota + 10 and called the rest unfillable
});

test('Rebalance → Procedure Shifts never double-books, keeps every shift and its slot label', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    const run = new Function('return ' + preview)(), mk = new Function('return ' + build)();
    mk('mcf');
    await run('2027-01');
    const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
    applyIRShiftAA(); await new Promise(res => setTimeout(res, 200));
    // skew it: hand a third of StfsB's January shifts to StfsA (still on legal days), as a manual edit would
    S.irShifts.filter(x => x.physId === 4).forEach((x, i) => { if (i % 3 === 0 && !_awayDays(3).has(x.date) && !S.irShifts.some(y => y.physId === 3 && y.date === x.date)) x.physId = 3; });
    S.irShifts.forEach((x, i) => { if (!x.slotLabel) x.slotLabel = 'L' + (i % 4); });
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const before = S.irShifts.map(x => x.id + '|' + x.date + '|' + x.site + '|' + x.slotLabel).sort();
    nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
    const ry = document.getElementById('irr-yr'); if (![...ry.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ry.appendChild(o); }
    ry.value = '2027'; document.getElementById('irr-period').value = 'H1'; document.getElementById('irr-grp').value = 'both'; document.getElementById('irr-type').value = 'shifts';
    _irrPlan = null; previewIRRebalance();
    await new Promise(res => setTimeout(res, 300));
    for (let i = 0; i < 600 && !_irrPlan; i++) await new Promise(res => setTimeout(res, 50));
    await applyIRRebalance(); await new Promise(res => setTimeout(res, 300));
    window.confirm = realConfirm; window.alert = realAlert;
    const perDay = {}; S.irShifts.filter(x => x.shift !== 'Home').forEach(x => { const k = x.physId + '|' + x.date; perDay[k] = (perDay[k] || 0) + 1; });
    return { hadPlan: !!_irrPlan || true, before, after: S.irShifts.map(x => x.id + '|' + x.date + '|' + x.site + '|' + x.slotLabel).sort(),
      doubles: Object.values(perDay).filter(v => v > 1).length, away: S.irShifts.filter(x => _awayDays(x.physId).has(x.date)).length };
  }, FN);
  expect(r.doubles).toBe(0);                                   // was: the kept original booked on a second slot that day
  expect(r.away).toBe(0);
  expect(r.after).toEqual(r.before);                           // same shifts (ids, dates, sites, labels): only the physician may change
});

test('a call-day rule set to "IR daily call only" stays that way after data arrives from another session', async ({ page }) => {
  const r = await page.evaluate(({ build }) => {
    new Function('return ' + build)()('mcf');
    S.cfg._cdrAnyCallMigrated = true;                           // what the one-time migration leaves behind
    S.physicians[0].callDayRules = [{ callType: 'ir-call', requiredSite: 'CHS', notes: '' }];
    const blob = JSON.parse(JSON.stringify({ ...S, _schemaVersion: _SCHEMA_VERSION }));
    _applyRemoteData(blob); _applyRemoteData(blob);
    return S.physicians.find(p => p.id === 1).callDayRules.map(x => x.callType);
  }, FN);
  expect(r).toEqual(['ir-call']);                              // was: rewritten to 'any-call' on every load
});
