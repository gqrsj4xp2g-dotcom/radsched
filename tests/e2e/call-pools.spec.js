// IR call pools (rs-v136).
//
// IR call is assigned in a physician's primary group (p.irGroup) first. A pool's
// calls left open once its own members hold their fair share (or are at the
// Settings maximum) go to the physicians who list that pool in their profile
// ("Also takes IR call for", p.irCallPools — ordered, most preferred first):
// spread evenly by the room each has left under the Settings maximum; the
// ranking only decides which pool a physician's spare room goes to first.
// The pools are whatever IR groups exist — including one with no members,
// whose calls come only from those who list it. The procedure shift paired
// with a weekday call taken in another pool is the physician's own: their own
// primary site and their own IR group.
//
// Synthetic practices only. Pools: Alpha, Beta, Gamma, Delta (Delta has no
// members). Every practice is built in the page by buildPractice().
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

// Runs in the page. phys: [{id, last, fte, group, prim, pools, start}]
function buildPractice({ maxD = 45, maxW = 52, groups, sites, phys }) {
  _isRestoring = true;
  S.irGroups = groups.slice();
  S.sites = sites.map(s => ({ name: s.name, irGroup: s.irGroup, irAnchors: [], irFillins: [] }));
  S.physicians = phys.map(q => Object.assign({
    id: q.id, first: 'T', last: q.last, role: 'IR', drFte: 0, irFte: q.fte, irGroup: q.group || null, irSitePrim: q.prim || null,
    drSubs: [], irSubs: [], address: '', shiftElig: { s1: true, wknd: false }, irCallBlackouts: [], siteRules: [], tbRules: [],
    dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [],
  }, q.pools ? { irCallPools: q.pools.slice() } : {}, q.start ? { startDate: q.start } : {}));
  S.irCalls = []; S.vacations = []; S.holidays = []; S.holidayDefs = []; S.irShifts = []; S.drShifts = []; S.weekendCalls = [];
  S.natLangRules = []; S.tumorBoards = []; S.clinics = []; S.openShifts = [];
  S.irShiftSlots = {}; S.irShiftSlotLabels = {}; S.irSlots = {};
  S.nextId = 5000;
  S.cfg = Object.assign({}, S.cfg, { irDailyMaxYr: maxD, irWkndMaxYr: maxW, irDailyMax: maxD, irWkndMax: maxW, irMax: maxD });
  _isRestoring = false;
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
  if (typeof _repopulateIRGroupSelects === 'function') _repopulateIRGroupSelects();
}
// Runs in the page: preview the IR call builder for 2027 and summarise it.
async function previewCalls(period, typ, grp) {
  nav('ir-auto', document.querySelector('.snav-item[data-pg="ir-auto"]'));
  const yr = document.getElementById('ira-yr');
  if (![...yr.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; yr.appendChild(o); }
  yr.value = '2027';
  document.getElementById('ira-period').value = period || 'year'; _iraTogglePeriodInputs();
  document.getElementById('ira-type').value = typ || 'both';
  const g = document.getElementById('ira-grp');
  if (grp && ![...g.options].some(o => o.value === grp)) { const o = document.createElement('option'); o.value = grp; o.textContent = grp; g.appendChild(o); }
  g.value = grp || 'both';
  S.iraPreview = [];
  previewIRAA._deferred = true;
  try { previewIRAA(); } finally { previewIRAA._deferred = false; }
  const pv = (S.iraPreview || []).map(a => ({ physId: a.physId, date: a.date, callType: a.callType, irGroup: a.irGroup, notes: a.notes, cover: !!a._cover }));
  const own = {}; S.physicians.forEach(p => { own[p.id] = p.irGroup || ''; });
  const open = (pool, kind) => _irYearSlots(kind, 2027, pool).filter(d => !pv.some(a => a.irGroup === pool && a.callType === kind && a.date === d)
    && !S.irCalls.some(c => c.irGroup === pool && c.callType === kind && c.date === d)).length;
  const rows = {};
  S.physicians.forEach(p => {
    const mine = pv.filter(a => a.physId === p.id);
    const k = kind => {
      const m = mine.filter(a => a.callType === kind), held = S.irCalls.filter(c => c.physId === p.id && c.callType === kind && c.date.startsWith('2027') && !(c.notes || '').includes('(Holiday)'));
      return { own: m.filter(a => a.irGroup === own[p.id]).length, other: m.filter(a => a.irGroup !== own[p.id]).length,
        otherPools: [...new Set(m.filter(a => a.irGroup !== own[p.id]).map(a => a.irGroup))], total: m.length + held.length, max: _irCallMaxYear(p, kind, 2027),
        first: m.filter(a => a.irGroup !== own[p.id]).map(a => a.date).sort()[0] || null };
    };
    rows[p.last] = { id: p.id, D: k('daily'), W: k('weekend') };
  });
  const text = document.getElementById('ira-box').textContent.replace(/\s+/g, ' ');
  const gapRows = (() => { const n = [...document.querySelectorAll('#ira-box .note')].find(x => /unfilled slot/.test(x.textContent)); if (!n) return []; const mono = n.querySelector('div'); return mono ? mono.innerHTML.split('<br>') : []; })();
  // back-to-back / same day (preview + schedule, every pool): two of a physician's calls on the same or
  // adjacent days (a weekend covers Fri→Mon), or two weekends within 7 days
  let b2b = 0;
  const end = c => c.callType === 'weekend' ? addDays(c.date, 3) : c.date;
  S.physicians.forEach(p => {
    const all = [...S.irCalls.filter(c => c.physId === p.id), ...pv.filter(a => a.physId === p.id)];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], c = all[j];
      if (a.callType === 'weekend' && c.callType === 'weekend') { if (Math.abs(_daysBetween(a.date, c.date)) <= 7) b2b++; continue; }
      if (!(addDays(end(a), 1) < c.date || addDays(end(c), 1) < a.date)) b2b++;
    }
  });
  const yearSlots = Object.fromEntries(getIRGroups().map(x => [x, { daily: _irYearSlots('daily', 2027, x).length, weekend: _irYearSlots('weekend', 2027, x).length }]));
  return { pv, rows, text, gapRows, open, yearSlots, b2b,
    pools: (previewIRAA._last || {}).pools || null, openOf: Object.fromEntries(getIRGroups().map(x => [x, { daily: open(x, 'daily'), weekend: open(x, 'weekend') }])) };
}
async function applyCalls() {
  const c0 = window.confirm, a0 = window.alert; window.confirm = () => true; window.alert = () => {};
  try { applyIRAA(); } finally { window.confirm = c0; window.alert = a0; }
  await new Promise(r => setTimeout(r, 100));
}
const FN = { build: buildPractice.toString(), preview: previewCalls.toString(), apply: applyCalls.toString() };

// Practices
const SITES = [{ name: 'AlphaSite', irGroup: 'Alpha' }, { name: 'BetaSite1', irGroup: 'Beta' }, { name: 'BetaSite2', irGroup: 'Beta' }, { name: 'GammaSite', irGroup: 'Gamma' }];
const team = (group, n, fte, from, extra) => Array.from({ length: n }, (_, i) => Object.assign({ id: from + i, last: `${group}${i + 1}`, fte, group, prim: SITES.find(s => s.irGroup === group)?.name }, extra ? extra(i) : {}));

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=call-pools');
  await launchSyntheticUser(page, 'superuser');
});

