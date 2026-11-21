// Physician start date (rs-v127).
//
// A physician with p.startDate ('YYYY-MM-DD'):
//   1. is never auto-assigned before that date, and
//   2. in the year they start carries call sized by FTE × the fraction of the
//      year they are on staff (start Jul 1 at 1.0 FTE ≈ 0.5).
// Physicians without a start date must behave exactly as before.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// Runs in the page: a small, fully synthetic practice.
function buildPractice({ n = 12, starter = null, capBase = 8, needs = { '': { day: 1, swing: 1 } }, holNeeds = { '': { day: 2, swing: 1 } }, year = 2027 } = {}) {
  _isRestoring = true;                               // build state without queueing saves
  const mk = i => ({
    id: 1000 + i, first: 'P' + i, last: 'Doc' + String(i).padStart(2, '0'), degree: 'MD', role: 'DR',
    drFte: 1, irFte: 0, drFteDay: null, drSubs: [], irSubs: [], address: '1 Main St, Columbus, OH 43004',
    shiftElig: { s1: true, s2: false, s3: false, home: true, wknd: true, wkndSwingOnly: false },
    allowedSites: [], siteRules: [], irCallBlackouts: [], dayConditions: [], tbRules: [], callDayRules: [], siteSeqRules: [],
  });
  S.physicians = Array.from({ length: n }, (_, i) => mk(i + 1));
  if (starter) Object.assign(S.physicians[0], starter);
  S.vacations = []; S.weekendCalls = []; S.holidays = []; S.openShifts = []; S.irCalls = []; S.drShifts = []; S.irShifts = [];
  S.natLangRules = []; S.drSubs = [];
  S.wkndNeeds = needs; S.holNeeds = holNeeds;
  S.cfg = Object.assign({}, S.cfg, { wkndYearCapBase: capBase, wkndSummerCap: 2, holidayBlockGap: 0 });
  const H = (name, dates) => ({ id: 9000 + S.holidayDefs.length, name, year, dates, drSlots: 3, irSlotsByGroup: {} });
  S.holidayDefs = [];
  [["New Year's Day", [`${year}-01-01`]], ['Memorial Day', [`${year}-05-29`, `${year}-05-30`, `${year}-05-31`]],
   ['Independence Day', [`${year}-07-03`, `${year}-07-04`, `${year}-07-05`]], ['Labor Day', [`${year}-09-04`, `${year}-09-05`, `${year}-09-06`]],
   ['Thanksgiving', [`${year}-11-25`, `${year}-11-26`, `${year}-11-27`, `${year}-11-28`]], ['Christmas', [`${year}-12-24`, `${year}-12-25`, `${year}-12-26`]],
   ["New Year's Eve", [`${year}-12-31`]]].forEach(([nm, ds]) => S.holidayDefs.push(H(nm, ds)));
  _isRestoring = false;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
  return S.physicians[0].id;
}
// Runs in the page: one holiday lottery for `year` with a seeded generator.
function runLottery({ year = 2027, seed = 1 } = {}) {
  let a = seed >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const realRandom = Math.random; Math.random = rnd;
  try {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return; if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(v))) { const o = document.createElement('option'); o.value = String(v); o.textContent = String(v); el.appendChild(o); } el.value = String(v); };
    set('haa-year', year); set('haa-grp', 'DR'); set('haa-mode', 'weighted');
    previewHolRandom();
    return (_holRandomPreview || []).map(x => ({ physId: x.physId, name: x.defName, first: (x.dates || []).slice().sort()[0] }));
  } finally { Math.random = realRandom; }
}

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=start-date');
  await launchSyntheticUser(page, 'superuser');
});

