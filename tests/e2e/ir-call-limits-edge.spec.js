// IR call limits (rs-v128) — the edges an independent review found.
//
// ir-call-limits.spec.js covers the rules themselves. These cover the ways
// around them: a preview applied after the schedule changed, rebalancer rows
// unticked one by one, a year built in small pieces, a typo in a Settings
// field, numbers left over from before the maximums meant anything.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// Runs in the page. Replaces the IR roster and clears the IR schedule.
//   phys: [[id, last, group, fte, extra?]]   cfg: { irDailyMax, irWkndMax }
function resetPractice(phys, cfg) {
  _isRestoring = true;
  S.physicians = phys.map(([id, last, irGroup, irFte, extra]) => Object.assign({
    id, first: 'T', last, role: 'IR', drFte: 0, irFte, irGroup, drSubs: [], irSubs: [], address: '',
    shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [],
  }, extra || {}));
  S.irCalls = []; S.vacations = []; S.holidays = []; S.holidayDefs = []; S.irShifts = []; S.drShifts = []; S.weekendCalls = []; S.natLangRules = [];
  S.tumorBoards = []; S.clinics = [];
  S.cfg = Object.assign({}, S.cfg, { irDailyMaxYr: cfg.irDailyMax, irWkndMaxYr: cfg.irWkndMax, irDailyMax: cfg.irDailyMax, irMax: cfg.irDailyMax, irWkndMax: cfg.irWkndMax });
  _isRestoring = false;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
}
// Runs in the page: preview the IR call builder for (part of) 2027.
async function previewPeriod(period, ym, type) {
  nav('ir-auto', document.querySelector('.snav-item[data-pg="ir-auto"]'));
  const yr = document.getElementById('ira-yr');
  if (![...yr.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; yr.appendChild(o); }
  yr.value = '2027';
  document.getElementById('ira-period').value = period; _iraTogglePeriodInputs();
  if (ym) document.getElementById('ira-mo').value = ym;
  document.getElementById('ira-type').value = type || 'both'; document.getElementById('ira-grp').value = 'both';
  S.iraPreview = [];
  previewIRAA();
  await new Promise(r => setTimeout(r, 250));
  for (let i = 0; i < 600 && document.getElementById('iraa-progress'); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 100));
  return { n: (S.iraPreview || []).length, text: document.getElementById('ira-box').textContent.replace(/\s+/g, ' '),
    relaxed: (S.iraPreview || []).filter(a => a._relaxedBreakable).map(a => `${a.physId}:${a.date}`).sort() };
}
// Runs in the page: Apply All without the dialogs.
async function applyPreview() {
  const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
  applyIRAA(); await new Promise(res => setTimeout(res, 300));
  window.confirm = realConfirm; window.alert = realAlert;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
}
// Runs in the page: preview the IR call rebalancer for a half of 2027.
async function previewRebalance(period, grp, typ) {
  nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
  const ry = document.getElementById('irr-yr');
  if (![...ry.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ry.appendChild(o); }
  ry.value = '2027';
  document.getElementById('irr-period').value = period; document.getElementById('irr-grp').value = grp; document.getElementById('irr-type').value = typ;
  _irrPlan = null; previewIRRebalance();
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 600 && !_irrPlan; i++) await new Promise(r => setTimeout(r, 50));
  return _irrPlan;
}
const FN = { reset: resetPractice.toString(), preview: previewPeriod.toString(), apply: applyPreview.toString(), rebalance: previewRebalance.toString() };
const GROUP = [[1, 'Half1', 'South', 0.5], [2, 'Full1', 'South', 1], [3, 'Half2', 'South', 0.5], [4, 'Starter', 'South', 1, { startDate: '2027-05-01' }],
  [5, 'Full2', 'South', 1], [6, 'Full3', 'South', 1], [7, 'Full4', 'South', 1]];

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=ir-limits-edge');
  await launchSyntheticUser(page, 'superuser');
});