test('a short pool is covered by volunteers from another pool, spread evenly by the room they have left', async ({ page }) => {
  // Alpha: 4 × 1.0 FTE, maximum 45 → 180 of 204 weekday slots. Beta: 4 × 1.0 + 4 × 0.5 FTE, all list Alpha;
  // after Beta's own fair share (≈34 / 17) the full-timers have ≈11 calls of room, the half-timers ≈6.
  const r = await page.evaluate(async ({ build, preview, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)();
    b({ maxD: 45, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    return await pv('year', 'daily');
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 4, 1, 11, () => ({ pools: ['Alpha'] })), ...team('Beta', 4, 0.5, 15, i => ({ last: `BetaHalf${i + 1}`, pools: ['Alpha'] }))] });

  // Stage 1 leaves Alpha short; stage 2 covers it from Beta.
  const cover = r.pv.filter(a => a.cover);
  expect(cover.length).toBeGreaterThan(15);
  expect(r.openOf.Alpha.daily).toBe(0);
  expect(r.openOf.Beta.daily).toBe(0);
  cover.forEach(a => { expect(a.irGroup).toBe('Alpha'); expect(a.notes).toBe('Auto (covering Alpha)'); });
  // Nobody past the maximum; no back-to-back call across the two pools.
  Object.entries(r.rows).forEach(([n, x]) => expect(x.D.total, n).toBeLessThanOrEqual(x.D.max));
  expect(r.b2b).toBe(0);
  // Even by room left: the volunteers end with (nearly) the same room left, so the full-timers — who had
  // about twice the room — took most of the cover (an FTE split would have left them with twice the room).
  const vols = Object.entries(r.rows).filter(([n]) => n.startsWith('Beta'));
  const left = vols.map(([, x]) => x.D.max - x.D.total);
  expect(Math.max(...left) - Math.min(...left)).toBeLessThanOrEqual(2);
  const full = vols.filter(([n]) => !/Half/.test(n)).reduce((s, [, x]) => s + x.D.other, 0), half = vols.filter(([n]) => /Half/.test(n)).reduce((s, [, x]) => s + x.D.other, 0);
  expect(full).toBeGreaterThan(2 * half);
  // The preview says so.
  expect(r.text).toMatch(/Alpha: \d+ open weekday calls? covered from other pools \(Beta\d \d+/);
  expect(r.pools.find(p => p.group === 'Alpha').covered.daily).toBe(cover.length);
});

test('a volunteer\'s ranking decides which pool their spare room goes to first', async ({ page }) => {
  // Alpha and Gamma are both short (4 × 1.0 at maximum 45 → 24 weekday slots each). Beta (5 × 1.0): Beta1
  // ranks Gamma first, Beta2 Alpha first; after Beta's own fair share (≈41) each has ≈4 calls of room.
  const r = await page.evaluate(async ({ build, preview, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)();
    b({ maxD: 45, groups: ['Alpha', 'Beta', 'Gamma'], sites: SITES, phys });
    return await pv('year', 'daily');
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Gamma', 4, 1, 21),
    ...team('Beta', 5, 1, 11, i => i === 0 ? { pools: ['Gamma', 'Alpha'] } : i === 1 ? { pools: ['Alpha', 'Gamma'] } : {})] });

  const b1 = r.rows.Beta1.D, b2 = r.rows.Beta2.D;
  expect(b1.other).toBeGreaterThanOrEqual(3);
  expect(b2.other).toBeGreaterThanOrEqual(3);
  expect(b1.otherPools).toEqual(['Gamma']);
  expect(b2.otherPools).toEqual(['Alpha']);
  // both used their room up to the maximum (rank only steers it), and nobody else covered anything
  expect(b1.total).toBe(b1.max);
  expect(b2.total).toBe(b2.max);
  ['Beta3', 'Beta4', 'Beta5'].forEach(n => expect(r.rows[n].D.other).toBe(0));
  expect(r.openOf.Alpha.daily).toBeGreaterThan(0);   // still short — reported, not forced
  expect(r.text).toContain('other pools: everyone who lists it is at their maximum');
});

test('a pool with no members is covered only by those who list it, and reported compactly when nobody does', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)();
    // Alpha: 5 × 1.0 at maximum 45 → each has ≈4 weekday calls of room after Alpha's own 204.
    b({ maxD: 45, maxW: 12, groups: ['Alpha', 'Delta'], sites: SITES, phys });
    const listed = await pv('year', 'both');
    S.physicians.forEach(p => { delete p.irCallPools; });
    const nobody = await pv('year', 'both');
    const deltaOnly = await pv('year', 'both', 'Delta');
    return { listed, nobody, deltaOnly };
  }, { ...FN, SITES, phys: team('Alpha', 5, 1, 1, i => i < 2 ? { pools: ['Delta'] } : {}) });

  const L = r.listed;
  const delta = L.pv.filter(a => a.irGroup === 'Delta');
  expect(delta.length).toBeGreaterThan(4);
  expect([...new Set(delta.map(a => a.physId))].sort()).toEqual([1, 2]);     // Alpha1 and Alpha2 only
  delta.forEach(a => expect(a.cover).toBe(true));
  ['Alpha1', 'Alpha2'].forEach(n => { expect(L.rows[n].D.total).toBe(L.rows[n].D.max); });
  expect(L.openOf.Alpha.daily).toBe(0);                                     // their own pool first
  expect(L.text).toMatch(/Delta: no members — \d+ weekday calls \+ \d+ weekend calls? uncovered/);
  expect(L.gapRows.some(g => /Delta/.test(g))).toBe(false);                 // no row per date for it

  // Nobody lists it: one compact line, no gap rows, not "All IR call slots already filled".
  const N = r.nobody;
  expect(N.pv.some(a => a.irGroup === 'Delta')).toBe(false);
  expect(N.text).toContain(`Delta: no members and nobody lists it — ${N.yearSlots.Delta.daily} weekday calls + ${N.yearSlots.Delta.weekend} weekend calls uncovered`);
  expect(N.gapRows.some(g => /Delta/.test(g))).toBe(false);
  expect(r.deltaOnly.text).not.toContain('All IR call slots already filled');
  expect(r.deltaOnly.text).toContain('Delta: no members and nobody lists it');
});

test('nobody is assigned past their maximum — a volunteer with a start date included', async ({ page }) => {
  // Alpha: 4 × 1.0 at maximum 31 → 80 weekday slots short. Beta: 8 members, one starting May 1
  // (maximum 31 × 245/365 = 21, 8 × 0.671 = 5); Beta has ≈44 weekday calls of spare room, all of it listed for Alpha.
  const r = await page.evaluate(async ({ build, preview, apply, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)(), ap = new Function('return ' + apply)();
    b({ maxD: 31, maxW: 8, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    const first = await pv('year', 'both');
    await ap();
    const again = await pv('year', 'both');            // a second run on top adds nothing past anyone's maximum
    return { first, again };
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 8, 1, 11, i => Object.assign({ pools: ['Alpha'] }, i === 0 ? { last: 'Starter', start: '2027-05-01' } : {}))] });

  const s = r.first.rows.Starter;
  expect(s.D.max).toBe(21);
  expect(s.W.max).toBe(5);
  expect(s.D.other).toBeGreaterThan(0);                  // the starter covers Alpha too …
  expect(s.D.first >= '2027-05-01').toBe(true);           // … never before the start date
  expect(s.D.total).toBeLessThanOrEqual(21);
  expect(s.W.total).toBeLessThanOrEqual(5);
  [r.first, r.again].forEach(run => Object.entries(run.rows).forEach(([n, x]) => {
    expect(x.D.total, `${n} weekday`).toBeLessThanOrEqual(x.D.max);
    expect(x.W.total, `${n} weekend`).toBeLessThanOrEqual(x.W.max);
  }));
  expect(r.first.b2b).toBe(0);
  expect(r.again.pv.filter(a => a.cover).length).toBe(0);  // everyone who lists Alpha is at the maximum now
  expect(r.again.text).toContain('everyone who lists it is at their maximum');
});

