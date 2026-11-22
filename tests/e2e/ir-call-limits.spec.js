// IR call limits (rs-v128).
//
// The IR call builders must never assign a physician past
//   • the Settings maximum for the year (per-1.0-FTE maximum × IR FTE × the
//     part of the year on staff), or
//   • their fair share of the build period: the period's call split by IR FTE
//     (start-date aware; vacation does not change it), plus whatever a
//     colleague cannot take (at their maximum, or away),
// and must report whatever cannot be covered inside those limits as a gap.
//
// Before rs-v128 the share was advisory ("over FTE" picks) and the Settings
// maximums were never read. On the practice's real 2027 inputs a 1.0 FTE
// physician starting May 1 with a maximum of 31 / 8 (→ 21 / 5) was given 31
// weekday and 9 weekend calls, and every physician showed 120–145 % of target.
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// Runs in the page: one IR group shaped like a real one (two half-timers, four
// full-timers, one full-timer who starts on May 1).
function buildGroup({ maxD = 31, maxW = 8, start = '2027-05-01' } = {}) {
  _isRestoring = true;
  const mk = (id, last, fte, extra) => Object.assign({
    id, first: 'T', last, role: 'IR', drFte: 0, irFte: fte, irGroup: 'South', drSubs: [], irSubs: [], address: '',
    shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [],
  }, extra || {});
  S.physicians = [mk(1, 'Half1', 0.5), mk(2, 'Full1', 1), mk(3, 'Half2', 0.5), mk(4, 'Starter', 1, start ? { startDate: start } : {}),
    mk(5, 'Full2', 1), mk(6, 'Full3', 1), mk(7, 'Full4', 1)];
  S.irCalls = []; S.vacations = []; S.holidays = []; S.holidayDefs = []; S.irShifts = []; S.drShifts = []; S.weekendCalls = []; S.natLangRules = [];
  S.tumorBoards = []; S.clinics = [];
  S.cfg = Object.assign({}, S.cfg, { irDailyMax: maxD, irWkndMax: maxW, irMax: maxD });
  _isRestoring = false;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
}
// Runs in the page: preview the IR call builder for (part of) 2027 and summarise it.
async function previewPeriod(period, ym) {
  nav('ir-auto', document.querySelector('.snav-item[data-pg="ir-auto"]'));
  const yr = document.getElementById('ira-yr');
  if (![...yr.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; yr.appendChild(o); }
  yr.value = '2027';
  document.getElementById('ira-period').value = period; _iraTogglePeriodInputs();
  if (ym) document.getElementById('ira-mo').value = ym;
  document.getElementById('ira-type').value = 'both'; document.getElementById('ira-grp').value = 'both';
  S.iraPreview = [];
  previewIRAA();
  await new Promise(r => setTimeout(r, 250));
  for (let i = 0; i < 600 && document.getElementById('iraa-progress'); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 100));
  const pv = S.iraPreview || [];
  const cells = _iraMonths().flatMap(m => _filterCellsByPeriod(buildCal(m), period)).filter(c => c.day);
  const hol = c => typeof c.notes === 'string' && c.notes.includes('(Holiday)');
  // regular call slots: Mon–Thu that are not holidays; Fridays whose Fri→Mon span is not all holiday
  const slots = kind => cells.filter(c => (kind === 'daily'
    ? (c.dow >= 1 && c.dow <= 4 && !isHolidayBlackout(c.date))
    : (c.dow === 5 && ![0, 1, 2, 3].every(i => isHolidayBlackout(addDays(c.date, i)))))).map(c => c.date);
  const open = kind => slots(kind).filter(d => !pv.some(a => a.callType === kind && a.date === d) && !S.irCalls.some(c => c.callType === kind && c.date === d));
  const text = document.getElementById('ira-box').textContent.replace(/\s+/g, ' ');
  const lim = (previewIRAA._last || {}).lim || {};
  return {
    rows: S.physicians.map(p => {
      const mine = pv.filter(a => a.physId === p.id);
      const yrCount = kind => mine.filter(a => a.callType === kind).length + S.irCalls.filter(c => c.physId === p.id && c.callType === kind && !hol(c) && c.date.startsWith('2027')).length;
      const perMonth = Array(12).fill(0); mine.filter(a => a.callType === 'daily').forEach(a => { perMonth[+a.date.slice(5, 7) - 1]++; });
      const L = lim[p.id] || {};
      return { last: p.last, fte: p.irFte, daily: yrCount('daily'), weekend: yrCount('weekend'), newDaily: mine.filter(a => a.callType === 'daily').length, newWeekend: mine.filter(a => a.callType === 'weekend').length,
        maxD: _irCallMaxYear(p, 'daily', 2027), maxW: _irCallMaxYear(p, 'weekend', 2027),
        baseD: L.D ? L.D.base : null, baseW: L.W ? L.W.base : null, shareD: L.D ? L.D.share : null, shareW: L.W ? L.W.share : null,
        first: mine.map(a => a.date).sort()[0] || null, perMonth };
    }),
    nDaily: slots('daily').length, nWeekend: slots('weekend').length,
    openDaily: open('daily'), openWeekend: open('weekend'), assigned: pv.length, text,
    backToBack: (() => { let n = 0; S.physicians.forEach(p => { const days = pv.filter(a => a.physId === p.id && a.callType === 'daily').map(a => a.date).sort(); for (let i = 1; i < days.length; i++) if (_daysBetween(days[i - 1], days[i]) === 1) n++; }); return n; })(),
  };
}
// Runs in the page: apply the current preview without the dialogs.
async function applyPreview() {
  const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
  applyIRAA(); await new Promise(res => setTimeout(res, 300));
  window.confirm = realConfirm; window.alert = realAlert;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
}
const FN = { build: buildGroup.toString(), preview: previewPeriod.toString(), apply: applyPreview.toString() };

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=ir-limits');
  await launchSyntheticUser(page, 'superuser');
});