test('built month by month or by half-months with no maximum, everyone still ends near their yearly FTE share', async ({ page }) => {
  test.setTimeout(240000);
  const r = await page.evaluate(async ({ reset, preview, apply, GROUP }) => {
    // (functions are created before the first await: the page's CSP forbids new Function() later)
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)(), doApply = new Function('return ' + apply)();
    const hol = c => typeof c.notes === 'string' && c.notes.includes('(Holiday)');
    const totals = () => {
      const shD = _irFairShares(S.physicians, _irYearSlots('daily', 2027, 'South'), 'daily').base, shW = _irFairShares(S.physicians, _irYearSlots('weekend', 2027, 'South'), 'weekend').base;
      return S.physicians.map(p => ({ last: p.last, shareD: shD[p.id], shareW: shW[p.id],
        daily: S.irCalls.filter(c => c.physId === p.id && c.callType === 'daily' && !hol(c)).length,
        weekend: S.irCalls.filter(c => c.physId === p.id && c.callType === 'weekend' && !hol(c)).length }));
    };
    const out = {};
    mk(GROUP, { irDailyMax: 0, irWkndMax: 0 });
    for (let m = 1; m <= 12; m++) { await run('month', `2027-${String(m).padStart(2, '0')}`); await doApply(); }
    out.monthly = totals();
    mk(GROUP, { irDailyMax: 0, irWkndMax: 0 });
    for (let m = 1; m <= 12; m++) for (const half of ['semi-1', 'semi-2']) { await run(half, `2027-${String(m).padStart(2, '0')}`); await doApply(); }
    out.halfMonthly = totals();
    return out;
  }, { ...FN, GROUP });

  for (const [how, rows] of Object.entries(r)) {
    rows.forEach(x => {
      // was: half-timers 24 weekday against a share of 17.7; a full-timer 24 weekends against 9.4; the starter 0 weekends
      expect(x.daily, `${how}: ${x.last} weekday calls vs yearly share ${x.shareD.toFixed(1)}`).toBeLessThanOrEqual(Math.ceil(x.shareD) + 1);
      expect(x.daily, `${how}: ${x.last} weekday calls vs yearly share ${x.shareD.toFixed(1)}`).toBeGreaterThanOrEqual(Math.floor(x.shareD) - 1);
      expect(x.weekend, `${how}: ${x.last} weekends vs yearly share ${x.shareW.toFixed(1)}`).toBeLessThanOrEqual(Math.ceil(x.shareW) + 1);
      expect(x.weekend, `${how}: ${x.last} weekends vs yearly share ${x.shareW.toFixed(1)}`).toBeGreaterThanOrEqual(Math.floor(x.shareW) - 1);
    });
  }
});

test('Apply refuses a preview that no longer matches the schedule or the limits', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, preview }) => {
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)();
    const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
    const applyNow = async () => { applyIRAA(); await new Promise(res => setTimeout(res, 250)); if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty(); };
    const wk = pid => S.irCalls.filter(c => c.physId === pid && c.callType === 'weekend').length;
    const out = {};
    // (1) a hand-assigned call between Preview and Apply
    mk([[1, 'NA', 'North', 1], [2, 'NB', 'North', 1]], { irDailyMax: 0, irWkndMax: 8 });
    const first = await run('H2', null, 'weekend');
    out.previewed = first.n;
    S.irCalls.push({ id: S.nextId++, physId: 1, date: '2027-07-23', callType: 'weekend', irGroup: 'North', site: '', notes: 'Manual' });
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    await applyNow();
    out.afterStale = { calls: S.irCalls.length, box: document.getElementById('ira-box').textContent, button: document.getElementById('ira-apply').style.display, held: (S.iraPreview || []).length };
    await run('H2', null, 'weekend'); await applyNow();
    out.afterFresh = { NA: wk(1), NB: wk(2), max: _irCallMaxYear(S.physicians[0], 'weekend', 2027) };
    // (2) the Settings maximum lowered between Preview and Apply
    mk([[1, 'NA', 'North', 1], [2, 'NB', 'North', 1]], { irDailyMax: 0, irWkndMax: 8 });
    await run('H2', null, 'weekend'); S.cfg.irWkndMaxYr = 6; await applyNow();
    out.afterLowerMax = S.irCalls.length;
    // (3) an FTE change between Preview and Apply
    mk([[1, 'NA', 'North', 1], [2, 'NB', 'North', 1]], { irDailyMax: 0, irWkndMax: 8 });
    await run('H2', null, 'weekend'); S.physicians[0].irFte = 0.5; await applyNow();
    out.afterFteChange = S.irCalls.length;
    // control: looking at other pages in between changes nothing
    mk([[1, 'NA', 'North', 1], [2, 'NB', 'North', 1]], { irDailyMax: 0, irWkndMax: 8 });
    const ctl = await run('H2', null, 'weekend');
    nav('settings', document.querySelector('.snav-item[data-pg="settings"]')); nav('ir-auto', document.querySelector('.snav-item[data-pg="ir-auto"]'));
    await applyNow();
    out.control = { previewed: ctl.n, calls: S.irCalls.length };
    window.confirm = realConfirm; window.alert = realAlert;
    return out;
  }, FN);

  expect(r.previewed).toBeGreaterThan(10);
  expect(r.afterStale.calls).toBe(1);                      // only the hand-assigned call: nothing from the old plan
  expect(r.afterStale.box).toContain('Click Preview again');
  expect(r.afterStale.button).toBe('none');
  expect(r.afterStale.held).toBe(0);
  expect(r.afterFresh.NA).toBeLessThanOrEqual(r.afterFresh.max);   // was 9 of 8
  expect(r.afterFresh.NB).toBeLessThanOrEqual(r.afterFresh.max);
  expect(r.afterLowerMax).toBe(0);
  expect(r.afterFteChange).toBe(0);
  expect(r.control.calls).toBe(r.control.previewed);
});