test('with no preferences the builder gives the same result as before; preferences only add cover', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)();
    b({ maxD: 45, maxW: 12, groups: ['Alpha', 'Beta', 'Delta'], sites: SITES, phys });
    const none = await pv('year', 'both');
    // empty lists, the primary group itself and names that are no longer pools change nothing
    S.physicians.forEach((p, i) => { p.irCallPools = i % 3 === 0 ? [] : i % 3 === 1 ? [p.irGroup] : ['Nope', p.irGroup]; });
    const noise = await pv('year', 'both');
    S.physicians.forEach(p => { p.irCallPools = p.irGroup === 'Beta' ? ['Alpha'] : []; });
    const prefs = await pv('year', 'both');
    return { none, noise, prefs };
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 8, 1, 11)] });

  const key = a => [a.physId, a.date, a.callType, a.irGroup, a.notes].join('|');
  const none = r.none.pv.map(key).sort();
  expect(none.length).toBeGreaterThan(300);
  expect(r.none.pv.some(a => a.cover)).toBe(false);
  expect(r.noise.pv.map(key).sort()).toEqual(none);
  expect(r.noise.gapRows).toEqual(r.none.gapRows);
  // stage 1 is untouched by preferences: every call of the run without them is still there, and the only
  // additions are cover calls in Alpha from Beta
  const withPrefs = r.prefs.pv;
  expect(withPrefs.filter(a => !a.cover).map(key).sort()).toEqual(none);
  const added = withPrefs.filter(a => a.cover);
  expect(added.length).toBeGreaterThan(0);
  added.forEach(a => { expect(a.irGroup).toBe('Alpha'); expect(a.physId).toBeGreaterThanOrEqual(11); });
  // the pool report: Delta has no members and nobody lists it
  expect(r.none.pools.map(p => p.group)).toEqual(['Alpha', 'Beta', 'Delta']);
  expect(r.none.pools.every(p => p.covered.daily === 0 && p.covered.weekend === 0)).toBe(true);
});

test('the procedure shift paired with a weekday call in another pool is at the volunteer\'s own primary site and own group', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, apply, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)(), ap = new Function('return ' + apply)();
    b({ maxD: 45, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    await pv('year', 'daily');
    await ap();
    const sites = {}; S.sites.forEach(s => { sites[s.name] = s.irGroup; });
    const cover = S.irCalls.filter(c => c.irGroup === 'Alpha' && c.physId >= 11);
    const paired = cover.map(c => {
      const p = S.physicians.find(x => x.id === c.physId), sh = S.irShifts.find(s => s.physId === c.physId && s.date === c.date && s.shift === '1st');
      return { who: p.last, prim: p.irSitePrim, note: c.notes, site: sh && sh.site, siteGroup: sh && sites[sh.site], irGroup: sh && sh.irGroup, shNote: sh && sh.notes };
    });
    // Manual assignment of an Alpha call to a Beta volunteer: no "is in Beta group" question, and the paired shift is theirs.
    const dates = _irYearSlots('daily', 2027, 'Alpha');
    const v = S.physicians.find(p => p.last === 'Beta2');
    const free = dates.find(d => !S.irCalls.some(c => c.date === d && c.irGroup === 'Alpha') && !S.irCalls.some(c => c.physId === v.id && Math.abs(_daysBetween(c.date, d)) <= 1))
      || dates.find(d => !S.irCalls.some(c => c.physId === v.id && Math.abs(_daysBetween(c.date, d)) <= 1));
    _isRestoring = true; S.irCalls = S.irCalls.filter(c => !(c.date === free && c.irGroup === 'Alpha')); S.irShifts = S.irShifts.filter(s => !(s.physId === v.id && s.date === free)); _isRestoring = false; _markDateIdxDirty();
    nav('ir-cal', document.querySelector('.snav-item[data-pg="ir-cal"]'));
    const set = (id, val) => { const e = document.getElementById(id); if (e.tagName === 'SELECT' && ![...e.options].some(o => o.value === String(val))) { const o = document.createElement('option'); o.value = String(val); o.textContent = String(val); e.appendChild(o); } e.value = String(val); };
    set('ird-phys', v.id); set('ird-date', free); set('ird-ctype', 'daily'); set('ird-grp', 'Alpha');
    const asked = []; const c0 = window.confirm, a0 = window.alert; window.confirm = m => { asked.push(String(m)); return true; }; window.alert = m => asked.push('ALERT ' + m);
    try { addIRCallManual(); } finally { window.confirm = c0; window.alert = a0; }
    const mc = S.irCalls.find(c => c.physId === v.id && c.date === free && c.irGroup === 'Alpha');
    const ms = S.irShifts.find(s => s.physId === v.id && s.date === free && s.shift === '1st');
    return { paired, manual: { asked, call: !!mc, site: ms && ms.site, irGroup: ms && ms.irGroup } };
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 6, 1, 11, i => ({ pools: ['Alpha'], prim: i === 0 ? null : (i % 2 ? 'BetaSite2' : 'BetaSite1') }))] });

  expect(r.paired.length).toBeGreaterThan(10);
  r.paired.forEach(x => {
    expect(x.note).toBe('Auto (covering Alpha)');
    expect(x.site, `${x.who} shift site`).toBeTruthy();
    expect(x.siteGroup).toBe('Beta');                     // never an Alpha site
    expect(x.irGroup).toBe('Beta');                       // their own group's shift (quota, Clear Period, slots)
    if (x.prim) expect(x.site).toBe(x.prim);              // their own primary site when they have one
    expect(x.shNote).toBe('Auto (with call)');
  });
  expect(r.paired.some(x => !x.prim)).toBe(true);         // Beta1 has no primary site: a Beta site still
  expect(r.manual.call).toBe(true);
  expect(r.manual.asked.filter(m => /group\. Assign to Alpha/.test(m))).toEqual([]);
  expect(r.manual.site).toBe('BetaSite2');                // Beta2's primary site
  expect(r.manual.irGroup).toBe('Beta');
});