test('nobody is assigned past the Settings maximum; a mid-year starter gets maximum × FTE × part of the year', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    new Function('return ' + build)()({ maxD: 31, maxW: 8 });
    return await new Function('return ' + preview)()('year');
  }, FN);

  const by = name => r.rows.find(x => x.last === name);
  expect(by('Starter').maxD).toBe(21);                 // 31 × 1.0 × 245/365
  expect(by('Starter').maxW).toBe(5);                  // 8 × 0.671
  expect(by('Full1').maxD).toBe(31);
  expect(by('Half1').maxD).toBe(16);
  r.rows.forEach(x => {
    expect(x.daily, `${x.last} weekday calls`).toBeLessThanOrEqual(x.maxD);
    expect(x.weekend, `${x.last} weekend calls`).toBeLessThanOrEqual(x.maxW);
  });
  // The group needs more than the maximum allows, so everyone is used right up to it.
  expect(by('Starter').daily).toBe(21);
  expect(by('Starter').weekend).toBe(5);
  expect(by('Full1').daily).toBe(31);
  expect(by('Full1').weekend).toBe(8);
  expect(by('Half1').daily).toBe(16);
  expect(by('Half1').weekend).toBe(4);
  expect(by('Starter').first >= '2027-05-01').toBe(true);   // nothing before the start date
  expect(r.backToBack).toBe(0);
  // The fair share is by FTE: the starter's is 245/365 of a full-timer's, a half-timer's is half.
  expect(by('Starter').baseD / by('Full1').baseD).toBeCloseTo(245 / 365, 1);
  expect(by('Half1').baseD / by('Full1').baseD).toBeCloseTo(0.5, 6);

  // What the maximum cannot cover is left open — and said so, with the number that would cover it.
  expect(r.openDaily.length).toBe(r.nDaily - (4 * 31 + 2 * 16 + 21));
  expect(r.text).toContain('left open rather than assign anyone past a limit');
  expect(r.text).toContain('at Settings maximum');
  expect(r.text).toMatch(/would need to be — South: about \d+ weekday/);
  // …and the open days are spread through the year, not piled into its last months.
  const perMonth = Array(12).fill(0); r.openDaily.forEach(d => { perMonth[+d.slice(5, 7) - 1]++; });
  expect(perMonth.filter(n => n > 0).length).toBeGreaterThanOrEqual(9);
  expect(Math.max(...perMonth)).toBeLessThanOrEqual(6);
});

