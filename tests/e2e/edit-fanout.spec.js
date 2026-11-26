// Edit fan-out (rs-v137).
//
// Every edit ends in _afterMutation(). It used to redraw eleven views each time,
// hidden pages included, and the visible page twice. Now:
//   1. an edit (and another session's save) draws only what is on screen;
//   2. a view that is not on screen is drawn when its page — or its tab inside
//      the page — is next opened, so it is never SHOWN stale;
//   3. a render function runs at most once per edit;
//   4. printing, which shows every page, first draws the views that were skipped;
//   5. an IR call being edited in its row (All Entries) keeps what the user has
//      picked or typed when the list is redrawn by another session's save, by
//      opening the page again, or for printing — the tick saves what the row shows.
//
// The eleven views: DR calendar, DR builder table, DR weekend table, IR calendar,
// IR shift table, IR call list (a tab of the IR call builder), vacation table,
// holiday assignments and holiday counter (tabs of Holiday Call), dashboard,
// My Schedule.
//
// Synthetic practice only, built in the page by buildPractice(). "Old…" physicians
// hold one record of every kind from the start; an edit adds (or removes) one
// record of every kind for "Newdoc" (DR, the signed-in user) and "Newir" (IR).
const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

const YM = '2027-03';                       // 2027-03-01 is a Monday

// view → where it lives, the tab that shows it, the element that holds it, and what an edit puts in it
const VIEWS = [
  { fn: 'renderDRCal',        page: 'dr-cal',      sel: '#drc-body',       token: 'Newdoc' },
  { fn: 'renderDRBuilder',    page: 'dr-builder',  sel: '#drb-tbody',      token: 'Newdoc' },
  { fn: 'renderWkBuilder',    page: 'dr-weekends', sel: '#wk-tbody',       token: 'Newdoc' },
  { fn: 'renderIRCal',        page: 'ir-cal',      sel: '#irc-body',       token: 'Newir' },
  { fn: 'renderIRShiftTable', page: 'ir-shifts',   sel: '#irs-tbody',      token: 'Newir' },
  { fn: 'renderIRList',       page: 'ir-builder',  sel: '#irl-tbody',      token: 'Newir',  tab: "irBuilderTab('list'" },
  { fn: 'renderVacations',    page: 'vacations',   sel: '#vac-tbody',      token: 'Newdoc' },
  { fn: 'renderHolTable',     page: 'holidays',    sel: '#hol-tbody',      token: 'Zenith', tab: "holTab('assignments'" },
  { fn: 'renderHolCounter',   page: 'holidays',    sel: '#hol-counter',    token: 'Zenith', tab: "holTab('counter'" },   // the counter lists every physician; "Zenith×1" only with the assignment
  { fn: 'renderDash',         page: 'dashboard',   sel: '#dash-dr-recent', token: 'Newdoc' },
  { fn: 'renderMySched',      page: 'my-schedule', sel: '#my-content',     token: 'Zeta' },
];
const ELEVEN = VIEWS.map(v => v.fn);