test('a conference rule flagged "may be broken for unfilled IR" is broken only as a last resort', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, preview }) => {
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)();
    const board = () => { S.tumorBoards = [{ id: 501, name: 'board', active: true, skipDates: [], recurrence: { kind: 'weekly', days: [1, 2, 3, 4], interval: 1 }, allowedPhysIds: [1] }]; };
    const vac = (pid, s, e) => S.vacations.push({ id: 7000 + S.vacations.length, physId: pid, start: s, end: e, type: 'Vacation' });
    const rule = flag => ({ tbRules: [{ action: 'no-call-on-day', allowBreakForUnfilledIR: flag, eventId: null }] });
    const out = {};
    // Aconf sits on a Mon–Thu board; both colleagues are away for the first half of January.
    mk([[1, 'Aconf', 'South', 1, rule(true)], [2, 'Bvac', 'South', 1], [3, 'Cvac', 'South', 1]], { irDailyMax: 0, irWkndMax: 0 });
    board(); vac(2, '2027-01-01', '2027-01-15'); vac(3, '2027-01-01', '2027-01-15'); _markDateIdxDirty();
    out.flagged = await run('month', '2027-01', 'daily');
    // same, but the rule is not flagged
    mk([[1, 'Aconf', 'South', 1, rule(false)], [2, 'Bvac', 'South', 1], [3, 'Cvac', 'South', 1]], { irDailyMax: 0, irWkndMax: 0 });
    board(); vac(2, '2027-01-01', '2027-01-15'); vac(3, '2027-01-01', '2027-01-15'); _markDateIdxDirty();
    out.notFlagged = await run('month', '2027-01', 'daily');
    // flagged, but the colleagues are free: nothing is unfilled, so nothing is broken
    mk([[1, 'Aconf', 'South', 1, rule(true)], [2, 'Bfree', 'South', 1], [3, 'Cfree', 'South', 1]], { irDailyMax: 0, irWkndMax: 0 });
    board(); _markDateIdxDirty();
    out.colleaguesFree = await run('month', '2027-01', 'daily');
    return out;
  }, FN);

  expect(r.flagged.relaxed).toEqual(['1:2027-01-04', '1:2027-01-06', '1:2027-01-11', '1:2027-01-13']);   // every other day: never back-to-back
  expect(r.notFlagged.relaxed).toEqual([]);
  expect(r.notFlagged.n).toBeLessThan(r.flagged.n);
  expect(r.colleaguesFree.relaxed).toEqual([]);
  expect(r.colleaguesFree.text).toMatch(/— 0 gap\(s\)/);
});