test('with room under the maximum every slot is filled, nobody exceeds their FTE share, and a newcomer is not front-loaded', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    new Function('return ' + build)()({ maxD: 60, maxW: 20 });
    return await new Function('return ' + preview)()('year');
  }, FN);

  expect(r.openDaily).toEqual([]);
  expect(r.openWeekend).toEqual([]);
  expect(r.rows.reduce((s, x) => s + x.baseD, 0)).toBeCloseTo(r.nDaily, 6);     // the shares add up to the slots
  expect(r.rows.reduce((s, x) => s + x.baseW, 0)).toBeCloseTo(r.nWeekend, 6);
  r.rows.forEach(x => {
    expect(x.daily, `${x.last} weekday calls vs share ${x.baseD.toFixed(1)}`).toBeLessThanOrEqual(Math.ceil(x.baseD - 1e-9));
    expect(x.weekend, `${x.last} weekend calls vs share ${x.baseW.toFixed(1)}`).toBeLessThanOrEqual(Math.ceil(x.baseW - 1e-9));
  });
  const starter = r.rows.find(x => x.last === 'Starter');
  const full = r.rows.find(x => x.last === 'Full1');
  expect(starter.daily / full.daily).toBeGreaterThan(0.6);   // 245/365 of a full-timer's year
  expect(starter.daily / full.daily).toBeLessThan(0.75);
  expect(starter.perMonth.slice(0, 4)).toEqual([0, 0, 0, 0]);
  expect(Math.max(...starter.perMonth)).toBeLessThanOrEqual(5);   // was 8 in the first month before rs-v128
  expect(r.backToBack).toBe(0);
});

test('vacation moves when someone takes call, not how much: the fair share follows FTE', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    new Function('return ' + build)()({ maxD: 60, maxW: 20, start: null });
    // Full1 has eight weeks of vacation picked, Full2 has none yet; Half1's off weeks are entered as vacation.
    const wk = (pid, d) => S.vacations.push({ id: 7000 + S.vacations.length, physId: pid, start: d, end: addDays(d, 8), type: 'Vacation' });
    ['2027-02-06', '2027-03-20', '2027-05-01', '2027-06-12', '2027-07-24', '2027-09-04', '2027-10-16', '2027-11-27'].forEach(d => wk(2, d));
    for (let d = '2027-01-02'; d < '2027-12-20'; d = addDays(d, 14)) wk(1, d);
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    return await new Function('return ' + preview)()('year');
  }, FN);

  const by = name => r.rows.find(x => x.last === name);
  expect(by('Full1').baseD).toBeCloseTo(by('Full2').baseD, 6);          // same FTE → same share, vacation or not
  expect(by('Half1').baseD).toBeCloseTo(by('Full2').baseD / 2, 6);      // half the FTE → half the share
  expect(Math.abs(by('Full1').daily - by('Full2').daily)).toBeLessThanOrEqual(1);
  expect(Math.abs(by('Half1').daily - by('Half2').daily)).toBeLessThanOrEqual(1);
  expect(r.openDaily).toEqual([]);
  expect(r.openWeekend).toEqual([]);
  r.rows.forEach(x => expect(x.daily, `${x.last}`).toBeLessThanOrEqual(Math.ceil(x.baseD - 1e-9)));
});

test('holiday call weekends are not part of the maximum and do not shrink it', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    new Function('return ' + build)()({ maxD: 31, maxW: 8 });
    // Holiday call is assigned first: four holiday weekends already belong to someone.
    [['2027-05-28', 2], ['2027-07-02', 5], ['2027-09-03', 6], ['2027-12-24', 7]].forEach(([d, pid], i) =>
      S.irCalls.push({ id: 9100 + i, physId: pid, date: d, callType: 'weekend', irGroup: 'South', site: '', notes: 'Holiday weekend (Holiday)' }));
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    return await new Function('return ' + preview)()('year');
  }, FN);

  const by = name => r.rows.find(x => x.last === name);
  ['Full1', 'Full2', 'Full3', 'Full4'].forEach(n => expect(by(n).weekend, `${n} regular weekends`).toBe(8));   // was 7: 8 × 49/53 rounded
  expect(by('Starter').weekend).toBe(5);
  expect(by('Half1').weekend).toBe(4);
  expect(r.openWeekend.length).toBe(r.nWeekend - 4 - (4 * 8 + 2 * 4 + 5));     // 4 holiday weekends are not regular slots
  expect(r.text).toContain('Holiday call is counted on the Holiday tab');
});