// ── Runs in the page ─────────────────────────────────────────────────────────
function buildPractice(ym) {
  _isRestoring = true;                               // build state without queueing saves
  const mk = (id, last, role, extra) => Object.assign({
    id, first: 'T', last, degree: 'MD', role, drFte: role === 'IR' ? 0 : 1, irFte: role === 'IR' ? 1 : 0, drFteDay: null, drSubs: [], irSubs: [],
    address: '', shiftElig: { s1: true, s2: false, s3: false, home: true, wknd: true, wkndSwingOnly: false },
    allowedSites: [], siteRules: [], irCallBlackouts: [], dayConditions: [], tbRules: [], callDayRules: [], siteSeqRules: [],
  }, extra || {});
  S.irGroups = ['North', 'South'];
  S.sites = [{ name: 'Alpha Hospital', irGroup: '', irAnchors: [], irFillins: [] }, { name: 'Zeta Hospital', irGroup: '', irAnchors: [], irFillins: [] },
    { name: 'North IR Center', irGroup: 'North', irAnchors: [], irFillins: [] }, { name: 'South IR Center', irGroup: 'South', irAnchors: [], irFillins: [] }];
  S.physicians = [mk(2001, 'Olddoc', 'DR'), mk(2002, 'Newdoc', 'DR'), mk(2003, 'Oldir', 'IR', { irGroup: 'North', irSitePrim: 'North IR Center' }),
    mk(2004, 'Newir', 'IR', { irGroup: 'North', irSitePrim: 'North IR Center' }), mk(2005, 'Sparedoc', 'DR'),
    mk(2006, 'Spareir', 'IR', { irGroup: 'North', irSitePrim: 'North IR Center' })];
  S.drShifts = [{ id: 6001, physId: 2001, date: ym + '-10', shift: '1st', site: 'Alpha Hospital', sub: '', notes: '' }];
  S.weekendCalls = [{ id: 6002, physId: 2001, satDate: ym + '-13', sunDate: ym + '-14', sub: '', site: 'Alpha Hospital', ctype: 'weekend', wshift: 'day', notes: '' }];
  S.irCalls = [{ id: 6003, physId: 2003, date: ym + '-09', callType: 'daily', irGroup: 'North', site: '', notes: '' }];
  S.irShifts = [{ id: 6004, physId: 2003, date: ym + '-09', shift: '1st', site: 'North IR Center', sub: '', notes: '', irGroup: 'North' },
    { id: 6007, physId: 2006, date: ym + '-23', shift: '1st', site: 'North IR Center', sub: '', notes: '', irGroup: 'North' }];   // a procedure shift with no call yet
  S.vacations = [{ id: 6005, physId: 2001, type: 'Vacation', start: ym + '-22', end: ym + '-23', notes: '' }];
  // spare vacations far from the test month: one real delete (deleteVacation) per step that needs "an edit"
  for (let i = 0; i < 40; i++) S.vacations.push({ id: 7000 + i, physId: 2005, type: 'CME', start: '2028-06-0' + (1 + i % 9), end: '2028-06-0' + (1 + i % 9), notes: 'spare ' + i });
  S.holidayDefs = [{ id: 6100, name: 'Founders Day', year: 2027, dates: [ym + '-17'], drSlots: 1, irSlotsByGroup: {} },
    { id: 6101, name: 'Zenith Day', year: 2027, dates: [ym + '-18'], drSlots: 1, irSlotsByGroup: {} }];
  S.holidays = [{ id: 6006, name: 'Founders Day', date: ym + '-17', year: 2027, physId: 2001, group: 'DR', sub: '', wshift: '', notes: '' }];
  S.openShifts = []; S.natLangRules = []; S.tumorBoards = []; S.clinics = []; S.drSubs = [];
  S.nextId = 8000;
  _isRestoring = false;
  CU.physId = 2002;                                  // My Schedule shows Newdoc's own shifts
  if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
  if (typeof _repopulateIRGroupSelects === 'function') _repopulateIRGroupSelects();
  document.querySelectorAll('input[type="month"]').forEach(i => { i.value = ym; });     // every page looks at the test month
  _dashYm = ym;
  window.confirm = () => true; window.alert = () => {};
  // count every render function, and record every DOM write by the page it lands on
  window.__calls = {};
  Object.getOwnPropertyNames(window).filter(n => /^_?render[A-Z]/.test(n) && typeof window[n] === 'function').forEach(n => {
    const real = window[n];
    // a call with arguments is a helper drawing one part (renderSubChk(...) twice per physician form); it is counted apart
    window[n] = function () { const k = arguments.length ? n + '(…)' : n; window.__calls[k] = (window.__calls[k] || 0) + 1; return real.apply(this, arguments); };
  });
  window.__go = (pg, tab) => {
    nav(pg, document.querySelector('.snav-item[data-pg="' + pg + '"]'));
    if (tab) document.querySelector('#page-' + pg + ' .tab[onclick^="' + tab + '"]').click();
  };
  window.__newRecords = ym => ({
    drShifts: [{ id: 6501, physId: 2002, date: ym + '-11', shift: '1st', site: 'Zeta Hospital', sub: '', notes: '' }],
    weekendCalls: [{ id: 6502, physId: 2002, satDate: ym + '-06', sunDate: ym + '-07', sub: '', site: 'Zeta Hospital', ctype: 'weekend', wshift: 'day', notes: '' }],
    irCalls: [{ id: 6503, physId: 2004, date: ym + '-10', callType: 'daily', irGroup: 'North', site: '', notes: '' }],
    irShifts: [{ id: 6504, physId: 2004, date: ym + '-10', shift: '1st', site: 'North IR Center', sub: '', notes: '', irGroup: 'North' }],
    vacations: [{ id: 6505, physId: 2002, type: 'Vacation', start: ym + '-24', end: ym + '-25', notes: '' }],
    holidays: [{ id: 6506, name: 'Zenith Day', date: ym + '-18', year: 2027, physId: 2002, group: 'DR', sub: '', wshift: '', notes: '' }],
  });
  // run fn as one edit and report what it drew: calls per render function, DOM writes per page, nodes written
  window.__measure = fn => {
    window.__calls = {};
    const mo = new MutationObserver(() => {});
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    fn();
    const recs = mo.takeRecords(); mo.disconnect();
    const writes = {}; let nodes = 0;
    recs.forEach(r => {
      const e = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!e || !e.isConnected) return;
      const pg = e.closest('.page');
      const k = pg ? pg.id.replace('page-', '') : '(outside pages)';
      writes[k] = (writes[k] || 0) + 1;
      r.addedNodes.forEach(n => { nodes += 1 + (n.querySelectorAll ? n.querySelectorAll('*').length : 0); });
    });
    return { calls: Object.assign({}, window.__calls), writes, nodes, open: document.querySelector('.page.on').id.replace('page-', '') };
  };
  // the edit: one record of every kind for Newdoc / Newir, added or removed, then what every handler does
  window.__editAll = (ym, on) => window.__measure(() => {
    const add = window.__newRecords(ym);
    Object.keys(add).forEach(k => { if (on) S[k].push(add[k][0]); else S[k] = S[k].filter(x => x.id !== add[k][0].id); });
    triggerSave();
    _afterMutation();
  });
  // what the view shows, without the choices inside its dropdowns (every physician is listed in those)
  window.__text = sel => { const c = document.querySelector(sel).cloneNode(true); c.querySelectorAll('select, datalist').forEach(x => x.remove()); return c.textContent; };
}