test('year fraction: none = 1, before the start year = 0, start year = share remaining, later = 1', async ({ page }) => {
  const r = await page.evaluate(() => {
    const f = (startDate, y) => _physYearFraction({ startDate }, y);
    return {
      none: _physYearFraction({}, 2027), blank: f('', 2027), bad: f('2027-02-30', 2027), junk: f('next July', 2027),
      before: f('2027-07-01', 2026), same: f('2027-07-01', 2027), after: f('2027-07-01', 2028),
      jan1: f('2027-01-01', 2027), dec31: f('2027-12-31', 2027), leap: f('2028-07-01', 2028),
      started: [_physStartedBy({ startDate: '2027-07-01' }, '2027-06-30'), _physStartedBy({ startDate: '2027-07-01' }, '2027-07-01'), _physStartedBy({}, '1999-01-01')],
    };
  });
  expect(r.none).toBe(1); expect(r.blank).toBe(1); expect(r.bad).toBe(1); expect(r.junk).toBe(1);
  expect(r.before).toBe(0); expect(r.after).toBe(1); expect(r.jan1).toBe(1);
  expect(r.same).toBeCloseTo(184 / 365, 10);           // Jul 1 → about half
  expect(r.dec31).toBeCloseTo(1 / 365, 10);
  expect(r.leap).toBeCloseTo(184 / 366, 10);
  expect(r.started).toEqual([false, true, true]);
});

test('weekend auto-assign: nothing before the start date and a prorated yearly cap', async ({ page }) => {
  const out = await page.evaluate(({ build }) => {
    const mk = new Function('return ' + build)();
    const run = starter => {
      const id = mk({ starter });
      const { plan } = _wkndPlanRange('2027-01-01', '2027-12-31');
      const mine = plan.filter(a => a.physId === id);
      const counts = {}; plan.forEach(a => { counts[a.physId] = (counts[a.physId] || 0) + 1; });
      return { id, total: plan.length, mine: mine.length, earliest: mine.map(a => a.satDate).sort()[0] || null,
        cap: _wkndYearCap(S.physicians[0], '2027'), maxOther: Math.max(...Object.entries(counts).filter(([k]) => +k !== id).map(([, v]) => v)),
        plan: JSON.stringify(plan) };
    };
    return { none: run(null), mid: run({ startDate: '2027-07-01' }), late: run({ startDate: '2027-11-15' }),
      next: run({ startDate: '2028-03-01' }), old: run({ startDate: '2019-01-01' }), half: run({ startDate: '2027-07-01', drFte: 0.5 }) };
  }, { build: buildPractice.toString() });

  expect(out.none.cap).toBe(8);
  expect(out.none.mine).toBeGreaterThan(0);
  // Start Jul 1 at 1.0 FTE → 8 × 184/365 = 4.03 → cap 4, and nothing in the first half.
  expect(out.mid.cap).toBe(4);
  expect(out.mid.mine).toBeGreaterThan(0);
  expect(out.mid.mine).toBeLessThanOrEqual(4);
  expect(out.mid.earliest >= '2027-07-01').toBe(true);
  expect(out.mid.maxOther).toBeLessThanOrEqual(8);
  // FTE and the year fraction multiply: 0.5 FTE from Jul 1 → 8 × 0.5 × 0.504 = 2.02 → 2.
  expect(out.half.cap).toBe(2);
  expect(out.half.mine).toBeLessThanOrEqual(2);
  // Mid-November → 8 × 47/365 = 1.03 → 1, and only from the start date on.
  expect(out.late.cap).toBe(1);
  expect(out.late.mine).toBeLessThanOrEqual(1);
  if (out.late.earliest) expect(out.late.earliest >= '2027-11-15').toBe(true);
  // Starts next year → not in this year's pool at all.
  expect(out.next.cap).toBe(0);
  expect(out.next.mine).toBe(0);
  // A start date in an earlier year changes nothing.
  expect(out.old.plan).toBe(out.none.plan);
});

test('weekend auto-assign: a mid-summer starter gets a share of the summer cap', async ({ page }) => {
  const r = await page.evaluate(({ build }) => {
    const mk = new Function('return ' + build)();
    mk({ starter: { startDate: '2027-08-01' } });
    const p = S.physicians[0];
    const { plan } = _wkndPlanRange('2027-01-01', '2027-12-31');
    const summer = plan.filter(a => a.physId === p.id && a.satDate >= '2027-06-01' && a.satDate <= '2027-08-31').length;
    return { cap: _wkndSummerCapFor(p, '2027'), full: _wkndSummerCapFor(S.physicians[1], '2027'), june15: _wkndSummerCapFor({ startDate: '2027-06-15' }, '2027'), summer };
  }, { build: buildPractice.toString() });
  expect(r.full).toBe(2);
  expect(r.cap).toBe(1);                              // one third of the summer left
  expect(r.june15).toBe(2);
  expect(r.summer).toBeLessThanOrEqual(1);
});