test('physician profile: add and edit "Also takes IR call for" with its order; removing a group cleans the lists', async ({ page }) => {
  await page.evaluate(({ build, SITES }) => {
    new Function('return ' + build)()({ groups: ['Alpha', 'Beta', 'Gamma', 'Delta'], sites: SITES, phys: [{ id: 1, last: 'Keep', fte: 1, group: 'Alpha', prim: 'AlphaSite' }] });
    nav('physicians', document.querySelector('.snav-item[data-pg="physicians"]'));
  }, { ...FN, SITES });
  // Add: IR, group Beta, tick Alpha then Gamma, move Gamma up.
  await page.fill('#p-first', 'Ann'); await page.fill('#p-last', 'Pools');
  await page.selectOption('#p-role', 'IR');
  await expect(page.locator('#p-callpools-w')).toBeVisible();
  await page.fill('#p-irfte', '0.8'); await page.fill('#p-start', '2027-03-01');
  await page.selectOption('#p-irgrp', 'Beta');
  const rowsNow = () => page.$$eval('#p-callpools [data-pool]', els => els.map(e => e.dataset.pool + (e.querySelector('input').checked ? '✓' : '')));
  expect(await rowsNow()).toEqual(['Alpha', 'Gamma', 'Delta']);            // every pool except the primary
  await page.check('#p-callpools input[value="Alpha"]');
  await page.check('#p-callpools input[value="Gamma"]');
  expect(await rowsNow()).toEqual(['Alpha✓', 'Gamma✓', 'Delta']);
  await page.click('#p-callpools [data-pool="Gamma"] button[aria-label="Move Gamma up"]');
  expect(await rowsNow()).toEqual(['Gamma✓', 'Alpha✓', 'Delta']);
  await page.evaluate(() => { window.confirm = () => true; submitPhys(); });
  let p = await page.evaluate(() => JSON.parse(JSON.stringify(S.physicians.find(x => x.last === 'Pools'))));
  expect(p.irCallPools).toEqual(['Gamma', 'Alpha']);
  expect(p.irGroup).toBe('Beta'); expect(p.irFte).toBe(0.8); expect(p.startDate).toBe('2027-03-01');
  // The list shows it.
  await expect(page.locator('#phys-list')).toContainText('+ Gamma › Alpha');

  // Edit: the picker comes back in order; the primary group changes to Gamma → Gamma leaves the list.
  await page.evaluate(id => editPhys(id), p.id);
  expect(await rowsNow()).toEqual(['Gamma✓', 'Alpha✓', 'Delta']);
  await page.selectOption('#p-irgrp', 'Gamma');
  expect(await rowsNow()).toEqual(['Alpha✓', 'Beta', 'Delta']);
  await page.check('#p-callpools input[value="Delta"]');
  await page.click('#p-callpools [data-pool="Delta"] button[aria-label="Move Delta up"]');
  expect(await rowsNow()).toEqual(['Delta✓', 'Alpha✓', 'Beta']);
  await page.evaluate(() => { window.confirm = () => true; submitPhys(); });
  p = await page.evaluate(() => JSON.parse(JSON.stringify(S.physicians.find(x => x.last === 'Pools'))));
  expect(p.irGroup).toBe('Gamma');
  expect(p.irCallPools).toEqual(['Delta', 'Alpha']);
  expect(p.irFte).toBe(0.8); expect(p.startDate).toBe('2027-03-01'); expect(p.first).toBe('Ann');

  // MIXED shows the picker, DR-only hides it.
  await page.evaluate(id => editPhys(id), p.id);
  await page.selectOption('#p-role', 'MIXED'); await expect(page.locator('#p-callpools-w')).toBeVisible();
  await page.selectOption('#p-role', 'DR'); await expect(page.locator('#p-callpools-w')).toBeHidden();
  await page.evaluate(() => cancelEditPhys());

  // Removing a group takes it out of every list; a stale stored name is dropped on that profile's next save.
  const after = await page.evaluate(() => {
    window.confirm = () => true;
    const keep = S.physicians.find(x => x.last === 'Keep'); keep.irCallPools = ['Gone', 'Delta'];
    removeIRGroup('Delta');
    const a = JSON.parse(JSON.stringify(S.physicians.find(x => x.last === 'Pools').irCallPools || null));
    const k = JSON.parse(JSON.stringify(keep.irCallPools || null));
    nav('physicians', document.querySelector('.snav-item[data-pg="physicians"]'));
    editPhys(keep.id); _saveEditPhys(keep.id);
    return { groups: getIRGroups(), pools: a, keepBefore: k, keepAfter: S.physicians.find(x => x.last === 'Keep').hasOwnProperty('irCallPools') ? S.physicians.find(x => x.last === 'Keep').irCallPools : 'absent' };
  });
  expect(after.groups).toEqual(['Alpha', 'Beta', 'Gamma']);
  expect(after.pools).toEqual(['Alpha']);
  expect(after.keepBefore).toEqual(['Gone']);
  expect(after.keepAfter).toBe('absent');
});

test('a preview goes stale when someone\'s call pools change', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, apply, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)(), ap = new Function('return ' + apply)();
    b({ maxD: 45, groups: ['Alpha', 'Beta', 'Gamma'], sites: SITES, phys });
    const first = await pv('year', 'daily');
    S.physicians.find(p => p.last === 'Beta1').irCallPools = ['Gamma', 'Alpha'];     // re-ranked after the preview
    const n0 = S.irCalls.length;
    await ap();
    const refused = { applied: S.irCalls.length - n0, box: document.getElementById('ira-box').textContent };
    await pv('year', 'daily');
    const n1 = S.irCalls.length; await ap();
    return { previewRows: first.pv.length, refused, appliedAfterNewPreview: S.irCalls.length - n1 };
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Gamma', 4, 1, 21), ...team('Beta', 6, 1, 11, () => ({ pools: ['Alpha'] }))] });

  expect(r.previewRows).toBeGreaterThan(300);
  expect(r.refused.applied).toBe(0);
  expect(r.refused.box).toContain('Nothing was applied');
  expect(r.appliedAfterNewPreview).toBeGreaterThan(300);
});

test('Rebalance → IR calls fills a short pool\'s open slots from the physicians who list it, within the maximum', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, apply, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)(), ap = new Function('return ' + apply)();
    b({ maxD: 45, maxW: 52, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    // a year built before anyone listed a pool: Alpha is left short
    await pv('year', 'daily'); await ap();
    const openBefore = _irYearSlots('daily', 2027, 'Alpha').filter(d => d <= '2027-06-30' && !S.irCalls.some(c => c.irGroup === 'Alpha' && c.callType === 'daily' && c.date === d));
    S.physicians.forEach(p => { if (p.irGroup === 'Beta') p.irCallPools = ['Alpha']; });
    nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
    const ys = document.getElementById('irr-yr'); if (![...ys.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ys.appendChild(o); } ys.value = '2027';
    document.getElementById('irr-period').value = 'H1'; document.getElementById('irr-grp').value = 'both'; document.getElementById('irr-type').value = 'daily';
    _irrPlan = null; previewIRRebalance._deferred = true;
    try { previewIRRebalance(); } finally { previewIRRebalance._deferred = false; }
    const plan = _irrPlan, rows = plan ? plan.daily : [];
    const fills = rows.filter(a => a.irGroup === 'Alpha' && openBefore.includes(a.date));
    const text = document.getElementById('irr-preview').textContent.replace(/\s+/g, ' ');
    const c0 = window.confirm; window.confirm = () => true;
    try { await applyIRRebalance(); } finally { window.confirm = c0; }
    await new Promise(res => setTimeout(res, 100));
    const openAfter = _irYearSlots('daily', 2027, 'Alpha').filter(d => d <= '2027-06-30' && !S.irCalls.some(c => c.irGroup === 'Alpha' && c.callType === 'daily' && c.date === d)).length;
    const sites = {}; S.sites.forEach(s => { sites[s.name] = s.irGroup; });
    const cover = S.irCalls.filter(c => c.irGroup === 'Alpha' && c.physId >= 11 && c.date <= '2027-06-30');
    const shifts = cover.map(c => S.irShifts.find(s => s.physId === c.physId && s.date === c.date && s.shift === '1st')).map(s => s ? sites[s.site] + '/' + s.irGroup : 'none');
    const over = S.physicians.filter(p => S.irCalls.filter(c => c.physId === p.id && c.callType === 'daily' && c.date.startsWith('2027')).length > _irCallMaxYear(p, 'daily', 2027)).map(p => p.last);
    return { openBefore: openBefore.length, fills: fills.length, fillWho: [...new Set(fills.map(a => a.physId))], notes: [...new Set(cover.map(c => c.notes))], openAfter, shifts, over, text };
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 6, 1, 11)] });

  expect(r.openBefore).toBeGreaterThan(5);
  expect(r.fills).toBeGreaterThan(0);
  r.fillWho.forEach(id => expect(id).toBeGreaterThanOrEqual(11));        // only Beta physicians, who list Alpha
  expect(r.openAfter).toBe(r.openBefore - r.fills);
  expect(r.notes).toEqual(['Rebalanced (covering Alpha)']);
  r.shifts.forEach(s => expect(s).toBe('Beta/Beta'));                    // the paired shift is their own
  expect(r.over).toEqual([]);
  expect(r.text).toMatch(/Alpha: \d+ weekday calls? covered from other pools/);
});