// Runs in the page: another session's save arrives (what the realtime, poll and other-tab handlers do).
// `patch` = that session also changed fields of one IR call ({ id, …fields }), removed it ({ id, gone: true })
// or changed fields of one physician ({ physician: { id, …fields } }).
function remoteSave([ym, on, patch]) {
  const d = {};
  _PERSISTED_KEYS.forEach(k => { if (S[k.key] !== undefined) d[k.key] = JSON.parse(JSON.stringify(S[k.key])); });
  const add = window.__newRecords(ym);
  Object.keys(add).forEach(k => { if (on) d[k].push(add[k][0]); else d[k] = d[k].filter(x => x.id !== add[k][0].id); });
  if (patch && patch.physician) Object.assign(d.physicians.find(p => p.id === patch.physician.id), patch.physician);
  else if (patch && patch.gone) d.irCalls = d.irCalls.filter(c => c.id !== patch.id);
  else if (patch) Object.assign(d.irCalls.find(c => c.id === patch.id), patch);
  S._lastLocalChange = 0; S._lastSaved = new Date(); d.savedAt = new Date(Date.now() + 60000).toISOString();
  // These specs are about what is drawn, so the save always lands, as it did before rs-v140 with
  // the clock guard stood down above. Since PR #22 an unsent local change (here: the synthetic
  // boot's audit entry, or this spec's own edits, whose saves meet these simulated revisions as
  // a conflict) holds a revision back instead; replaceDraft says this one is taken anyway.
  return window.__measure(() => { if (!_applyRemoteData(d, true)) throw new Error('remote save not applied'); _refreshCurrentPage(); });
}