test('holiday lottery: no block before the start date, and about half the holidays for a half-year starter', async ({ page }) => {
  const res = await page.evaluate(({ build, lottery }) => {
    const mk = new Function('return ' + build)();
    const draw = new Function('return ' + lottery)();
    const out = { withStart: [], control: [], nextYear: [], late: [] };
    for (let seed = 1; seed <= 12; seed++) {
      let id = mk({ starter: { startDate: '2027-07-01' } });
      let pv = draw({ seed });
      let per = {}; pv.forEach(a => { per[a.physId] = (per[a.physId] || 0) + 1; });
      out.withStart.push({ total: pv.length, mine: per[id] || 0, early: pv.filter(a => a.physId === id && a.first < '2027-07-01').length,
        maxOther: Math.max(...Object.entries(per).filter(([k]) => +k !== id).map(([, v]) => v)) });
      id = mk({ starter: null });
      pv = draw({ seed });
      per = {}; pv.forEach(a => { per[a.physId] = (per[a.physId] || 0) + 1; });
      out.control.push({ total: pv.length, mine: per[id] || 0 });
      id = mk({ starter: { startDate: '2028-02-01' } });
      pv = draw({ seed });
      out.nextYear.push(pv.filter(a => a.physId === id).length);
      id = mk({ starter: { startDate: '2027-11-15' } });
      pv = draw({ seed });
      out.late.push({ total: pv.length, mine: pv.filter(a => a.physId === id).length });
    }
    return out;
  }, { build: buildPractice.toString(), lottery: runLottery.toString() });

  // 7 holidays × 3 slots, 12 physicians: every slot fills in every run.
  res.withStart.forEach(r => {
    expect(r.total).toBe(21);
    expect(r.early).toBe(0);                          // never a block that begins before they start
    expect(r.mine).toBeLessThanOrEqual(1);            // ~1.8 per full-year person → at most 1 for half a year
    expect(r.maxOther).toBeLessThanOrEqual(2);        // equal-spread rule still holds for everyone else
  });
  // Without a start date the same physician can reach 2 in at least one of the runs.
  expect(Math.max(...res.control.map(r => r.mine))).toBe(2);
  // Starting next year → never drawn this year.
  expect(res.nextYear.every(n => n === 0)).toBe(true);
  // Starting mid-November (about an eighth of the year): colleagues are not level with
  // their pro-rata position until everyone has two, so the newcomer is not handed
  // Thanksgiving or Christmas in their first six weeks — and every slot still fills.
  res.late.forEach(r => { expect(r.total).toBe(21); expect(r.mine).toBe(0); });
});

test('holiday fair share ignores the years before a physician started', async ({ page }) => {
  const r = await page.evaluate(({ build }) => {
    const mk = new Function('return ' + build)();
    const id = mk({ starter: { startDate: '2027-07-01' } });
    // history: everyone else covered a holiday in 2025 and 2026; the starter (not yet hired) did not
    S.physicians.slice(1).forEach((p, i) => {
      [2025, 2026].forEach(y => S.holidays.push({ id: 50000 + y * 100 + i, name: 'Thanksgiving', date: `${y}-11-27`, year: y, physId: p.id, group: 'DR', sub: '', wshift: 'day', notes: 'Imported history' }));
    });
    const data = _holCareerDataBeforeYear('DR', 2027);
    const mine = data.find(d => d.p.id === id), other = data.find(d => d.p.id !== id);
    return { myBalance: mine.balance, myFair: mine.fairTot, otherFair: other.fairTot,
      prop2026: _holPoolFteProp(S.physicians[0], 'DR', 2026), prop2027: _holPoolFteProp(S.physicians[0], 'DR', 2027), propPlain: _holPoolFteProp(S.physicians[0], 'DR'),
      sum2027: S.physicians.reduce((s, p) => s + _holPoolFteProp(p, 'DR', 2027), 0) };
  }, { build: buildPractice.toString() });
  expect(r.prop2026).toBe(0);                          // not on staff → no share
  expect(r.myFair).toBe(0);
  expect(r.myBalance).toBe(0);                         // owes nothing for holidays before they arrived
  expect(r.otherFair).toBeGreaterThan(0);
  expect(r.propPlain).toBeCloseTo(1 / 12, 10);
  expect(r.prop2027).toBeCloseTo((184 / 365) / (11 + 184 / 365), 10);
  expect(r.sum2027).toBeCloseTo(1, 10);                // shares still add up to the whole
});