// ── Review fixes (rs-v136 call pools, round 2) ─────────────────────────────────────────────
// Runs in the page: preview + apply the IR call builder for one period of 2027 (month/semi-month aware).
async function buildPeriod(period, mo, typ, grp) {
  nav('ir-auto', document.querySelector('.snav-item[data-pg="ir-auto"]'));
  const opt = (id, v) => { const e = document.getElementById(id); if (e.tagName === 'SELECT' && ![...e.options].some(o => o.value === String(v))) { const o = document.createElement('option'); o.value = String(v); o.textContent = String(v); e.appendChild(o); } e.value = String(v); };
  opt('ira-yr', 2027); opt('ira-period', period); _iraTogglePeriodInputs();
  const m = document.getElementById('ira-mo'); if (m) m.value = mo ? `2027-${mo}` : '';
  opt('ira-type', typ || 'both'); opt('ira-grp', grp || 'both');
  S.iraPreview = []; previewIRAA._deferred = true;
  try { previewIRAA(); } finally { previewIRAA._deferred = false; }
  const pv = (S.iraPreview || []).map(a => ({ physId: a.physId, date: a.date, callType: a.callType, irGroup: a.irGroup, cover: !!a._cover }));
  const text = document.getElementById('ira-box').textContent.replace(/\s+/g, ' ');
  const c0 = window.confirm, a0 = window.alert; window.confirm = () => true; window.alert = () => {};
  try { applyIRAA(); } finally { window.confirm = c0; window.alert = a0; }
  return { pv, text };
}
const FN2 = { ...FN, period: buildPeriod.toString() };
const openIn = (pool, kind) => `_irYearSlots('${kind}', 2027, '${pool}').filter(d => !S.irCalls.some(c => c.irGroup === '${pool}' && c.callType === '${kind}' && c.date === d)).length`;
// Alpha: 4 × 1.0 at a weekday maximum of 52 — its own 204 weekday slots leave each member ONE call of
// spare room for the year. Beta: 2 × 1.0, far short. Alpha lists Beta.
const TIGHT = () => [...team('Alpha', 4, 1, 1, () => ({ pools: ['Beta'] })), ...team('Beta', 2, 1, 11)];

test('month-by-month, half-year-then-monthly and semi-monthly builds: cover never uses room the volunteer\'s own pool needs later', async ({ page }) => {
  const r = await page.evaluate(async ({ build, period, SITES, phys, OPEN }) => {
    const b = new Function('return ' + build)(), bp = new Function('return ' + period)(), open = new Function('return ' + OPEN);
    const ms = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    const seqs = { monthly: ms.map(m => ['month', m]), h1ThenMonthly: [['H1', null], ...ms.slice(6).map(m => ['month', m])], semi: ms.flatMap(m => [['semi-1', m], ['semi-2', m]]) };
    const out = {};
    for (const [name, seq] of Object.entries(seqs)) {
      b({ maxD: 52, maxW: 52, groups: ['Alpha', 'Beta'], sites: SITES, phys });
      let cover = 0;
      for (const [per, mo] of seq) cover += (await bp(per, mo, 'daily')).pv.filter(a => a.cover).length;
      const held = S.physicians.filter(p => p.irGroup === 'Alpha').map(p => S.irCalls.filter(c => c.physId === p.id && c.callType === 'daily').length);
      out[name] = { alphaOpen: open(), cover, held };
    }
    return out;
  }, { ...FN2, SITES, phys: TIGHT(), OPEN: openIn('Alpha', 'daily') });
  for (const [name, x] of Object.entries(r)) {
    expect(x.alphaOpen, `${name}: Alpha (the volunteers' own pool) fully covered`).toBe(0);
    expect(x.cover, `${name}: the spare room still went to Beta`).toBeGreaterThan(0);
    x.held.forEach(n => expect(n).toBeLessThanOrEqual(52));
  }
});