const go = (page, pg, tab) => page.evaluate(([pg, tab]) => window.__go(pg, tab), [pg, tab || null]);
const text = (page, sel) => page.evaluate(sel => window.__text(sel), sel);
const editAll = (page, on) => page.evaluate(([ym, on]) => window.__editAll(ym, on), [YM, on]);
// every page once, each view drawn with the starting data; the IR call list and the holiday counter are left as the open tab
async function openEveryView(page) {
  for (const v of VIEWS) await go(page, v.page, v.tab);
  for (const v of VIEWS) expect(await text(page, v.sel), v.fn + ' starts without the new records').not.toContain(v.token);
}
// nothing was drawn outside the open page, and no render function ran twice
function expectOnlyOpenPageDrawn(r, what) {
  expect(Object.keys(r.writes).filter(k => k !== r.open && k !== '(outside pages)'), what + ': pages drawn that are not on screen').toEqual([]);
  expect(Object.entries(r.calls).filter(([f, n]) => n > 1 && !f.endsWith('(…)')).map(([f, n]) => f + ' ×' + n), what + ': render functions run more than once').toEqual([]);
}
const elevenRun = r => ELEVEN.filter(f => r.calls[f]).sort();
// IR call 6003 (Oldir) while it is being edited in its row of the All Entries list: what its fields hold, or null when the row is not in edit mode
const editRow = page => page.evaluate(() => {
  const v = k => document.getElementById('irle-' + k + '-6003');
  return v('phys') ? { phys: v('phys').value, date: v('date').value, site: v('site').value, notes: v('notes').value } : null;
});
const savedCall = page => page.evaluate(() => { const c = S.irCalls.find(c => c.id === 6003); return { physId: c.physId, date: c.date, site: c.site, notes: c.notes }; });
const twoFrames = page => page.evaluate(() => new Promise(f => requestAnimationFrame(() => requestAnimationFrame(f))));

test.beforeEach(async ({ page }) => {
  await openApp(page, '/index.html?e2e=edit-fanout');
  await launchSyntheticUser(page, 'admin');
  await page.evaluate(buildPractice, YM);
});

test('an edit made on another page: none of the eleven views is drawn, and each shows the new data when it is opened', async ({ page }) => {
  await openEveryView(page);
  await go(page, 'physicians');
  const r = await editAll(page, true);
  // the edit itself: nothing hidden is drawn …
  expect(elevenRun(r), 'views drawn by an edit made on the Physicians page').toEqual([]);
  expectOnlyOpenPageDrawn(r, 'edit on Physicians');
  for (const v of VIEWS) expect(await text(page, v.sel), v.fn + ' is hidden, so still as it was').not.toContain(v.token);
  // … and what lives outside the pages still follows the edit
  const chrome = await page.evaluate(() => ({ unsaved: !!_hasUnsavedChanges, undoOff: document.getElementById('rs-undo-btn').disabled }));
  expect(chrome).toEqual({ unsaved: true, undoOff: false });
  // opening each page shows the new data with no further click (the IR call list and the holiday counter were left as the open tab)
  for (const v of VIEWS.filter(v => v.fn !== 'renderHolTable')) {
    await go(page, v.page);
    expect(await text(page, v.sel), v.fn + ' after opening ' + v.page).toContain(v.token);
  }
  // the other holiday tab draws itself when clicked
  await go(page, 'holidays', "holTab('assignments'");
  expect(await text(page, '#hol-tbody')).toContain('Zenith');
  // and the same for a removal, starting from a page that holds one of the views
  await go(page, 'vacations');
  const r2 = await editAll(page, false);
  expect(elevenRun(r2)).toEqual(['renderVacations']);
  expect(await text(page, '#vac-tbody')).not.toContain('Newdoc');
  for (const v of VIEWS.filter(v => v.fn !== 'renderHolCounter')) {
    await go(page, v.page);
    expect(await text(page, v.sel), v.fn + ' after the removal, opening ' + v.page).not.toContain(v.token);
  }
  await go(page, 'holidays', "holTab('counter'");
  expect(await text(page, '#hol-counter')).not.toContain('Zenith');
});

test('an edit runs only the render functions of the page on screen, each once', async ({ page }) => {
  await openEveryView(page);
  let on = false;
  for (const v of VIEWS) {
    await go(page, v.page, v.tab);
    on = !on;
    const r = await editAll(page, on);
    const what = 'edit with ' + v.page + (v.tab ? ' / ' + v.tab + ')' : '') + ' on screen';
    // the view on screen is drawn exactly once and shows the edit; no view of another page is drawn
    expect(r.calls[v.fn] || 0, what + ': ' + v.fn).toBe(1);
    if (on) expect(await text(page, v.sel), what).toContain(v.token); else expect(await text(page, v.sel), what).not.toContain(v.token);
    const samePage = VIEWS.filter(x => x.page === v.page).map(x => x.fn);
    expect(elevenRun(r).filter(f => !samePage.includes(f)), what + ': views of other pages drawn').toEqual([]);
    expectOnlyOpenPageDrawn(r, what);
  }
  // a tab that is closed is not drawn either; its tab button draws it
  await go(page, 'holidays', "holTab('assignments'");
  let r = await editAll(page, (on = !on));
  expect(elevenRun(r)).toEqual(['renderHolTable']);
  await go(page, 'ir-builder', "irBuilderTab('weekly'");
  r = await editAll(page, (on = !on));
  expect(elevenRun(r)).toEqual([]);
  expect(r.calls.renderIRWeekBuilder).toBe(1);
  // a page that holds none of the views: none is drawn, and far fewer nodes are written than the eleven views hold
  await go(page, 'open-shifts');
  const held = await page.evaluate(sels => sels.reduce((n, s) => n + document.querySelector(s).querySelectorAll('*').length, 0), VIEWS.map(v => v.sel));
  r = await editAll(page, (on = !on));
  expect(elevenRun(r)).toEqual([]);
  expectOnlyOpenPageDrawn(r, 'edit on Open Shifts');
  expect(r.nodes).toBeLessThan(held);
});

