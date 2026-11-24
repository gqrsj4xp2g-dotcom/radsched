// Holiday Call filing year, the year-end holiday rollover, Day-Fill eligibility
// and the greedy builder's relaxed-rule notes (rs-v135).
//
// A manual Holiday Call assignment was filed under the Year box's default (2026)
// even for a 2027 holiday, so its definition still showed the slot open and the
// All Call workbook listed it under the wrong year. The rollover wizard gave every
// date an nth-weekday rule (Christmas 2027 → Dec 22/30/31 2028) and dropped the
// holiday's slots. Day-Fill put physicians on IR shifts the days they worked a DR
// shift, and re-picked a full schedule from scratch. The greedy builder labelled
// shifts that break a rule as plain 'Auto'.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=holiday-rollover-dayfill');
  await launchSyntheticUser(page, 'superuser');
});

test('Holiday Call: a 2027 holiday assigned with the Year box on 2026 is filed under 2027', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const wait = ms => new Promise(res => setTimeout(res, ms));
    window.confirm = () => true; window.alert = () => {};
    _isRestoring = true;
    S.irGroups = ['North', 'South'];
    S.physicians = [{ id: 501, first: 'T', last: 'North', role: 'IR', drFte: 0, irFte: 1, irGroup: 'North', drSubs: [], irSubs: [], address: '',
      shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [] }];
    S.holidayDefs = [
      { id: 1, name: 'Thanksgiving', year: 2026, dates: ['2026-11-26', '2026-11-27'], drSlots: 0, irSlotsByGroup: { North: 1, South: 0 } },
      { id: 2, name: 'Thanksgiving', year: 2027, dates: ['2027-11-25', '2027-11-26'], drSlots: 0, irSlotsByGroup: { North: 1, South: 0 } },
    ];
    S.holidays = []; S.irCalls = []; S.irShifts = []; S.drShifts = [];
    _isRestoring = false;
    nav('holidays', document.querySelector('.snav-item[data-pg="holidays"]')); await wait(30);
    holTab('assignments', document.querySelectorAll('#hol-tabs .tab')[1]); await wait(20);
    const sel = document.getElementById('hol-phys');
    if (![...sel.options].some(o => o.value === '501')) { const o = document.createElement('option'); o.value = '501'; o.textContent = 'North'; sel.appendChild(o); }
    sel.value = '501';
    document.getElementById('hol-yr').value = '2026';
    document.getElementById('hol-date').value = '2027-11-25';
    document.getElementById('hol-grp').value = 'IR-North';
    document.getElementById('hol-name').value = 'thanksgiving';
    addHoliday(); await wait(50);
    const h = S.holidays[S.holidays.length - 1] || {};
    return { n: S.holidays.length, year: h.year, name: h.name, box: document.getElementById('hol-yr').value };
  });
  expect(r.n).toBe(1);
  expect(r.year).toBe(2027);                 // the definition holding 2027-11-25, not the box's 2026
  expect(r.name).toBe('Thanksgiving');       // the definition's spelling, so its slot count links
  expect(r.box).toBe('2027');                // the box follows the season just used
});