test('building month by month uses the yearly maximum as fully as one annual build does', async ({ page }) => {
  test.setTimeout(120000);
  const r = await page.evaluate(async ({ build, preview, apply }) => {
    new Function('return ' + build)()({ maxD: 31, maxW: 8 });
    const run = new Function('return ' + preview)(), doApply = new Function('return ' + apply)();
    let last = null; const openByMonth = [];
    for (let m = 1; m <= 12; m++) {
      last = await run('month', `2027-${String(m).padStart(2, '0')}`);
      openByMonth.push(last.openDaily.length);
      await doApply();
    }
    const hol = c => typeof c.notes === 'string' && c.notes.includes('(Holiday)');
    return { openByMonth, rows: S.physicians.map(p => ({ last: p.last,
      daily: S.irCalls.filter(c => c.physId === p.id && c.callType === 'daily' && !hol(c) && c.date.startsWith('2027')).length,
      weekend: S.irCalls.filter(c => c.physId === p.id && c.callType === 'weekend' && !hol(c) && c.date.startsWith('2027')).length,
      maxD: _irCallMaxYear(p, 'daily', 2027), maxW: _irCallMaxYear(p, 'weekend', 2027) })) };
  }, FN);

  r.rows.forEach(x => {
    expect(x.daily, `${x.last} weekday calls in the year`).toBeLessThanOrEqual(x.maxD);
    expect(x.weekend, `${x.last} weekend calls in the year`).toBeLessThanOrEqual(x.maxW);
    expect(x.daily, `${x.last} weekday calls in the year`).toBeGreaterThanOrEqual(x.maxD - 2);
    expect(x.weekend, `${x.last} weekend calls in the year`).toBeGreaterThanOrEqual(x.maxW - 1);   // a half-timer used to get 0: round(4 × 4/53)
  });
  expect(r.openByMonth.filter(n => n > 0).length).toBeGreaterThanOrEqual(8);   // the shortfall is spread, not dumped on December
});

test('the two halves of the year, and the two halves of a month, build one after the other', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, apply }) => {
    // (functions are created before the first await: the page's CSP forbids new Function() later)
    const mk = new Function('return ' + build)(), run = new Function('return ' + preview)(), doApply = new Function('return ' + apply)();
    mk({ maxD: 31, maxW: 8 });
    const h1 = await run('H1'); await doApply();
    const h2 = await run('H2');
    const year = { h1Open: h1.openDaily.length, h2Open: h2.openDaily.length, rows: h2.rows };
    // a fresh practice with room under the maximum: first half of October, then the second
    mk({ maxD: 60, maxW: 20 });
    const s1 = await run('semi-1', '2027-10'); await doApply();
    const s2 = await run('semi-2', '2027-10');
    return { year, s1: { open: s1.openDaily.length + s1.openWeekend.length, n: s1.assigned }, s2: { open: s2.openDaily.length + s2.openWeekend.length, n: s2.assigned, text: s2.text } };
  }, FN);

  r.year.rows.forEach(x => {                               // year totals = applied H1 + previewed H2
    expect(x.daily, `${x.last} weekday calls in the year`).toBeLessThanOrEqual(x.maxD);
    expect(x.weekend, `${x.last} weekend calls in the year`).toBeLessThanOrEqual(x.maxW);
    expect(x.daily, `${x.last} weekday calls in the year`).toBeGreaterThanOrEqual(x.maxD - 1);
  });
  expect(r.year.h1Open).toBeGreaterThan(0);                // the first half does not spend the whole year's allowance…
  expect(r.year.h2Open).toBeGreaterThan(0);                // …and the second half is not left to absorb all of it
  expect(Math.abs(r.year.h1Open - r.year.h2Open)).toBeLessThanOrEqual(8);
  expect(r.s1.open).toBe(0);
  expect(r.s2.n).toBeGreaterThan(0);                       // used to be 0: whole-month counts against half-month shares
  expect(r.s2.open).toBe(0);
});