test('another session\'s save: the page on screen is redrawn, every other view is fresh when opened', async ({ page }) => {
  await openEveryView(page);
  // the IR call list is the open tab of the page on screen
  await go(page, 'ir-builder', "irBuilderTab('list'");
  let r = await page.evaluate(remoteSave, [YM, true]);
  expect(await text(page, '#irl-tbody'), 'IR call list on screen when the save arrives').toContain('Newir');
  expect(r.calls.renderIRList).toBe(1);
  expectOnlyOpenPageDrawn(r, 'remote save with the IR call list on screen');
  for (const v of VIEWS.filter(v => v.fn !== 'renderHolTable')) {
    await go(page, v.page);
    expect(await text(page, v.sel), v.fn + ' after opening ' + v.page).toContain(v.token);
  }
  await go(page, 'holidays', "holTab('assignments'");
  expect(await text(page, '#hol-tbody')).toContain('Zenith');
  // a second save arrives while the IR call builder is hidden with its list tab left open
  await go(page, 'ir-builder', "irBuilderTab('list'");
  await go(page, 'dashboard');
  r = await page.evaluate(remoteSave, [YM, false]);
  expect(await text(page, '#dash-dr-recent')).not.toContain('Newdoc');
  expect(elevenRun(r)).toEqual(['renderDash']);
  expectOnlyOpenPageDrawn(r, 'remote save with the dashboard on screen');
  await go(page, 'ir-builder');
  expect(await text(page, '#irl-tbody'), 'IR call list when its page is opened again').not.toContain('Newir');
  for (const v of VIEWS.filter(v => v.fn !== 'renderHolCounter')) {
    await go(page, v.page);
    expect(await text(page, v.sel), v.fn + ' after the second save, opening ' + v.page).not.toContain(v.token);
  }
  await go(page, 'holidays', "holTab('counter'");
  expect(await text(page, '#hol-counter')).not.toContain('Zenith');
});