test('Year-end rollover: federal holidays take next year\'s official dates and keep their slots', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const wait = ms => new Promise(res => setTimeout(res, ms));
    window.confirm = () => true; window.alert = () => {};
    const nyd = officialUSHolidays(2027).find(h => /new year/i.test(h.name));
    const xmas = officialUSHolidays(2027).find(h => /christmas/i.test(h.name));
    const slots = { drSlots: 2, irSlotsByGroup: { North: 1, South: 1 } };
    _isRestoring = true;
    S.holidayDefs = [
      Object.assign({ id: 11, name: 'Thanksgiving', year: 2027, dates: ['2027-11-25', '2027-11-26'], notes: 'custom 2' }, slots),
      Object.assign({ id: 12, name: 'Christmas Day', year: 2027, dates: xmas.dates.slice(), notes: 'Official (falls 2027-12-25, observed 2027-12-24)' }, slots),
      Object.assign({ id: 13, name: "New Year's Day", year: 2027, dates: nyd.dates.slice(), notes: 'Official' }, slots),
    ];
    S.holidays = []; S.nextId = Math.max(S.nextId || 0, 1000);
    _isRestoring = false;
    nav('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'reports'); await wait(50);
    document.getElementById('yr-target').value = '2028'; previewYearRollover(); await wait(20);
    const planned = _yrRolloverPlan.items.map(p => p.name + ':' + p.status);
    applyYearRollover(); await wait(300);
    const got = {};
    S.holidayDefs.filter(d => d.year === 2028).forEach(d => { got[d.name] = { dates: d.dates.slice().sort(), drSlots: d.drSlots, ir: d.irSlotsByGroup, notes: d.notes }; });
    const nyd28 = officialUSHolidays(2028).find(h => /new year/i.test(h.name));
    return { planned, got, nydExpect: nyd28.dates.slice().sort(), xmas27: xmas.dates };
  });
  expect(r.planned).toEqual(['Thanksgiving:add', 'Christmas Day:add', "New Year's Day:add"]);
  expect(r.xmas27).toEqual(['2027-12-24', '2027-12-25', '2027-12-26']);
  expect(r.got['Thanksgiving'].dates).toEqual(['2028-11-23', '2028-11-24']);           // Thu + Fri, not Nov 30
  expect(r.got['Christmas Day'].dates).toEqual(['2028-12-23', '2028-12-24', '2028-12-25']); // was Dec 22/30/31
  expect(r.got["New Year's Day"].dates).toEqual(r.nydExpect);
  for (const n of ['Thanksgiving', 'Christmas Day', "New Year's Day"]) {
    expect(r.got[n].drSlots).toBe(2);                                                   // staffing carried over
    expect(r.got[n].ir).toEqual({ North: 1, South: 1 });
  }
  expect(r.got['Christmas Day'].notes).toBe('Official');                                // Dec 25 2028 is a Monday
  expect(r.got['Thanksgiving'].notes).toBe('custom 2');
});