test('the rebalancer asks before unticked rows take someone past the maximum, refuses a stale plan, and keeps calls it does not replace', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, rebalance }) => {
    const mk = new Function('return ' + reset)(), runIRR = new Function('return ' + rebalance)();
    const fridays = (m0, m1) => { const out = []; for (let m = m0; m <= m1; m++) buildCal(`2027-${String(m).padStart(2, '0')}`).forEach(c => { if (c.day && c.dow === 5) out.push(c.date); }); return out; };
    const add = (pid, date, type, grp, notes) => { _isRestoring = true; S.irCalls.push({ id: S.nextId++, physId: pid, date, callType: type, irGroup: grp, site: '', notes: notes || '' }); _isRestoring = false; };
    const wk = pid => S.irCalls.filter(c => c.physId === pid && c.callType === 'weekend').length;
    const snap = () => JSON.stringify(S.irCalls.map(c => [c.physId, c.date, c.callType, c.irGroup]).sort());
    const seed = (withHolidayCall) => {                      // NB holds weekends 1,3,…,15 (8); NA holds 2,4,…,14 (7)
      mk([[1, 'NA', 'North', 1], [2, 'NB', 'North', 1]], { irDailyMax: 0, irWkndMax: 8 });
      const fr = fridays(7, 12);
      for (let i = 0; i < 16; i++) { if (i % 2 === 0) add(2, fr[i], 'weekend', 'North'); else if (i < 15) add(1, fr[i], 'weekend', 'North'); }
      if (withHolidayCall) add(1, '2027-09-06', 'daily', 'North', 'Manual');   // Labor Day: a holiday, so not a regular slot
      _markDateIdxDirty();
    };
    const asked = []; const realConfirm = window.confirm, realAlert = window.alert; let answer = true;
    window.confirm = m => { asked.push(String(m)); return answer; }; window.alert = () => {};
    const out = {};

    // (1) one row unticked → the question; declining changes nothing
    seed();
    let plan = await runIRR('H2', 'North', 'weekend');
    out.fullPlan = { NA: plan.weekend.filter(a => a.physId === 1).length, NB: plan.weekend.filter(a => a.physId === 2).length };
    const row = plan.weekend.find(a => a.isSwap && a.origPhysId === 1 && a.physId === 2);
    out.hadRow = !!row;
    document.getElementById('irr-swap-' + row._swapIdx).checked = false; _irrUpdateBtn();
    out.cell = document.getElementById('irrd-wy-1').textContent;
    out.note = document.getElementById('irr-apply-note').textContent;
    const before = snap(); answer = false; asked.length = 0;
    await applyIRRebalance(); await new Promise(res => setTimeout(res, 200));
    out.declined = { asked: asked.slice(), unchanged: snap() === before };

    // (2) every row ticked, weekday and weekend → no question; the manual holiday-date call survives
    seed(true); plan = await runIRR('H2', 'North', 'both'); answer = true; asked.length = 0;
    await applyIRRebalance(); await new Promise(res => setTimeout(res, 200));
    out.allTicked = { asked: asked.filter(m => /maximum/.test(m)).length, NA: wk(1), NB: wk(2), laborDay: S.irCalls.filter(c => c.date === '2027-09-06' && c.callType === 'daily' && c.physId === 1).length,
      dup: S.irCalls.length - new Set(S.irCalls.map(c => c.irGroup + '|' + c.callType + '|' + c.date)).size };

    // (3) the schedule changed after the plan was made → refused, nothing touched
    seed(); plan = await runIRR('H2', 'North', 'weekend');
    add(2, '2027-12-31', 'weekend', 'North', 'Manual'); _markDateIdxDirty();
    const before3 = snap();
    await applyIRRebalance(); await new Promise(res => setTimeout(res, 200));
    out.stale = { unchanged: snap() === before3, box: document.getElementById('irr-preview').textContent };
    window.confirm = realConfirm; window.alert = realAlert;
    return out;
  }, FN);

  expect(r.hadRow).toBe(true);
  expect(r.fullPlan.NA).toBeLessThanOrEqual(8);
  expect(r.fullPlan.NB).toBeLessThanOrEqual(8);
  expect(r.cell).toBe('9 / 8');
  expect(r.note).toMatch(/of \d+ selected/);
  expect(Number(r.note.match(/of (\d+) selected/)[1])).toBeLessThanOrEqual(16);   // used to count every row twice
  expect(r.declined.asked.length).toBe(1);
  expect(r.declined.asked[0]).toContain('pass the Settings maximum');
  expect(r.declined.asked[0]).toContain('9 weekend calls in 2027 (maximum 8)');
  expect(r.declined.unchanged).toBe(true);
  expect(r.allTicked.asked).toBe(0);
  expect(r.allTicked.NA).toBeLessThanOrEqual(8);
  expect(r.allTicked.NB).toBeLessThanOrEqual(8);
  expect(r.allTicked.laborDay).toBe(1);                    // used to be deleted with everything else in the period
  expect(r.allTicked.dup).toBe(0);
  expect(r.stale.unchanged).toBe(true);
  expect(r.stale.box).toContain('Click Preview again');
});