test('an edit made while a tab inside a page is showing keeps that tab fresh', async ({ page }) => {
  await openEveryView(page);
  // IR call builder → All Entries: edit a call in its row (the save relies on _afterMutation to redraw the list) …
  await go(page, 'ir-builder', "irBuilderTab('list'");
  expect(await text(page, '#irl-tbody')).toContain('Oldir');
  await page.locator('#irl-tbody button[onclick="startEditIRCall(6003)"]').click();
  await page.fill('#irle-notes-6003', 'edited in the row');
  let r = await page.evaluate(() => window.__measure(() => document.querySelector('#irl-tbody button[onclick="saveEditIRCall(6003)"]').click()));
  expect(await page.evaluate(() => S.irCalls.find(c => c.id === 6003).notes)).toBe('edited in the row');
  expect(await page.locator('#irle-notes-6003').count(), 'the row left edit mode').toBe(0);
  expect(await text(page, '#irl-tbody')).toContain('edited in the row');
  expect(r.calls.renderIRList).toBe(1);
  expectOnlyOpenPageDrawn(r, 'save an IR call edited in its row');
  // … then remove it with the row's own button
  r = await page.evaluate(() => window.__measure(() => document.querySelector('#irl-tbody button[onclick^="removeIRCall(6003)"]').click()));
  expect(await text(page, '#irl-tbody'), 'the removed call is gone from the list').not.toContain('Oldir');
  expect(r.calls.renderIRList).toBe(1);
  expectOnlyOpenPageDrawn(r, 'remove IR call from the list');
  // … and add one while another tab of the page is showing: the list is right as soon as its tab is clicked
  await go(page, 'ir-builder', "irBuilderTab('manual'");
  r = await editAll(page, true);
  expect(elevenRun(r), 'the list tab is closed').toEqual([]);
  expect(r.calls.renderIRWeekBuilder).toBe(1);
  expectOnlyOpenPageDrawn(r, 'edit with Manual Entry showing');
  await page.locator('#page-ir-builder .tab', { hasText: 'All Entries' }).click();
  await expect(page.locator('#irl-tbody')).toContainText('Newir');
  await editAll(page, false);
  // Holiday Call → Counter, then Assignments, then Schedule
  await go(page, 'holidays', "holTab('counter'");
  r = await editAll(page, true);
  expect(await text(page, '#hol-counter')).toContain('Zenith');
  expect(elevenRun(r)).toEqual(['renderHolCounter']);
  expectOnlyOpenPageDrawn(r, 'edit with the holiday counter showing');
  await page.locator('#hol-tabs .tab', { hasText: 'Assignments' }).click();
  await expect(page.locator('#hol-tbody')).toContainText('Zenith');
  r = await editAll(page, false);
  expect(await text(page, '#hol-tbody')).not.toContain('Zenith');
  expect(elevenRun(r)).toEqual(['renderHolTable']);
  await page.locator('#hol-tabs .tab', { hasText: 'Counter' }).click();
  await expect(page.locator('#hol-counter')).not.toContainText('Zenith');
  await page.locator('#hol-tabs .tab', { hasText: 'Schedule' }).click();
  await page.selectOption('#holsched-yr', '2027');
  expect(await text(page, '#holt-schedule')).not.toContain('Newdoc');
  r = await editAll(page, true);
  expect(await text(page, '#holt-schedule')).toContain('Newdoc');
  expectOnlyOpenPageDrawn(r, 'edit with the holiday schedule showing');
  // My Schedule → My Shifts
  await go(page, 'my-schedule', "mySchedTab('shifts'");
  r = await editAll(page, false);
  expect(await text(page, '#my-content')).not.toContain('Zeta');
  expect(elevenRun(r)).toEqual(['renderMySched']);
});

test('handlers that also drew their own table now draw it once', async ({ page }) => {
  await openEveryView(page);
  // Vacations → Add Time Off
  await go(page, 'vacations');
  let r = await page.evaluate(ym => window.__measure(() => {
    document.getElementById('v-phys').value = '2002'; document.getElementById('v-start').value = ym + '-29'; document.getElementById('v-end').value = ym + '-30';
    document.getElementById('v-type').value = 'Vacation'; document.getElementById('v-notes').value = 'added by the form';
    addVac();
  }), YM);
  expect(await text(page, '#vac-tbody')).toContain('added by the form');
  expect(r.calls.renderVacations).toBe(1);
  expectOnlyOpenPageDrawn(r, 'Add Time Off');
  // … and delete it again with the row's own button
  r = await page.evaluate(() => window.__measure(() => {
    const id = S.vacations.find(v => v.notes === 'added by the form').id;
    document.querySelector('#vac-tbody button[onclick="deleteVacation(' + id + ')"]').click();
  }));
  expect(await text(page, '#vac-tbody')).not.toContain('added by the form');
  expect(r.calls.renderVacations).toBe(1);
  expectOnlyOpenPageDrawn(r, 'delete vacation');
  // IR call builder → Manual Entry → Add IR Call: the week grid once, the closed list tab not at all
  await go(page, 'ir-builder', "irBuilderTab('manual'");
  r = await page.evaluate(ym => window.__measure(() => {
    document.getElementById('ird-phys').value = '2004'; document.getElementById('ird-date').value = ym + '-16';
    document.getElementById('ird-ctype').value = 'daily'; document.getElementById('ird-grp').value = 'North';
    addIRCallManual();
  }), YM);
  expect(await page.evaluate(() => S.irCalls.filter(c => c.physId === 2004).length), 'the IR call was added').toBe(1);
  expect(r.calls.renderIRList || 0, 'the list tab is closed').toBe(0);
  expect(r.calls.renderIRWeekBuilder).toBe(1);
  expectOnlyOpenPageDrawn(r, 'Add IR Call');
  await page.locator('#page-ir-builder .tab', { hasText: 'All Entries' }).click();
  await expect(page.locator('#irl-tbody')).toContainText('Newir');
  // IR call builder → Weekly Builder: pick a physician in a day's dropdown
  await go(page, 'ir-builder', "irBuilderTab('weekly'");
  await page.evaluate(ym => { document.getElementById('irb-week').value = ym + '-22'; document.getElementById('irb-grp').value = 'North'; renderIRWeekBuilder(); }, YM);
  r = await page.evaluate(ym => window.__measure(() => {
    const sel = document.querySelector('#irb-week-content select[onchange*="\'' + ym + '-23\',\'daily\',\'North\'"]');
    sel.value = '2006'; sel.dispatchEvent(new Event('change'));
  }), YM);
  expect(await page.evaluate(() => S.irCalls.filter(c => c.physId === 2006).length), 'the IR call was added from the grid').toBe(1);
  expect(r.calls.renderIRWeekBuilder).toBe(1);
  expectOnlyOpenPageDrawn(r, 'add IR call from the week grid');
  expect(await text(page, '#irb-week-content')).toContain('Spareir');
});