// Runs in the page: one South group, two sites (CHS 2 slots, STFS 2 slots every weekday).
function buildPractice() {
  _isRestoring = true;
  const mk = (id, last, fte, anchor) => ({
    id, first: 'T', last, role: 'IR', drFte: 0, irFte: fte, irGroup: 'South', anchorSite: anchor, irSitePrim: anchor || 'CHS', drSubs: [], irSubs: [], address: '',
    shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: ['CHS', 'STFS'], seqRules: null,
  });
  S.irGroups = ['North', 'South'];
  S.physicians = [mk(1, 'ChsA', 1, 'CHS'), mk(2, 'ChsB', 1, 'CHS'), mk(3, 'StfsA', 1, 'STFS'), mk(4, 'StfsB', 1, 'STFS'), mk(5, 'Float', 1, null)];
  S.sites = [{ name: 'CHS', irGroup: 'South', irAnchors: [], irFillins: [] }, { name: 'STFS', irGroup: 'South', irAnchors: [], irFillins: [] }];
  S.irShiftSlots = {}; ['CHS', 'STFS'].forEach(site => { for (let d = 0; d < 7; d++) S.irShiftSlots[`${site}|${d}|1st`] = (d >= 1 && d <= 5) ? 2 : 0; });
  S.irShiftSlotLabels = {};
  S.irCalls = []; S.irShifts = []; S.drShifts = []; S.holidays = []; S.holidayDefs = []; S.weekendCalls = []; S.natLangRules = []; S.tumorBoards = []; S.clinics = []; S.vacations = [];
  S.cfg = Object.assign({}, S.cfg, { anchorPct: 80 });
  _isRestoring = false;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
}
// Runs in the page: Rebalance → Day-Fill for H1 2027, then apply.
async function dayFill() {
  nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
  const ry = document.getElementById('irr-yr'); if (![...ry.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ry.appendChild(o); }
  ry.value = '2027'; document.getElementById('irr-period').value = 'H1'; document.getElementById('irr-grp').value = 'both'; document.getElementById('irr-type').value = 'day-fill';
  _irrPlan = null; previewIRRebalance();
  await new Promise(res => setTimeout(res, 300));
  for (let i = 0; i < 600 && !_irrPlan; i++) await new Promise(res => setTimeout(res, 50));
  await applyIRRebalance(); await new Promise(res => setTimeout(res, 300));
}

test('Day-Fill keeps physicians off the days they work a DR shift, and a second run changes nothing', async ({ page }) => {
  const r = await page.evaluate(async ({ build, fill }) => {
    const df = new Function('return ' + fill)();
    window.confirm = () => true; window.alert = () => {};
    new Function('return ' + build)()();
    // ChsB works a DR day shift every Monday and Wednesday of January–March 2027.
    _isRestoring = true;
    let d = '2027-01-01';
    while (d < '2027-04-01') { const w = parseDateLocal(d).getDay(); if (w === 1 || w === 3) S.drShifts.push({ id: S.nextId++, physId: 2, date: d, shift: '1st', site: 'Main', sub: '', notes: '' }); d = addDays(d, 1); }
    _isRestoring = false;
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const drDays = new Set(S.drShifts.map(s => s.date));
    await df();
    const inH1 = s => s.date >= '2027-01-01' && s.date <= '2027-06-30' && s.shift !== 'Home';
    const first = S.irShifts.filter(inH1);
    const perDay = {}; first.forEach(s => { const k = s.physId + '|' + s.date; perDay[k] = (perDay[k] || 0) + 1; });
    const sig = list => list.map(s => [s.id, s.physId, s.date, s.site, s.slotLabel || ''].join('|')).sort().join('\n');
    const before = sig(first);
    await df();
    const second = S.irShifts.filter(inH1);
    return {
      n: first.length,
      onDR: first.filter(s => s.physId === 2 && drDays.has(s.date)).length,
      doubles: Object.values(perDay).filter(v => v > 1).length,
      same: sig(second) === before, n2: second.length,
    };
  }, { build: buildPractice.toString(), fill: dayFill.toString() });
  expect(r.n).toBeGreaterThan(400);    // ~125 weekdays × 4 slots, five physicians
  expect(r.onDR).toBe(0);              // never on an IR shift the day of a DR shift
  expect(r.doubles).toBe(0);
  expect(r.n2).toBe(r.n);
  expect(r.same).toBe(true);           // a full, balanced schedule is left exactly as it is
});

test('Greedy builder: a shift placed by relaxing a sequence rule says so', async ({ page }) => {
  const r = await page.evaluate(async () => {
    window.confirm = () => true; window.alert = () => {};
    _isRestoring = true;
    S.irGroups = ['North', 'South'];
    S.physicians = [{ id: 1, first: 'T', last: 'Solo', role: 'IR', drFte: 0, irFte: 1, irGroup: 'South', anchorSite: 'CHS', irSitePrim: 'CHS', drSubs: [], irSubs: [], address: '',
      shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: ['CHS'], seqRules: { maxConsec: 2 } }];
    S.sites = [{ name: 'CHS', irGroup: 'South', irAnchors: [], irFillins: [] }];
    S.irShiftSlots = {}; for (let d = 0; d < 7; d++) S.irShiftSlots[`CHS|${d}|1st`] = (d >= 1 && d <= 5) ? 1 : 0;
    S.irShiftSlotLabels = {};
    S.irCalls = []; S.irShifts = []; S.drShifts = []; S.holidays = []; S.holidayDefs = []; S.weekendCalls = []; S.natLangRules = []; S.tumorBoards = []; S.clinics = []; S.vacations = [];
    S.cfg = Object.assign({}, S.cfg, { useSolver: 'greedy', anchorPct: 80 });
    _isRestoring = false;
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    nav('ir-shift-auto', document.querySelector('.snav-item[data-pg="ir-shift-auto"]'));
    const sy = document.getElementById('irsa-yr');
    if (![...sy.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; sy.appendChild(o); }
    sy.value = '2027';
    document.getElementById('irsa-period').value = 'month'; _irsaTogglePeriodInputs();
    document.getElementById('irsa-mo').value = '2027-02'; document.getElementById('irsa-grp').value = 'both';
    _irsaPreview = []; previewIRShiftAA();
    await new Promise(res => setTimeout(res, 300));
    for (let i = 0; i < 600 && (document.getElementById('irsa-progress') || !_irsaPreview.length); i++) await new Promise(res => setTimeout(res, 50));
    await new Promise(res => setTimeout(res, 150));
    const rows = _irsaPreview.slice();
    return { n: rows.length, relaxed: rows.filter(a => a.notes === 'Auto (sequence rule relaxed)').length,
      header: /rule relaxed/.test(document.body.innerText) };
  });
  expect(r.n).toBe(19);                // every weekday slot (Presidents' Day off): nobody else can cover
  expect(r.relaxed).toBeGreaterThan(0);  // was labelled plain 'Auto'
  expect(r.header).toBe(true);           // the preview summary counts them
});