test('building another pool on its own first keeps the volunteers\' own share free (a new member-less pool included)', async ({ page }) => {
  const r = await page.evaluate(async ({ build, period, SITES, phys, OPEN_A, OPEN_D }) => {
    const b = new Function('return ' + build)(), bp = new Function('return ' + period)();
    const openA = new Function('return ' + OPEN_A), openD = new Function('return ' + OPEN_D);
    b({ maxD: 52, maxW: 52, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    const betaFirst = await bp('year', null, 'daily', 'Beta');
    await bp('year', null, 'daily', 'Alpha');
    const e = { alphaOpen: openA(), cover: betaFirst.pv.filter(a => a.cover).length, note: betaFirst.text };
    // The admin adds a new pool with no members and builds it alone; Alpha lists it.
    b({ maxD: 52, maxW: 52, groups: ['Alpha', 'Beta', 'Delta'], sites: SITES, phys });
    S.physicians.forEach(p => { if (p.irGroup === 'Alpha') p.irCallPools = ['Delta']; });
    const deltaFirst = await bp('year', null, 'daily', 'Delta');
    await bp('year', null, 'daily', 'Alpha');
    const g = { alphaOpen: openA(), deltaCovered: 204 - openD(), perVol: S.physicians.filter(p => p.irGroup === 'Alpha').map(p => deltaFirst.pv.filter(a => a.physId === p.id).length) };
    return { e, g };
  }, { ...FN2, SITES, phys: TIGHT(), OPEN_A: openIn('Alpha', 'daily'), OPEN_D: openIn('Delta', 'daily') });
  expect(r.e.alphaOpen).toBe(0);
  expect(r.e.cover).toBeGreaterThan(0);
  expect(r.e.cover).toBeLessThanOrEqual(4);                       // one spare call each, no more
  expect(r.e.note).toContain('Alpha is not part of this run');
  expect(r.g.alphaOpen).toBe(0);
  expect(r.g.deltaCovered).toBeGreaterThan(0);
  r.g.perVol.forEach(n => expect(n).toBeLessThanOrEqual(1));
});

test('a volunteer is not given cover on their own group\'s holiday weekend until that holiday call is someone else\'s', async ({ page }) => {
  const r = await page.evaluate(async ({ build, period, SITES, phys }) => {
    const b = new Function('return ' + build)(), bp = new Function('return ' + period)();
    const setup = () => {
      b({ maxD: 52, maxW: 52, groups: ['Alpha', 'Delta'], sites: SITES, phys });
      _isRestoring = true;   // New Year's Day 2027 (a Friday): IR holiday call for Alpha only — for Delta it is a regular weekend
      S.holidayDefs = [{ id: 7001, name: "New Year's Day", year: 2027, dates: ['2027-01-01'], drSlots: 0, irSlotsByGroup: { Alpha: 1 } }];
      _isRestoring = false;
    };
    setup();
    const first = (await bp('year', null, 'weekend')).pv.filter(a => a.irGroup === 'Delta' && a.date === '2027-01-01');
    const blocked = _irCallHardBlock(S.physicians[0], '2027-01-01', 'weekend', 'Delta');      // Rebalance → IR calls, stage 2
    setup();
    _isRestoring = true; S.irCalls.push({ id: 7100, physId: 1, date: '2027-01-01', callType: 'weekend', irGroup: 'Alpha', site: 'AlphaSite', notes: "New Year's Day (Holiday)" }); _isRestoring = false;
    const second = (await bp('year', null, 'weekend')).pv.filter(a => a.irGroup === 'Delta' && a.date === '2027-01-01');
    return { first, blocked, second };
  }, { ...FN2, SITES, phys: team('Alpha', 4, 1, 1, () => ({ pools: ['Delta'] })) });
  expect(r.first).toEqual([]);
  expect(r.blocked).toMatch(/Alpha holiday weekend/);
  expect(r.second.length).toBe(1);                                  // assigned to Alpha1: the others are free that weekend
  expect(r.second[0].physId).not.toBe(1);
});

test('calls with a blank or removed group count as the holder\'s own, as before call pools', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)();
    const out = {};
    for (const g of ['', 'East', undefined]) {
      b({ maxD: 45, maxW: 12, groups: ['Alpha', 'Beta'], sites: SITES, phys });
      _isRestoring = true;
      ['2027-02-09', '2027-03-16', '2027-04-13'].forEach((d, i) => { const c = { id: 8000 + i, physId: 1, date: d, callType: 'daily', site: '', notes: 'Legacy' }; if (g !== undefined) c.irGroup = g; S.irCalls.push(c); });
      _isRestoring = false;
      const x = await pv('H1', 'daily');
      const L = previewIRAA._last.lim[1].D;
      out[String(g)] = { xP: L.xP || 0, xB: L.xB || 0, cover: S.irCalls.filter(c => c.id >= 8000).some(c => _irIsCoverCall(c)), picks: x.pv.map(a => [a.physId, a.date].join('|')).sort().join(',') };
    }
    return out;
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 4, 1, 11)] });
  Object.values(r).forEach(x => { expect(x.xP).toBe(0); expect(x.xB).toBe(0); expect(x.cover).toBe(false); });
  expect(r.East.picks).toBe(r[''].picks);
  expect(r.undefined.picks).toBe(r[''].picks);
});