test('printing shows every page, so the views an edit skipped are drawn before it', async ({ page }) => {
  await openEveryView(page);
  await go(page, 'physicians');
  const r = await editAll(page, true);
  expect(elevenRun(r)).toEqual([]);
  // the print stylesheet displays pages that are not open
  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('page-vacations')).display)).toBe('block');
  const p = await page.evaluate(() => window.__measure(() => window.dispatchEvent(new Event('beforeprint'))));
  await page.emulateMedia({ media: 'screen' });
  expect(ELEVEN.filter(f => p.calls[f] !== 1), 'views not drawn exactly once before printing').toEqual([]);
  for (const v of VIEWS) expect(await text(page, v.sel), v.fn + ' in the printout').toContain(v.token);
  // nothing is left to draw for a second print
  const p2 = await page.evaluate(() => window.__measure(() => window.dispatchEvent(new Event('beforeprint'))));
  expect(elevenRun(p2)).toEqual([]);
});

test('IR call list: a row being edited keeps what the user picked when another session saves, and the rest of the list shows that save', async ({ page }) => {
  await openEveryView(page);
  await go(page, 'ir-builder', "irBuilderTab('list'");
  await page.locator('#irl-tbody button[onclick="startEditIRCall(6003)"]').click();
  expect(await editRow(page)).toEqual({ phys: '2003', date: YM + '-09', site: '', notes: '' });
  await page.selectOption('#irle-phys-6003', '2006');                    // Oldir → Spareir
  await page.click('#irle-notes-6003');
  await page.keyboard.type('swapped per Dr X');
  // another session saves: one new record of every kind, and a site for this very call (a field the user has not touched)
  const r = await page.evaluate(remoteSave, [YM, true, { id: 6003, site: 'North IR Center' }]);
  await twoFrames(page);                                                 // _refreshCurrentPage puts the focus back on the next frame
  expect(await text(page, '#irl-tbody'), 'the other session\'s new call is in the list on screen').toContain('Newir');
  expect(r.calls.renderIRList).toBe(1);
  expectOnlyOpenPageDrawn(r, 'remote save while a row of the IR call list is being edited');
  expect(await editRow(page), 'the row after the other session\'s save: picked physician and typed notes kept, untouched site updated')
    .toEqual({ phys: '2006', date: YM + '-09', site: 'North IR Center', notes: 'swapped per Dr X' });
  expect(await page.evaluate(() => document.activeElement.id), 'the notes field still has the focus').toBe('irle-notes-6003');
  // the user goes on typing; a second save arrives; then the tick saves what the row shows
  await page.keyboard.type(', confirmed');
  await page.evaluate(remoteSave, [YM, false, { id: 6003, site: 'North IR Center' }]);
  await twoFrames(page);
  expect(await text(page, '#irl-tbody')).not.toContain('Newir');
  expect(await editRow(page)).toEqual({ phys: '2006', date: YM + '-09', site: 'North IR Center', notes: 'swapped per Dr X, confirmed' });
  await page.locator('#irl-tbody button[onclick="saveEditIRCall(6003)"]').click();
  expect(await savedCall(page)).toEqual({ physId: 2006, date: YM + '-09', site: 'North IR Center', notes: 'swapped per Dr X, confirmed' });
  expect(await editRow(page), 'the row left edit mode').toBe(null);
  expect(await text(page, '#irl-tbody')).toContain('Spareir');
  expect(await text(page, '#irl-tbody')).not.toContain('Oldir');
  // a row in edit mode that the user has not changed simply shows the other session's values
  await page.locator('#irl-tbody button[onclick="startEditIRCall(6003)"]').click();
  await page.evaluate(remoteSave, [YM, true, { id: 6003, physId: 2003, notes: 'changed elsewhere' }]);
  expect(await editRow(page)).toEqual({ phys: '2003', date: YM + '-09', site: 'North IR Center', notes: 'changed elsewhere' });
  // a physician the user picked who has since stopped doing IR cannot stay picked: the row shows the saved one again
  await page.selectOption('#irle-phys-6003', '2006');
  await page.evaluate(remoteSave, [YM, false, { physician: { id: 2006, irFte: 0 } }]);
  expect(await editRow(page)).toEqual({ phys: '2003', date: YM + '-09', site: 'North IR Center', notes: 'changed elsewhere' });
  // and when the other session removed the call, its row is gone
  await page.selectOption('#irle-phys-6003', '2004');
  await page.evaluate(remoteSave, [YM, true, { id: 6003, gone: true }]);
  expect(await editRow(page)).toBe(null);
  expect(await page.evaluate(() => S.irCalls.some(c => c.id === 6003))).toBe(false);
  expect(await text(page, '#irl-tbody')).not.toContain('Oldir');
});

