// DR Auto-Assign preview (rs-v136).
//
// The preview calls drHomeCnt() to read each physician's Home shifts for the month. That helper was removed in
// the rs-v101 dead-code pass while previewAA still used it, so from then until rs-v136 every DR Auto-Assign
// preview stopped with "previewAA threw an error: drHomeCnt is not defined" and produced no plan.
// Fails on rs-v135.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=dr-auto-assign');
  await launchSyntheticUser(page, 'superuser');
});

test('DR Auto-Assign preview builds a plan for a month (no "drHomeCnt is not defined")', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const alerts = []; window.alert = m => { alerts.push(String(m)); }; window.confirm = () => true;
    const wait = ms => new Promise(res => setTimeout(res, ms));
    _isRestoring = true;
    const mk = (id, last, site) => ({ id, first: 'T', last, role: 'DR', drFte: 1, irFte: 0, drSite: site, drSubs: [], irSubs: [], address: '',
      shiftElig: { s1: true, s2: false, s3: false, home: true, wknd: false }, allowedSites: ['SiteA', 'SiteB', 'At Home / Remote'], siteRules: [], tbRules: [],
      dayConditions: [], callDayRules: [], siteSeqRules: [], seqRules: null, irCallBlackouts: [], drHomePctPref: null });
    S.physicians = [mk(1, 'Ames', 'SiteA'), mk(2, 'Boyd', 'SiteA'), mk(3, 'Cole', 'SiteB'), mk(4, 'Dunn', 'SiteB')];
    S.sites = [{ name: 'SiteA', irGroup: '' }, { name: 'SiteB', irGroup: '' }, { name: 'At Home / Remote', irGroup: '' }];
    S.siteSlots = {}; ['SiteA', 'SiteB'].forEach(s => { for (let w = 1; w <= 5; w++) S.siteSlots[`${s}|${w}|1st`] = 2; });
    S.drShifts = []; S.irShifts = []; S.irCalls = []; S.weekendCalls = []; S.vacations = []; S.holidays = []; S.holidayDefs = []; S.natLangRules = [];
    S.tumorBoards = []; S.clinics = []; S.openShifts = [];
    // one Home shift already on the schedule, so drHomeCnt has something to count
    S.drShifts.push({ id: 9001, physId: 1, date: '2027-03-01', shift: 'Home', site: 'At Home / Remote', sub: '', notes: '', autoHome: false });
    _isRestoring = false; if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty(); if (typeof _invalidateCountCaches === 'function') _invalidateCountCaches();
    nav('auto-assign', document.querySelector('.snav-item[data-pg="auto-assign"]'));
    document.getElementById('aa-mo').value = '2027-03'; document.getElementById('aa-type').value = 'weekday';
    const per = document.getElementById('aa-period'); if (per) per.value = 'month';
    let threw = null; try { previewAA(); } catch (e) { threw = String(e && e.message || e); }
    for (let i = 0; i < 100 && !(S.aaPreview || []).length && !alerts.length; i++) await wait(50);
    const pv = S.aaPreview || [];
    return { helper: typeof drHomeCnt, homeCount: typeof drHomeCnt === 'function' ? drHomeCnt(1, '2027-03') : null, threw, alerts,
      n: pv.length, inMonth: pv.every(a => String(a.date).startsWith('2027-03')), people: new Set(pv.map(a => a.physId)).size,
      box: (document.getElementById('aa-box') || {}).textContent.slice(0, 120) };
  });
  expect(r.threw).toBe(null);
  expect(r.alerts).toEqual([]);                 // was: "previewAA threw an error: drHomeCnt is not defined"
  expect(r.helper).toBe('function');
  expect(r.homeCount).toBe(1);
  expect(r.n).toBeGreaterThan(20);              // four physicians, 23 weekdays, four slots a day
  expect(r.inMonth).toBe(true);
  expect(r.people).toBeGreaterThan(1);
});