test('IR call targets shrink to the part of the period on staff; the builder accepts a full year', async ({ page }) => {
  const r = await page.evaluate(() => {
    _isRestoring = true;
    const ir = (id, extra) => Object.assign({ id, first: 'I' + id, last: 'IR' + id, role: 'IR', drFte: 0, irFte: 1, irGroup: 'North', drSubs: [], irSubs: [],
      shiftElig: { s1: true, wknd: true }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [] }, extra || {});
    S.physicians = [ir(2001), ir(2002), ir(2003, { startDate: '2027-07-01' })];
    S.vacations = []; S.holidayDefs = []; S.irCalls = [];
    _isRestoring = false;
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const year = _periodToMonths('year', 2027, '');
    const a = S.physicians[0], c = S.physicians[2];
    return { months: year.length, first: year[0], last: year[11], label: _periodLabel('year', year),
      full: irDailyTargetAdjusted(a, year), starter: irDailyTargetAdjusted(c, year),
      wFull: irWkndTargetAdjusted(a, year), wStarter: irWkndTargetAdjusted(c, year),
      h1Starter: irDailyTargetAdjusted(c, _periodToMonths('H1', 2027, '')), mayStarter: irDailyTargetMonth(c, '2027-05'), julStarter: irDailyTargetMonth(c, '2027-07'), julFull: irDailyTargetMonth(a, '2027-07'),
      hasOption: !![...document.querySelectorAll('#ira-period option')].find(o => o.value === 'year') };
  });
  expect(r.months).toBe(12); expect(r.first).toBe('2027-01'); expect(r.last).toBe('2027-12');
  expect(r.label).toContain('2027'); expect(r.hasOption).toBe(true);
  expect(r.h1Starter).toBe(0);                         // not here in the first half
  expect(r.mayStarter).toBe(0);
  expect(r.julStarter).toBeCloseTo(r.julFull, 10);     // on staff for all of July
  expect(r.starter / r.full).toBeGreaterThan(0.45);    // about half the year's daily call
  expect(r.starter / r.full).toBeLessThan(0.55);
  expect(r.wStarter / r.wFull).toBeGreaterThan(0.45);
  expect(r.wStarter / r.wFull).toBeLessThan(0.56);
});

test('the physician editor stores, shows and clears a start date', async ({ page }) => {
  const id = await page.evaluate(({ build }) => {
    const first = new Function('return ' + build)()({ n: 3 });
    nav('physicians', document.querySelector('.snav-item[data-pg="physicians"]'));
    return first;
  }, { build: buildPractice.toString() });
  await page.evaluate(i => editPhys(i), id);
  await expect(page.locator('#p-start')).toHaveValue('');
  await page.locator('#p-start').fill('2027-07-01');
  await page.evaluate(i => _saveEditPhys(i), id);
  expect(await page.evaluate(i => S.physicians.find(p => p.id === i).startDate, id)).toBe('2027-07-01');
  await expect(page.locator('#page-physicians')).toContainText('start 2027-07-01');
  // it survives the save/load round trip through the persisted payload
  const persisted = await page.evaluate(i => JSON.parse(JSON.stringify(_buildPersistedPayload('online'))).physicians.find(p => p.id === i).startDate, id);
  expect(persisted).toBe('2027-07-01');

  await page.evaluate(i => editPhys(i), id);
  await expect(page.locator('#p-start')).toHaveValue('2027-07-01');
  await page.locator('#p-start').fill('');
  await page.evaluate(i => _saveEditPhys(i), id);
  expect(await page.evaluate(i => 'startDate' in S.physicians.find(p => p.id === i), id)).toBe(false);
  // an impossible date arriving from elsewhere is dropped by validation
  const v = await page.evaluate(() => { const p = { id: 7, first: 'A', last: 'B', drFte: 1, irFte: 0, startDate: '2027-13-45' }; const out = _validatePhysician(p); return { has: 'startDate' in p, issues: out.issues.length }; });
  expect(v.has).toBe(false); expect(v.issues).toBeGreaterThan(0);
});