test('after a primary-group change one Rebalance → IR calls reaches what a second one would', async ({ page }) => {
  const r = await page.evaluate(async ({ build, SITES, phys }) => {
    const b = new Function('return ' + build)();
    b({ maxD: 100, maxW: 52, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    // H1 by hand: Alpha cycles Alpha2..Alpha5; Beta cycles Beta1..Beta3. Five Tuesdays every Beta member is away —
    // Beta leaves them open — and Alpha1 holds the Alpha call the Monday before each.
    const H1 = d => d <= '2027-06-30', away = ['2027-02-02', '2027-03-02', '2027-03-30', '2027-04-27', '2027-05-25'];
    const da = _irYearSlots('daily', 2027, 'Alpha').filter(H1), db = _irYearSlots('daily', 2027, 'Beta').filter(H1);
    let id = 9000; _isRestoring = true;
    da.forEach((d, i) => S.irCalls.push({ id: id++, physId: away.includes(addDays(d, 1)) ? 1 : 2 + (i % 4), date: d, callType: 'daily', irGroup: 'Alpha', site: '', notes: 'Auto' }));
    db.forEach((d, i) => { if (!away.includes(d)) S.irCalls.push({ id: id++, physId: 11 + (i % 3), date: d, callType: 'daily', irGroup: 'Beta', site: '', notes: 'Auto' }); });
    [11, 12, 13].forEach(pid => away.forEach(d => S.vacations.push({ id: id++, physId: pid, start: d, end: d, type: 'Vacation' })));
    const a1 = S.physicians.find(p => p.id === 1); a1.irGroup = 'Beta'; a1.irSitePrim = 'BetaSite1';    // moves to Beta
    _isRestoring = false; _markDateIdxDirty();
    const rebal = async () => {
      nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
      const ys = document.getElementById('irr-yr'); if (![...ys.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ys.appendChild(o); } ys.value = '2027';
      document.getElementById('irr-period').value = 'H1'; document.getElementById('irr-grp').value = 'both'; document.getElementById('irr-type').value = 'daily';
      _irrPlan = null; previewIRRebalance._deferred = true;
      try { previewIRRebalance(); } finally { previewIRRebalance._deferred = false; }
      const swaps = (_irrPlan.daily || []).filter(a => a.isSwap).length;
      const c0 = window.confirm; window.confirm = () => true;
      try { await applyIRRebalance(); } finally { window.confirm = c0; }
      return swaps;
    };
    const first = await rebal();
    const betaOpen = away.filter(d => !S.irCalls.some(c => c.irGroup === 'Beta' && c.callType === 'daily' && c.date === d)).length;
    const mine = S.irCalls.filter(c => c.physId === 1 && c.callType === 'daily').map(c => c.date).sort();
    const b2b = mine.some((d, i) => i && _daysBetween(mine[i - 1], d) <= 1);
    const second = await rebal();
    return { first, betaOpen, b2b, second };
  }, { ...FN, SITES, phys: [...team('Alpha', 5, 1, 1), ...team('Beta', 3, 1, 11)] });
  expect(r.first).toBeGreaterThan(0);
  expect(r.betaOpen).toBe(0);           // Alpha hands Alpha1's Monday calls back, so Alpha1 takes the Tuesdays
  expect(r.b2b).toBe(false);
  expect(r.second).toBe(0);             // nothing left for a second run
});

test('renaming a pool (add, then remove with Reassign) keeps everyone\'s preference for it at the same rank', async ({ page }) => {
  const r = await page.evaluate(async ({ build, SITES, phys }) => {
    new Function('return ' + build)()({ groups: ['Alpha', 'Beta', 'Gamma'], sites: SITES, phys });
    nav('ir-slots', document.querySelector('.snav-item[data-pg="ir-slots"]'));
    _isRestoring = true; S.irGroups.push('Bravo'); _isRestoring = false;
    removeIRGroup('Beta');
    const modal = document.getElementById('ir-group-remove-body').textContent.replace(/\s+/g, ' ');
    document.getElementById('irg-remove-target').value = 'Bravo';
    const rc = window._rsConfirm; window._rsConfirm = async () => true;
    try { await _confirmRemoveIRGroup('Beta'); } finally { window._rsConfirm = rc; }
    const L = n => (S.physicians.find(p => p.last === n) || {}).irCallPools || null;
    return { modal, groups: getIRGroups(), a1: L('Alpha1'), a2: L('Alpha2'), g1: L('Gamma1'), b1: { g: S.physicians.find(p => p.last === 'Beta1').irGroup, pools: L('Beta1') } };
  }, { ...FN, SITES, phys: [...team('Alpha', 2, 1, 1, i => ({ pools: i ? ['Gamma', 'Beta'] : ['Beta', 'Gamma'] })), ...team('Beta', 1, 1, 11, () => ({ pools: ['Alpha'] })), ...team('Gamma', 1, 1, 21, () => ({ pools: ['Beta', 'Bravo'] }))] });
  expect(r.groups).toEqual(['Alpha', 'Gamma', 'Bravo']);
  expect(r.a1).toEqual(['Bravo', 'Gamma']);
  expect(r.a2).toEqual(['Gamma', 'Bravo']);
  expect(r.g1).toEqual(['Bravo']);                 // already listed: once, at the higher rank
  expect(r.b1).toEqual({ g: 'Bravo', pools: ['Alpha'] });
  expect(r.modal).toContain('Reassign puts the new group in its place');
});

test('a configuration import that drops a pool takes it out of the lists, so a later pool of that name starts empty', async ({ page }) => {
  const r = await page.evaluate(async ({ build, SITES, phys }) => {
    new Function('return ' + build)()({ groups: ['Alpha', 'Beta', 'Delta'], sites: SITES, phys });
    const rc = window._rsConfirm; window._rsConfirm = async () => true;
    const imp = async groups => importPracticeConfig({ files: [new File([JSON.stringify({ irGroups: groups, sites: S.sites })], 'cfg.json', { type: 'application/json' })] });
    try {
      await imp(['Alpha', 'Beta']);
      const after = JSON.parse(JSON.stringify(S.physicians.find(p => p.last === 'Alpha1').irCallPools || null));
      const audit = (S.auditLog || []).filter(a => /config\.import/.test(a.action || a.type || '')).slice(-1)[0] || null;
      await imp(['Alpha', 'Beta', 'Delta']);
      return { after, again: _physCallPools(S.physicians.find(p => p.last === 'Alpha1')), audit: JSON.stringify(audit || '') };
    } finally { window._rsConfirm = rc; }
  }, { ...FN, SITES, phys: [...team('Alpha', 1, 1, 1, () => ({ pools: ['Beta', 'Delta'] })), ...team('Beta', 1, 1, 11)] });
  expect(r.after).toEqual(['Beta']);
  expect(r.again).toEqual(['Beta']);
});

test('physician form: picking another IR group and back keeps every tick and rank; the next added physician starts clean; keyboard focus stays', async ({ page }) => {
  await page.evaluate(({ build, SITES }) => {
    new Function('return ' + build)()({ groups: ['North', 'South', 'Riverview', 'A very long pool name for the phone layout'], sites: SITES, phys: [{ id: 1, last: 'Yedlicka', fte: 1, group: 'North', prim: 'AlphaSite', pools: ['Riverview', 'South'] }] });
    nav('physicians', document.querySelector('.snav-item[data-pg="physicians"]'));
    editPhys(1);
  }, { ...FN, SITES });
  const rowsNow = () => page.$$eval('#p-callpools [data-pool]', els => els.map(e => e.dataset.pool + (e.querySelector('input').checked ? '✓' : '')));
  expect(await rowsNow()).toEqual(['Riverview✓', 'South✓', 'North', 'A very long pool name for the phone layout'].filter(x => x !== 'North'));
  await page.selectOption('#p-irgrp', 'South');
  expect(await rowsNow()).toEqual(['Riverview✓', 'North', 'A very long pool name for the phone layout']);
  await page.selectOption('#p-irgrp', 'North');
  expect(await rowsNow()).toEqual(['Riverview✓', 'South✓', 'A very long pool name for the phone layout']);
  // keyboard: the moved row keeps focus, a tick keeps focus
  await page.click('#p-callpools [data-pool="South"] button[aria-label="Move South up"]');
  expect(await rowsNow()).toEqual(['South✓', 'Riverview✓', 'A very long pool name for the phone layout']);
  expect(await page.evaluate(() => { const a = document.activeElement; return a && a.closest('[data-pool]') ? a.closest('[data-pool]').dataset.pool + ':' + a.tagName : a && a.tagName; })).toBe('South:BUTTON');
  await page.check('#p-callpools input[value="A very long pool name for the phone layout"]');
  expect(await page.evaluate(() => document.activeElement && document.activeElement.value)).toBe('A very long pool name for the phone layout');
  await page.evaluate(() => { window.confirm = () => true; submitPhys(); });
  expect(await page.evaluate(() => S.physicians.find(p => p.id === 1).irCallPools)).toEqual(['South', 'Riverview', 'A very long pool name for the phone layout']);
  // phone width: the rank and the arrows stay on the name's line
  await page.setViewportSize({ width: 375, height: 800 });
  await page.evaluate(() => editPhys(1));
  // every child of a row sits on one line: their vertical extents overlap
  const lines = await page.$$eval('#p-callpools [data-pool]', els => els.map(e => { const r = [...e.children].map(c => c.getBoundingClientRect()); return Math.min(...r.map(x => x.bottom)) - Math.max(...r.map(x => x.top)); }));
  lines.forEach(d => expect(d).toBeGreaterThan(0));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => cancelEditPhys());
  // add a physician with two pools ticked, then another: the second starts with none
  await page.fill('#p-first', 'Ann'); await page.fill('#p-last', 'Pools'); await page.selectOption('#p-role', 'IR'); await page.fill('#p-irfte', '1');
  await page.selectOption('#p-irgrp', 'North');
  await page.check('#p-callpools input[value="South"]'); await page.check('#p-callpools input[value="Riverview"]');
  await page.evaluate(() => { window.confirm = () => true; submitPhys(); });
  expect(await rowsNow()).toEqual(['South', 'Riverview', 'A very long pool name for the phone layout']);
  await page.fill('#p-first', 'Bob'); await page.fill('#p-last', 'Chain');
  await page.evaluate(() => { window.confirm = () => true; submitPhys(); });
  const chain = await page.evaluate(() => S.physicians.find(p => p.last === 'Chain'));
  expect(chain.irCallPools).toBeUndefined();
});

test('physician import: the IR Call Pools column is documented, previewed and matched without regard to case', async ({ page }) => {
  const r = await page.evaluate(async ({ build, SITES }) => {
    new Function('return ' + build)()({ groups: ['North', 'South', 'Riverview'], sites: SITES, phys: [{ id: 1, last: 'Keep', fte: 1, group: 'North', prim: 'AlphaSite' }] });
    nav('import', document.querySelector('.snav-item[data-pg="import"]'));
    const help = [...document.querySelectorAll('.card')].find(c => /Import physicians \(bulk\)/.test(c.textContent));
    const csv = 'Last,First,Role,IR FTE,IR Group,IR Call Pools\nNew,Doc,IR,1,North,south; RIVERVIEW\nKeep,T,IR,1,North,none\n';
    previewPhysImport({ files: [new File([csv], 'p.csv', { type: 'text/csv' })] });
    for (let i = 0; i < 50 && !/rows parsed/.test(document.getElementById('xl-phys-preview').textContent); i++) await new Promise(res => setTimeout(res, 50));
    const table = document.getElementById('xl-phys-preview').textContent.replace(/\s+/g, ' ');
    await applyPhysImport();
    return { help: help ? help.textContent.replace(/\s+/g, ' ') : '', table, nw: (S.physicians.find(p => p.last === 'New') || {}).irCallPools, keep: S.physicians.find(p => p.last === 'Keep').hasOwnProperty('irCallPools') };
  }, { ...FN, SITES });
  expect(r.table).not.toContain('is not an IR group');
  expect(r.nw).toEqual(['South', 'Riverview']);
  expect(r.keep).toBe(false);
  expect(r.table).toContain('IR Call Pools');
  expect(r.table).toContain('South › Riverview');
  expect(r.help).toContain('IR Call Pools');
});

test('previews do not queue a save, an undo step or physician fields, and group names are never run as markup', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)();
    const bad = 'Ev<img src=x onerror="window.__xss=(window.__xss||0)+1">il';
    b({ maxD: 45, maxW: 12, groups: ['Alpha', bad], sites: SITES, phys: phys.map(p => p.group === 'Bad' ? Object.assign({}, p, { group: bad }) : p) });
    await new Promise(res => setTimeout(res, 50));
    const x = await pv('year', 'both');                      // sets the controls (the helper itself resets S.iraPreview)
    await new Promise(res => setTimeout(res, 50));
    const d0 = _dirtySeq, u0 = (typeof _undoStack !== 'undefined' && _undoStack) ? _undoStack.length : -1, ph0 = JSON.stringify(S.physicians);
    previewIRAA._deferred = true; try { previewIRAA(); } finally { previewIRAA._deferred = false; }
    const irDirty = _dirtySeq - d0, irUndo = ((typeof _undoStack !== 'undefined' && _undoStack) ? _undoStack.length : -1) - u0;
    // the group selects, the sites list and the IR call preview table show the name as text
    if (typeof _repopulateIRGroupSelects === 'function') _repopulateIRGroupSelects();
    if (typeof renderSitesList === 'function') renderSitesList();
    nav('ir-auto', document.querySelector('.snav-item[data-pg="ir-auto"]'));
    previewIRAA._deferred = true; try { previewIRAA(); } finally { previewIRAA._deferred = false; }
    await new Promise(res => setTimeout(res, 300));
    const xss = window.__xss || 0, shown = document.getElementById('ira-box').textContent.includes('Ev<img');
    // IR shift Auto-Assign (greedy) preview
    S.cfg.useSolver = 'greedy';
    nav('ir-shift-auto', document.querySelector('.snav-item[data-pg="ir-shift-auto"]'));
    const ys = document.getElementById('irsa-yr'); if (![...ys.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ys.appendChild(o); } ys.value = '2027';
    document.getElementById('irsa-period').value = 'H1'; if (typeof _irsaTogglePeriodInputs === 'function') _irsaTogglePeriodInputs();
    previewIRShiftAA._deferred = true; try { previewIRShiftAA(); } finally { previewIRShiftAA._deferred = false; }
    const phSame = JSON.stringify(S.physicians) === ph0;
    return { irDirty, irUndo, phSame, xss, shown, picks: x.pv.length };
  }, { ...FN, SITES, phys: [...team('Alpha', 3, 1, 1), ...team('Bad', 2, 1, 11)] });
  expect(r.picks).toBeGreaterThan(100);
  expect(r.irDirty).toBe(0);
  expect(r.irUndo).toBeLessThanOrEqual(0);
  expect(r.phSame).toBe(true);
  expect(r.xss).toBe(0);
  expect(r.shown).toBe(true);
});