test('IR call list: a row left in edit mode keeps what the user picked when its page is opened again, also after a save elsewhere and a printout', async ({ page }) => {
  await openEveryView(page);
  await go(page, 'ir-builder', "irBuilderTab('list'");
  await page.locator('#irl-tbody button[onclick="startEditIRCall(6003)"]').click();
  await page.selectOption('#irle-phys-6003', '2006');                    // Oldir → Spareir
  await page.fill('#irle-date-6003', YM + '-12');
  await page.fill('#irle-notes-6003', 'left half done');
  const picked = { phys: '2006', date: YM + '-12', site: '', notes: 'left half done' };
  // look something up on another page and come straight back
  await go(page, 'dashboard');
  let r = await page.evaluate(() => window.__measure(() => window.__go('ir-builder')));
  expect(r.calls.renderIRList, 'the list is drawn when its page is opened').toBe(1);
  expect(await editRow(page), 'the row after leaving the page and coming back').toEqual(picked);
  // leave again; another session saves while the page is hidden; the schedule is printed; come back
  await go(page, 'dashboard');
  r = await page.evaluate(remoteSave, [YM, true]);
  expect(r.calls.renderIRList || 0, 'the hidden list is not drawn by the save').toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  expect(await text(page, '#irl-tbody'), 'the list in the printout').toContain('Newir');
  expect(await editRow(page), 'the row after the printout').toEqual(picked);
  await go(page, 'ir-builder');
  expect(await text(page, '#irl-tbody'), 'the list when its page is opened again').toContain('Newir');
  expect(await editRow(page), 'the row when its page is opened again').toEqual(picked);
  // the tick saves what the row shows
  await page.locator('#irl-tbody button[onclick="saveEditIRCall(6003)"]').click();
  expect(await savedCall(page)).toEqual({ physId: 2006, date: YM + '-12', site: '', notes: 'left half done' });
  expect(await editRow(page)).toBe(null);
  expect(await text(page, '#irl-tbody')).toContain('Spareir');
});

test('IR call list: an edit made in this tab still redraws a row in edit mode from the saved data, as rs-v136 does', async ({ page }) => {
  // Not changed by rs-v137, and pinned here so that it is changed on purpose or not at all: rs-v136 redrew the
  // list after every edit made in the tab, so the row in edit mode went back to the saved values.
  await openEveryView(page);
  await page.evaluate(ym => { S.irCalls.push(window.__newRecords(ym).irCalls[0]); }, YM);
  await go(page, 'ir-builder', "irBuilderTab('list'");
  await page.locator('#irl-tbody button[onclick="startEditIRCall(6003)"]').click();
  await page.selectOption('#irle-phys-6003', '2006');
  await page.locator('#irl-tbody button[onclick^="removeIRCall(6503)"]').click();
  expect(await text(page, '#irl-tbody'), 'the other call was removed').not.toContain('Newir');
  expect(await editRow(page)).toEqual({ phys: '2003', date: YM + '-09', site: '', notes: '' });
});