test('what a colleague cannot take is split among the others — never past the maximum', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    const run = new Function('return ' + preview)();
    new Function('return ' + build)()({ maxD: 60, maxW: 20, start: null });
    // Full1 takes no IR call from January through May: June alone cannot hold a half-year's share.
    S.physicians.find(p => p.last === 'Full1').irCallBlackouts = [{ start: '2027-01-01', end: '2027-05-31', reason: 'leave' }];
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const roomy = await run('H1');
    S.cfg.irDailyMax = 30; S.cfg.irMax = 30;               // H1 pace: 15 each — not enough to absorb it
    const tight = await run('H1');
    return { roomy, tight };
  }, FN);

  const by = (res, name) => res.rows.find(x => x.last === name);
  expect(r.roomy.openDaily).toEqual([]);                   // covered by the others…
  expect(by(r.roomy, 'Full1').newDaily).toBeLessThan(by(r.roomy, 'Full2').newDaily);
  expect(by(r.roomy, 'Full2').shareD).toBeGreaterThan(by(r.roomy, 'Full2').baseD);   // …whose share grew by what Full1 cannot take
  expect(r.roomy.text).toContain('↑');
  r.roomy.rows.forEach(x => expect(x.daily, `${x.last}`).toBeLessThanOrEqual(Math.ceil(x.shareD - 1e-9)));
  r.tight.rows.forEach(x => expect(x.daily, `${x.last} under the tighter maximum`).toBeLessThanOrEqual(x.maxD));
  expect(r.tight.openDaily.length).toBeGreaterThan(0);     // the maximum wins over coverage
  expect(r.tight.text).toContain('at Settings maximum');
});

test('Settings: yearly maximums above 31, blank means none, and the DR weekend field is the yearly cap', async ({ page }) => {
  const r = await page.evaluate(() => {
    S.cfg = Object.assign({}, S.cfg, { wkMax: 4, wkndYearCapBase: 7.5, irDailyMax: 31, irWkndMax: 8, irMax: 31 });
    nav('settings', document.querySelector('.snav-item[data-pg="settings"]'));
    const val = id => document.getElementById(id).value;
    const shown = { wk: val('cfg-wk'), d: val('cfg-ir-daily'), w: val('cfg-ir-wknd') };
    const set = (id, v) => { document.getElementById(id).value = String(v); };
    set('cfg-ir-daily', 40); set('cfg-ir-wknd', 10); set('cfg-wk', 9);
    saveCfg();
    const dr = { id: 900, first: 'D', last: 'R', role: 'DR', drFte: 1, irFte: 0, shiftElig: { s1: true, wknd: true } };
    const starter = { id: 901, first: 'I', last: 'R', role: 'IR', drFte: 0, irFte: 1, startDate: '2027-07-01' };
    const out = { shown, daily: S.cfg.irDailyMax, wknd: S.cfg.irWkndMax, wk: S.cfg.wkMax, yearBase: S.cfg.wkndYearCapBase, drCap: _wkndYearCap(dr, 2027),
      starterMax: _irCallMaxYear(starter, 'daily', 2027), starterMaxNext: _irCallMaxYear(starter, 'daily', 2028), starterMaxBefore: _irCallMaxYear(starter, 'daily', 2026),
      labels: [...document.querySelectorAll('label')].map(l => l.textContent).filter(t => /per year \(1\.0 FTE\)/.test(t)).length };
    set('cfg-ir-daily', ''); set('cfg-ir-wknd', ''); set('cfg-wk', '');
    saveCfg();
    out.blank = { dailyMax: _irCallMaxYear(starter, 'daily', 2028), wkndMax: _irCallMaxYear(starter, 'weekend', 2028), yearBase: !(S.cfg.wkndYearCapBase > 0), drCap: _wkndYearCap(dr, 2027), wk: S.cfg.wkMax };
    renderSettings();
    out.blank.shown = { wk: val('cfg-wk'), d: val('cfg-ir-daily'), w: val('cfg-ir-wknd') };
    return out;
  });
  expect(r.shown).toEqual({ wk: '7.5', d: '31', w: '8' });   // the field shows the cap that is enforced, not the old monthly number
  expect(r.daily).toBe(40);                                // used to be silently cut to 31
  expect(r.wknd).toBe(10);
  expect(r.yearBase).toBe(9);                              // the DR weekend builders follow the Settings number
  expect(r.drCap).toBe(9);
  expect(r.wk).toBe(4);                                    // the per-month figure other screens read is left alone
  expect(r.starterMax).toBe(20);                           // 40 × 184/365
  expect(r.starterMaxNext).toBe(40);
  expect(r.starterMaxBefore).toBe(0);
  expect(r.labels).toBe(3);
  expect(r.blank.dailyMax).toBe(Infinity);                 // blank = no maximum
  expect(r.blank.wkndMax).toBe(Infinity);
  expect(r.blank.yearBase).toBe(true);
  expect(r.blank.drCap).toBeNull();
  expect(r.blank.wk).toBe(4);
  expect(r.blank.shown).toEqual({ wk: '', d: '', w: '' });
});