test('Rebalance → IR calls never creates a procedure shift at no site (a volunteer with no IR group and no primary site)', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, apply, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)(), ap = new Function('return ' + apply)();
    b({ maxD: 45, maxW: 12, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    await pv('year', 'daily'); await ap();
    const jo = S.physicians.find(p => p.last === 'Jo'), covered = S.irCalls.filter(c => c.physId === jo.id).length;
    nav('ir-rebalance', document.querySelector('.snav-item[data-pg="ir-rebalance"]')); renderIRRebalancePrep();
    const ys = document.getElementById('irr-yr'); if (![...ys.options].some(o => o.value === '2027')) { const o = document.createElement('option'); o.value = '2027'; o.textContent = '2027'; ys.appendChild(o); } ys.value = '2027';
    document.getElementById('irr-period').value = 'H1'; document.getElementById('irr-grp').value = 'both'; document.getElementById('irr-type').value = 'daily';
    _irrPlan = null; previewIRRebalance._deferred = true;
    try { previewIRRebalance(); } finally { previewIRRebalance._deferred = false; }
    const c0 = window.confirm; window.confirm = () => true;
    try { await applyIRRebalance(); } finally { window.confirm = c0; }
    return { covered, noSite: S.irShifts.filter(s => !s.site).length, joShifts: S.irShifts.filter(s => s.physId === jo.id).length, done: document.getElementById('irr-preview').textContent.replace(/\s+/g, ' ') };
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 6, 1, 11), { id: 31, last: 'Jo', fte: 1, group: null, prim: null, pools: ['Alpha'] }] });
  expect(r.covered).toBeGreaterThan(0);
  expect(r.noSite).toBe(0);
  expect(r.joShifts).toBe(0);
});

test('a cover call edited to a member of its pool, or moved to the holder\'s own group, loses its "covering" note', async ({ page }) => {
  const r = await page.evaluate(async ({ build, preview, apply, SITES, phys }) => {
    const b = new Function('return ' + build)(), pv = new Function('return ' + preview)(), ap = new Function('return ' + apply)();
    b({ maxD: 45, groups: ['Alpha', 'Beta'], sites: SITES, phys });
    await pv('year', 'daily'); await ap();
    const covers = S.irCalls.filter(c => /covering Alpha/.test(c.notes || ''));
    const edit = (ic, pid) => {
      const ym = ic.date.slice(0, 7), mo = document.getElementById('irl-mo'); if (mo) { if (mo.tagName === 'SELECT' && ![...mo.options].some(o => o.value === ym)) { const o = document.createElement('option'); o.value = ym; mo.appendChild(o); } mo.value = ym; }
      _editingIRCallId = ic.id; renderIRList();
      document.getElementById(`irle-phys-${ic.id}`).value = String(pid);
      const c0 = window.confirm; window.confirm = () => true;
      try { saveEditIRCall(ic.id); } finally { window.confirm = c0; }
      const c = S.irCalls.find(x => x.id === ic.id); return { g: c.irGroup, notes: c.notes, cover: _irIsCoverCall(c) };
    };
    const toMember = edit(covers[0], 1);                       // an Alpha member: stays in Alpha, not cover
    const toOwn = edit(covers[1], S.physicians.find(p => p.last === 'Beta6').id);   // Beta6 does not list Alpha: moves to Beta
    return { n: covers.length, toMember, toOwn };
  }, { ...FN, SITES, phys: [...team('Alpha', 4, 1, 1), ...team('Beta', 6, 1, 11, i => i < 5 ? { pools: ['Alpha'] } : {})] });
  expect(r.n).toBeGreaterThan(1);
  expect(r.toMember).toEqual({ g: 'Alpha', notes: 'Auto', cover: false });
  expect(r.toOwn.g).toBe('Beta');
  expect(r.toOwn.notes).not.toContain('covering');
});