test('the rebalancer counts the calls it does not redistribute (cover for the other IR group)', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, rebalance }) => {
    const mk = new Function('return ' + reset)(), runIRR = new Function('return ' + rebalance)();
    const fridays = (m0, m1) => { const out = []; for (let m = m0; m <= m1; m++) buildCal(`2027-${String(m).padStart(2, '0')}`).forEach(c => { if (c.day && c.dow === 5) out.push(c.date); }); return out; };
    const add = (pid, date, grp) => { _isRestoring = true; S.irCalls.push({ id: S.nextId++, physId: pid, date, callType: 'weekend', irGroup: grp, site: '', notes: '' }); _isRestoring = false; };
    mk([[1, 'NA', 'North', 1], [2, 'NB', 'North', 1], [3, 'SC', 'South', 1], [4, 'SD', 'South', 1]], { irDailyMax: 0, irWkndMax: 8 });
    const fr = fridays(7, 12);
    fr.forEach(d => add(2, d, 'North'));                     // NB holds every North weekend of the second half
    [fr[17], fr[19], fr[21], fr[23]].forEach(d => add(1, d, 'South'));   // NA already covers four South weekends
    _markDateIdxDirty();
    const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
    const plan = await runIRR('H2', 'North', 'weekend');
    const mine = plan.weekend.filter(a => a.physId === 1 && a.irGroup === 'North').length;
    const cell = document.getElementById('irrd-wy-1').textContent;
    await applyIRRebalance(); await new Promise(res => setTimeout(res, 200));
    window.confirm = realConfirm; window.alert = realAlert;
    return { mine, cell, after: S.irCalls.filter(c => c.physId === 1 && c.callType === 'weekend').length, max: _irCallMaxYear(S.physicians[0], 'weekend', 2027) };
  }, FN);
  expect(r.max).toBe(8);
  expect(r.mine).toBeLessThanOrEqual(4);                     // was 8 new North weekends on top of the four
  expect(r.after).toBeLessThanOrEqual(8);                    // was 12
  expect(r.cell).toBe(`${r.mine + 4} / 8`);                  // was "8 / 8"
});

test('a maximum that is already high enough is not blamed for slots the yearly pace holds back', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, preview, GROUP }) => {
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)();
    mk(GROUP, { irDailyMax: 40, irWkndMax: 10 });            // the group needs about 36 / 9 for the year
    [2, 5].forEach(pid => S.vacations.push({ id: 7000 + pid, physId: pid, start: '2027-01-01', end: '2027-01-31', type: 'Vacation' }));
    S.physicians.push(Object.assign({}, S.physicians[0], { id: 99, last: 'Ungrouped', irGroup: '' }));
    _markDateIdxDirty();
    return await run('month', '2027-01', 'daily');
  }, { ...FN, GROUP });
  expect(r.text).toContain('at Settings maximum for this point in the year');
  expect(r.text).toContain('paced through the year');
  expect(r.text).not.toContain('would need to be');
  expect(r.text).toContain('Not scheduled for IR call: Ungrouped');   // IR FTE but no IR group: said, not silently skipped
});

test('a typo in a maximum field does not remove the maximum; a cleared DR weekend cap is stored, not deleted', async ({ page }) => {
  await page.evaluate(() => {
    S.cfg = Object.assign({}, S.cfg, { irDailyMaxYr: 31, irWkndMaxYr: 8, irDailyMax: 31, irMax: 31, irWkndMax: 8, wkndYearCapBase: 7.5, wkMax: 4 });
    nav('settings', document.querySelector('.snav-item[data-pg="settings"]'));
  });
  const daily = page.locator('#cfg-ir-daily');
  await daily.scrollIntoViewIfNeeded();
  await daily.click();
  await daily.press('ControlOrMeta+a');
  await daily.pressSequentially('40e');                      // a number input reports this as empty
  await daily.press('Tab');
  await page.waitForTimeout(200);
  const typo = await page.evaluate(() => ({ stored: S.cfg.irDailyMaxYr, old: S.cfg.irDailyMax, field: document.getElementById('cfg-ir-daily').value, base: _irCallMaxBase('daily') }));
  expect(typo).toEqual({ stored: 31, old: 31, field: '31', base: 31 });   // was 0 = no maximum

  await daily.click();
  await daily.press('ControlOrMeta+a');
  await daily.pressSequentially('40');
  await daily.press('Tab');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => [S.cfg.irDailyMaxYr, S.cfg.irDailyMax, _irCallMaxBase('daily')])).toEqual([40, 40, 40]);

  // a negative number is not "no maximum" either
  await daily.click();
  await daily.press('ControlOrMeta+a');
  await daily.pressSequentially('-31');
  await daily.press('Tab');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => [S.cfg.irDailyMaxYr, document.getElementById('cfg-ir-daily').value])).toEqual([40, '40']);

  const wk = page.locator('#cfg-wk');
  await wk.click();
  await wk.press('ControlOrMeta+a');
  await wk.press('Backspace');
  await wk.press('Tab');
  await page.waitForTimeout(200);
  const cleared = await page.evaluate(() => ({ stored: S.cfg.wkndYearCapBase, hasKey: 'wkndYearCapBase' in S.cfg, field: document.getElementById('cfg-wk').value,
    cap: _wkndYearCap({ id: 900, drFte: 1, irFte: 0, shiftElig: { s1: true, wknd: true } }, 2027), ir: S.cfg.irDailyMaxYr, wkMax: S.cfg.wkMax }));
  expect(cleared).toEqual({ stored: 0, hasKey: true, field: '', cap: null, ir: 40, wkMax: 4 });

  // the DR Weekends page has its own field for the same cap: same rule there
  await page.evaluate(() => { S.cfg.wkndYearCapBase = 8; nav('dr-weekends', document.querySelector('.snav-item[data-pg="dr-weekends"]')); });
  const yc = page.locator('#wknd-year-cap');
  await yc.scrollIntoViewIfNeeded();
  await expect(yc).toHaveValue('8');
  await yc.click();
  await yc.press('ControlOrMeta+a');
  await yc.pressSequentially('8e');
  await yc.press('Tab');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => [S.cfg.wkndYearCapBase, document.getElementById('wknd-year-cap').value])).toEqual([8, '8']);   // was 0: cap gone
});