test('with no maximum in Settings the fair share alone decides, and every slot is filled', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    new Function('return ' + build)()({ maxD: 0, maxW: 0 });
    return await new Function('return ' + preview)()('year');
  }, FN);
  expect(r.openDaily).toEqual([]);
  expect(r.openWeekend).toEqual([]);
  r.rows.forEach(x => {
    expect(x.maxD).toBe(Infinity);
    expect(x.daily, `${x.last}`).toBeLessThanOrEqual(Math.ceil(x.baseD - 1e-9));
  });
  expect(r.text).not.toContain('Infinity');
  expect(r.text).not.toContain('NaN');
});

test('a manual IR call past the maximum asks first; holiday call and "no maximum" do not', async ({ page }) => {
  const r = await page.evaluate(({ build }) => {
    new Function('return ' + build)()({ maxD: 31, maxW: 8 });
    const starter = S.physicians.find(p => p.last === 'Starter'), full = S.physicians.find(p => p.last === 'Full1');
    for (let i = 0; i < 5; i++) S.irCalls.push({ id: 9200 + i, physId: starter.id, date: addDays('2027-06-04', i * 14), callType: 'weekend', irGroup: 'South', site: '', notes: 'Manual' });
    S.irCalls.push({ id: 9300, physId: full.id, date: '2027-05-28', callType: 'weekend', irGroup: 'South', site: '', notes: 'Memorial Day (Holiday)' });
    for (let i = 0; i < 7; i++) S.irCalls.push({ id: 9310 + i, physId: full.id, date: addDays('2027-01-08', i * 14), callType: 'weekend', irGroup: 'South', site: '', notes: 'Manual' });
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const asked = []; const real = window.confirm; window.confirm = m => { asked.push(m); return false; };
    const out = {};
    out.starterAtMax = _confirmIrCallMax(starter, 'weekend', '2027-11-05');     // 5 of 5 → asks (and we answer no)
    out.fullWithHoliday = _confirmIrCallMax(full, 'weekend', '2027-11-05');     // 7 regular + 1 holiday of 8 → no question
    out.daily = _confirmIrCallMax(starter, 'daily', '2027-11-08');              // weekday count is separate
    S.cfg.irWkndMax = 0;
    out.noMax = _confirmIrCallMax(starter, 'weekend', '2027-11-05');
    window.confirm = real;
    return { out, asked };
  }, FN);
  expect(r.out).toEqual({ starterAtMax: false, fullWithHoliday: true, daily: true, noMax: true });
  expect(r.asked.length).toBe(1);
  expect(r.asked[0]).toContain('already has 5 IR weekend calls in 2027');
  expect(r.asked[0]).toContain('maximum is 5');
});