test('numbers left from before the maximums were enforced: the untouched 20 / 4 seed means "none", chosen numbers carry over, and an older build cannot change them', async ({ page }) => {
  const r = await page.evaluate(() => {
    const run = (cfg, v) => { const d = _runMigrations({ _schemaVersion: v, cfg: Object.assign({}, cfg) }); return { d: d.cfg.irDailyMaxYr, w: d.cfg.irWkndMaxYr, v: d._schemaVersion }; };
    const applied = cfg => { const keep = S.cfg; S.cfg = cfg; const out = [String(_irCallMaxBase('daily')), String(_irCallMaxBase('weekend'))]; S.cfg = keep; return out; };
    return {
      seed: run({ irDailyMax: 20, irMax: 20, irWkndMax: 4 }, 8),
      halfSeed: run({ irDailyMax: 0, irMax: 0, irWkndMax: 4 }, 8),        // 0 typed on one side under the old build, seed on the other
      chosen: run({ irDailyMax: 31, irMax: 31, irWkndMax: 8 }, 8),
      oneChanged: run({ irDailyMax: 20, irMax: 20, irWkndMax: 8 }, 8),
      loneAlias: run({ irMax: 20 }, 8),
      noCfg: (() => { try { return _runMigrations({ _schemaVersion: 8 })._schemaVersion; } catch (e) { return String(e); } })(),
      // an older tab re-saves the row: stamped v8 again, old keys clamped to its 31 / 12 or re-seeded — the yearly keys stand
      resavedByOldTab: run({ irDailyMaxYr: 36, irWkndMaxYr: 14, irDailyMax: 31, irMax: 31, irWkndMax: 12 }, 8),
      chosen20and4: run({ irDailyMaxYr: 20, irWkndMaxYr: 4, irDailyMax: 20, irMax: 20, irWkndMax: 4 }, 8),
      appliedAfterOldTab: applied({ irDailyMaxYr: 36, irWkndMaxYr: 14, irDailyMax: 31, irMax: 31, irWkndMax: 12 }),
      appliedUnmigrated: applied({ irDailyMax: 31, irMax: 31, irWkndMax: 8 }),
      // Settings → Import config with a file exported by an older build
      importedOldFile: (() => { const c = _irMaxYearlyInit({ irDailyMax: 20, irMax: 20, irWkndMax: 4, anchorPct: 70 }); return [c.irDailyMaxYr, c.irWkndMaxYr]; })(),
      version: _SCHEMA_VERSION,
    };
  });
  expect(r.version).toBe(9);
  expect(r.seed).toEqual({ d: 0, w: 0, v: 9 });
  expect(r.halfSeed).toEqual({ d: 0, w: 0, v: 9 });
  expect(r.chosen).toEqual({ d: 31, w: 8, v: 9 });
  expect(r.oneChanged).toEqual({ d: 20, w: 8, v: 9 });
  expect(r.loneAlias).toEqual({ d: 0, w: 0, v: 9 });
  expect(r.noCfg).toBe(9);
  expect(r.resavedByOldTab).toEqual({ d: 36, w: 14, v: 9 });
  expect(r.chosen20and4).toEqual({ d: 20, w: 4, v: 9 });
  expect(r.appliedAfterOldTab).toEqual(['36', '14']);
  expect(r.appliedUnmigrated).toEqual(['31', '8']);
  expect(r.importedOldFile).toEqual([0, 0]);
});

test('manual prompts: a maximum that rounds to zero still asks; editing holiday call does not', async ({ page }) => {
  const r = await page.evaluate(({ reset }) => {
    new Function('return ' + reset)()([[1, 'Tiny', 'South', 0.05], [2, 'Full', 'South', 1], [3, 'NoIr', 'South', 0]], { irDailyMax: 31, irWkndMax: 8 });
    const asked = []; const real = window.confirm; window.confirm = m => { asked.push(String(m)); return false; };
    const [tiny, full, noIr] = S.physicians;
    const out = { tinyMax: _irCallMaxYear(tiny, 'weekend', 2027) };
    out.tiny = _confirmIrCallMax(tiny, 'weekend', '2027-03-05');   // 8 × 0.05 rounds to 0: still a maximum
    out.noIr = _confirmIrCallMax(noIr, 'weekend', '2027-03-05');   // no IR FTE at all: nothing to ask
    out.fullRoom = _confirmIrCallMax(full, 'weekend', '2027-03-05');
    window.confirm = real;
    return { out, asked };
  }, FN);
  expect(r.out).toEqual({ tinyMax: 0, tiny: false, noIr: true, fullRoom: true });
  expect(r.asked.length).toBe(1);
  expect(r.asked[0]).toContain('maximum is 0');
});

test('when one physician can take no weekend call, the weekends the maximum cannot cover are spread through the year', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, preview }) => {
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)();
    const phys = [1, 2, 3, 4, 5, 6, 7].map(i => [i, 'P' + i, 'South', 1, i === 7 ? { irCallBlackouts: [{ start: '2027-01-01', end: '2027-12-31', reason: 'no weekends' }] } : null]);
    mk(phys, { irDailyMax: 0, irWkndMax: 8 });               // six can take 6 × 8 = 48 of the year's weekends
    await run('year', null, 'weekend');
    const fr = _irYearSlots('weekend', 2027, 'South');
    const open = fr.filter(d => !(S.iraPreview || []).some(a => a.callType === 'weekend' && a.date === d));
    return { n: fr.length, open, months: [...new Set(open.map(d => d.slice(5, 7)))].length, perPhys: [1, 2, 3, 4, 5, 6, 7].map(i => (S.iraPreview || []).filter(a => a.physId === i).length) };
  }, FN);
  expect(r.perPhys.slice(0, 6)).toEqual([8, 8, 8, 8, 8, 8]);
  expect(r.perPhys[6]).toBe(0);
  expect(r.open.length).toBe(r.n - 48);
  expect(r.months).toBeGreaterThanOrEqual(4);                // was: every one of them in December
  expect(r.open.filter(d => d >= '2027-12-01').length).toBeLessThanOrEqual(2);
});

test('someone back from a long leave is not handed every date until they catch up', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, preview, apply }) => {
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)(), doApply = new Function('return ' + apply)();
    mk([[1, 'Away', 'South', 1], [2, 'B', 'South', 1], [3, 'C', 'South', 1], [4, 'D', 'South', 1]], { irDailyMax: 0, irWkndMax: 0 });
    S.vacations.push({ id: 7001, physId: 1, start: '2027-01-01', end: '2027-06-30', type: 'Vacation' }); _markDateIdxDirty();
    await run('H1', null, 'daily'); await doApply();
    await run('H2', null, 'daily');
    const mine = (S.iraPreview || []).filter(a => a.physId === 1).map(a => a.date).sort();
    const perMonth = [7, 8, 9, 10, 11, 12].map(m => mine.filter(d => +d.slice(5, 7) === m).length);
    let worst14 = 0; mine.forEach(d => { worst14 = Math.max(worst14, mine.filter(x => x >= d && _daysBetween(d, x) < 14).length); });
    return { total: mine.length, perMonth, worst14 };
  }, FN);
  expect(Math.max(...r.perMonth)).toBeLessThanOrEqual(6);    // was 7 in November and none after Dec 8
  expect(r.perMonth[5]).toBeGreaterThanOrEqual(2);
  expect(r.worst14).toBeLessThanOrEqual(4);
});