test('the preview says when a conference rotation has no assignments for the period', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview }) => {
    new Function('return ' + build)()({ maxD: 60, maxW: 20, start: null });
    S.tumorBoards = [{ id: 501, name: 'gi board', active: true, skipDates: [], recurrence: { kind: 'weekly', days: [3], interval: 1 }, allowedPhysIds: [2, 5],
      rotation: { enabled: true, slots: [{ id: 'slot-0', label: 'A', filter: {}, physRotation: [2, 5] }], assignments: { '2027-01-06': { 'slot-0': { physId: 2 } }, '2027-01-13': { 'slot-0': { physId: 5 } } } } }];
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const out = await new Function('return ' + preview)()('month', '2027-01');
    const wed = d => (S.iraPreview || []).find(a => a.callType === 'daily' && a.date === d);
    out.jan6 = (wed('2027-01-06') || {}).physId; out.jan20 = (wed('2027-01-20') || {}).physId;
    return out;
  }, FN);
  expect(r.text).toContain('Conference rotation not assigned for part of this period');
  expect(r.text).toContain('gi board');
  expect(r.jan6).not.toBe(2);                              // the assigned physician is held back that day…
  expect([2, 5]).not.toContain(r.jan20);                   // …and with no assignment, both participants are
});

test('the IR rebalancer never hands anyone a new date past the limits', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, apply }) => {
    new Function('return ' + build)()({ maxD: 60, maxW: 20 });
    const run = new Function('return ' + preview)(), doApply = new Function('return ' + apply)();
    await run('H1');
    await doApply();
    // tighten the maximum afterwards, then ask the rebalancer to redistribute H1
    S.cfg.irDailyMax = 24; S.cfg.irMax = 24; S.cfg.irWkndMax = 6;
    if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {};
    nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]'));
    renderIRRebalancePrep();
    const yr = document.getElementById('irr-yr'); if (![...yr.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; yr.appendChild(o); }
    yr.value = '2027'; document.getElementById('irr-period').value = 'H1'; document.getElementById('irr-grp').value = 'both'; document.getElementById('irr-type').value = 'both';
    _irrPlan = null;
    previewIRRebalance();
    await new Promise(res => setTimeout(res, 300));
    for (let i = 0; i < 600 && !_irrPlan; i++) await new Promise(res => setTimeout(res, 50));
    window.confirm = realConfirm; window.alert = realAlert;
    const plan = _irrPlan || {};
    const months = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'];
    const slots = kind => months.flatMap(ym => buildCal(ym).filter(c => c.day && (kind === 'daily' ? (c.dow >= 1 && c.dow <= 4 && !isHolidayBlackout(c.date)) : (c.dow === 5 && ![0, 1, 2, 3].every(i => isHolidayBlackout(addDays(c.date, i)))))).map(c => c.date));
    const limit = kind => {
      const mx = _irGroupCallMax(S.physicians, kind, _irYearSlots(kind, 2027, 'South'), '2027-01-01', '2027-06-30', 2027), room = {};
      S.physicians.forEach(p => { room[p.id] = Math.max(0, Math.min(mx[p.id].pace - mx[p.id].before, mx[p.id].max - mx[p.id].before - mx[p.id].after)); });
      const sh = _irFairShares(S.physicians, slots(kind), kind, room).share;
      return p => Math.min(Math.ceil(sh[p.id] - 1e-9), room[p.id]);
    };
    const lD = limit('daily'), lW = limit('weekend');
    const text = document.getElementById('irr-preview').textContent.replace(/\s+/g, ' ');
    return { hasPlan: !!_irrPlan, text, rows: S.physicians.map(p => {
      const mine = k => (plan[k] || []).filter(a => a.physId === p.id);
      return { last: p.last, daily: mine('daily').length, limitD: lD(p), gainedD: mine('daily').filter(a => a.origPhysId !== p.id).length,
        weekend: mine('weekend').length, limitW: lW(p), gainedW: mine('weekend').filter(a => a.origPhysId !== p.id).length,
        early: mine('daily').concat(mine('weekend')).filter(a => p.startDate && a.date < p.startDate).length };
    }) };
  }, FN);

  expect(r.hasPlan).toBe(true);
  expect(r.text).toContain('Fair share');
  expect(r.text).toContain('2027 / max');
  r.rows.forEach(x => {
    // Past the limit only with calls that were already theirs (nobody else could take them) — never with a new one.
    if (x.daily > x.limitD) expect(x.gainedD, `${x.last} gained weekday dates while over the limit`).toBe(0);
    if (x.weekend > x.limitW) expect(x.gainedW, `${x.last} gained weekends while over the limit`).toBe(0);
    expect(x.early, `${x.last} calls before the start date`).toBe(0);
  });
});