test('a weekend that a defined holiday touches is left to holiday call, whether or not it has been assigned yet', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, preview, GROUP }) => {
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)();
    mk(GROUP, { irDailyMax: 0, irWkndMax: 0 });
    S.holidayDefs = [
      { id: 9001, name: "New Year's Day", year: 2027, dates: ['2027-01-01', '2027-01-02', '2027-01-03'], irSlotsByGroup: { North: 1, South: 1 } },   // Fri–Sun; Monday is a normal day
      { id: 9002, name: 'Labor Day', year: 2027, dates: ['2027-09-06'], irSlotsByGroup: { North: 1, South: 1 } },                                    // the Monday only
      { id: 9003, name: 'Thanksgiving', year: 2027, dates: ['2027-11-25'], irSlotsByGroup: { North: 1, South: 1 } },                                 // a Thursday
      { id: 9004, name: 'Christmas Day', year: 2027, dates: ['2027-12-24', '2027-12-25', '2027-12-26'], irSlotsByGroup: { North: 1, South: 1 } },
    ];
    // Christmas has already been assigned on the Holiday tab; the others have not.
    S.irCalls.push({ id: 9100, physId: 6, date: '2027-12-24', callType: 'weekend', irGroup: 'South', site: '', notes: 'Christmas Day (Holiday)' });
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const out = await run('year', null, 'weekend');
    const fri = d => (S.iraPreview || []).some(a => a.callType === 'weekend' && a.date === d);
    const year = _irYearSlots('weekend', 2027, 'South');
    return { text: out.text, newYear: fri('2027-01-01'), laborDay: fri('2027-09-03'), afterThanksgiving: fri('2027-11-26'), christmas: fri('2027-12-24'), ordinary: fri('2027-01-08'),
      inYear: ['2027-01-01', '2027-09-03', '2027-11-26', '2027-12-24'].map(d => year.includes(d)), nYear: year.length, n: out.n,
      shareSum: Object.values(previewIRAA._last.lim).reduce((sum, L) => sum + L.W.base, 0),
      helper: [_irHolidayWeekend('2027-01-01', 'South'), _irHolidayWeekend('2027-09-03', 'South'), _irHolidayWeekend('2027-11-26', 'South'), _irHolidayWeekend('2027-01-08', 'South')] };
  }, { ...FN, GROUP });

  expect(r.newYear).toBe(false);                             // used to be handed out as a regular weekend (only 3 of its 4 days are holiday)
  expect(r.laborDay).toBe(false);                            // the holiday Monday belongs to the weekend that ends on it
  expect(r.christmas).toBe(false);
  expect(r.afterThanksgiving).toBe(true);                    // a Thursday holiday does not touch the weekend after it
  expect(r.ordinary).toBe(true);
  expect(r.helper).toEqual([true, true, false, false]);
  expect(r.inYear).toEqual([false, false, true, false]);
  expect(r.n).toBe(r.nYear);                                 // every regular weekend filled, none of the holiday ones
  expect(r.shareSum).toBeCloseTo(r.nYear, 6);                // shares are of the regular weekends only
  expect(r.text).toContain('left to holiday call');
  expect(r.text).toContain("New Year's Day");
  expect(r.text).toContain('holiday call not assigned yet');
  expect(r.text).toMatch(/2 have nobody assigned yet/);      // New Year's and Labor Day; Christmas is assigned
  expect(r.text).toContain('holiday call: Full3');
});

test('a holiday that gives an IR group no slots leaves that group\'s weekend as regular call', async ({ page }) => {
  const r = await page.evaluate(async ({ reset, preview, GROUP }) => {
    const mk = new Function('return ' + reset)(), run = new Function('return ' + preview)();
    mk(GROUP, { irDailyMax: 0, irWkndMax: 0 });
    S.holidayDefs = [
      { id: 9011, name: 'Day after Thanksgiving', year: 2027, dates: ['2027-11-26'], drSlots: 1, irSlotsByGroup: { North: 0, South: 0 } },   // DR only
      { id: 9012, name: 'Columbus Day', year: 2027, dates: ['2027-10-11'], drSlots: 0, irSlotsByGroup: { North: 1, South: 0 } },          // North only
      { id: 9013, name: 'Labor Day', year: 2027, dates: ['2027-09-06'], drSlots: 1, irSlotsByGroup: { North: 1, South: 1 } },
    ];
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    await run('year', null, 'weekend');
    const fri = d => (S.iraPreview || []).some(a => a.callType === 'weekend' && a.date === d);
    return { thanksgivingFri: fri('2027-11-26'), columbusSouth: fri('2027-10-08'), laborDay: fri('2027-09-03'),
      helper: [_irHolidayWeekend('2027-11-26', 'South'), _irHolidayWeekend('2027-10-08', 'South'), _irHolidayWeekend('2027-10-08', 'North'), _irHolidayWeekend('2027-09-03', 'South')] };
  }, { ...FN, GROUP });
  expect(r.helper).toEqual([false, false, true, true]);
  expect(r.thanksgivingFri).toBe(true);                      // was: skipped for every group and never staffed
  expect(r.columbusSouth).toBe(true);
  expect(r.laborDay).toBe(false);
});
