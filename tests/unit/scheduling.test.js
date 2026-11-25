const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the shipped browser functions against an in-memory schedule. Page
// rendering and storage are replaced, while eligibility and mutations are real.
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
function readFunction(name) {
  const start = html.search(new RegExp('(?:^|(?<=}))function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, 'Shipped function missing: ' + name);
  const newline = html.indexOf('\n', start);
  if (html[newline - 1] === '}') return html.slice(start, newline);
  return html.slice(start, html.indexOf('\n}', newline) + 2);
}

const source = [
  'parseDateLocal', 'fmtDate', 'addDays', 'getWeek', 'vacDays', '_awayDays', '_physStartDate',
  '_physStartedBy', '_confirmBeforeStart', '_drSlotWeek', '_drAutoDatesFree', '_drAutoRulesOk',
  '_physBookingsOnDate', '_has2ndOr3rdShift', 'natLangRulesOk', 'tbRulesOk', 'callDayRulesOk',
  '_drDayFte', '_wkndNeedsFor', '_wkndNeedCount', '_wkndYearCap', '_hasAdjacentWeekend',
  '_filterCellsByPeriod', 'maxDR', 'drEffectiveTarget', 'previewAA', 'applyAA', '_scanUnfilled',
  '_isPhysOnVacation', '_rotationPhysIdsFor', '_rotationSlotEligible', '_migrateRotationToSlots',
  '_assignRotation', '_missingShiftSubNeeds', '_ssSetTotalSlot', 'saveEditWkCall'
].map(readFunction).join('\n');

const remote = 'At Home / Remote';
function physician(id) {
  return {
    id, first: 'Test', last: 'Physician ' + id, role: 'MIXED', drFte: 1, irFte: 1,
    drSubs: ['Body'], shiftElig: { home: true, wknd: true, s1: true }
  };
}

function practice(date = '2026-11-23', type = 'weekday', ids = [1, 2]) {
  const month = date.slice(0, 7);
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  const cell = { date, day: +date.slice(-2), dow, isWknd: dow === 0 || dow === 6 };
  const S = {
    physicians: ids.map(physician), sites: [{ name: 'Hospital' }, { name: remote }],
    siteSlots: {}, siteSlotsSubs: {}, shiftSubNeeds: {}, cfg: { wdMax: 20, wkMax: 6 },
    drShifts: [], irShifts: [], weekendCalls: [], irCalls: [], vacations: [], openShifts: [],
    natLangRules: [], wkndNeeds: {}, nextId: 100, aaPreview: []
  };
  const ui = {
    'aa-mo': { value: month }, 'aa-period': { value: 'month' }, 'aa-type': { value: type },
    'aa-box': {}, 'aa-apply': { style: {} }
  };
  let saved;
  const context = vm.createContext({
    S, document: { getElementById: key => ui[key] }, buildCal: () => [cell],
    triggerSave: () => { saved = JSON.parse(JSON.stringify(S)); }, _afterMutation: () => {},
    _adminOnly: () => true, _todayLocalYM: () => month, renderSlotGrid: () => {},
    _physById: id => S.physicians.find(p => p.id === id), pnameHtml: id => String(id),
    _gatherManualRuleViolations: () => [], _conferenceShiftPreferenceFor: () => 0,
    drCnt: (id, ym) => S.drShifts.filter(s => s.physId === id && s.date.startsWith(ym)).length,
    drHomeCnt: id => S.drShifts.filter(s => s.physId === id && s.shift === 'Home').length,
    wkCnt: id => S.weekendCalls.filter(s => s.physId === id).length,
    dayConditionSiteOk: () => true, siteRuleOk: () => true, sequenceOk: () => true,
    isSoldBackDate: () => false, isHolidayBlackout: () => false, _wkndDayOk: () => true,
    _wkndIsSummer: () => false, _editingWkId: null, escHtml: String
  });
  vm.runInContext(source, context);
  return { S, ui, date, month, context, persisted: () => saved };
}

test('configured and fallback Home fill respect bookings and physician rules', () => {
  for (const configured of [false, true]) {
    const { S, date, context } = practice(undefined, 'weekday', [1, 2, 3, 4, 5]);
    if (configured) context._ssSetTotalSlot(remote, 1, 'Home', 1);
    S.drShifts.push({ id: 21, physId: 1, date, shift: '1st', site: 'Hospital' });
    S.irShifts.push({ id: 22, physId: 2, date, shift: '1st', site: 'Hospital' });
    S.natLangRules.push({ when: { physId: 3, shift: 'Home' }, then: { action: 'block' } });
    S.vacations.push({ physId: 4, start: date, end: date });
    context.previewAA();
    assert.deepEqual(Array.from(S.aaPreview, a => a.physId), [5]);
    context.applyAA();
    assert.deepEqual(S.drShifts.filter(s => s.shift === 'Home').map(s => s.physId), [5]);
  }
});

test('weekend call uses both dates and Apply rechecks new conflicts', () => {
  const { S, date, context, ui } = practice('2026-11-21', 'weekend', [1, 2, 3]);
  S.wkndNeeds = { '': { day: 1, swing: 0 } };
  S.irCalls.push({ id: 20, physId: 1, date: '2026-11-20', callType: 'weekend' });
  S.irShifts.push({ id: 21, physId: 2, date: '2026-11-22', shift: '1st', site: 'Hospital' });
  context.previewAA();
  assert.deepEqual(Array.from(S.aaPreview, a => a.physId), [3]);
  S.irShifts.push({ id: 22, physId: 3, date, shift: '1st', site: 'Hospital' });
  context.applyAA();
  assert.equal(S.weekendCalls.length, 0);
  assert.match(ui['aa-box'].innerHTML, /1 skipped/);
  context.previewAA();
  assert.equal(S.aaPreview.length, 0);
  assert.equal(S.openShifts.filter(s => s.shiftType === 'Weekend Call').length, 1);
});

test('sixth-row weekdays use configured hospital demand in both the builder and gap report', () => {
  for (const date of ['2026-08-24', '2026-08-31']) {
    const { S, month, context } = practice(date, 'weekday', [1]);
    context._ssSetTotalSlot('Hospital', 1, '1st', 1);
    const gaps = () => context._scanUnfilled({ fromYM: month, months: 1, cat: 'dr' });
    assert.equal(gaps().length, 1);
    context.previewAA();
    assert.deepEqual(Array.from(S.aaPreview, a => [a.site, a.shift]), [['Hospital', '1st']]);
    context.applyAA();
    assert.equal(gaps().length, 0);
  }
});

test('hospital Home and remote Home are independent gaps and fills', () => {
  const { S, date, month, context } = practice(undefined, 'weekday', [1]);
  context._ssSetTotalSlot('Hospital', 1, 'Home', 1);
  context._ssSetTotalSlot(remote, 1, 'Home', 1);
  const gaps = () => Array.from(context._scanUnfilled({ fromYM: month, months: 1, cat: 'dr' }), g => g.site);
  assert.deepEqual(gaps().sort(), [remote, 'Hospital'].sort());
  S.drShifts.push({ id: 13, date, physId: 2, shift: 'Home', site: 'Hospital' });
  assert.deepEqual(gaps(), [remote]);
  context.previewAA();
  assert.equal(S.aaPreview[0].site, remote);
  context.applyAA();
  assert.deepEqual(gaps(), []);
});

test('a zero weekday allowance produces no preview or applied work', () => {
  const { S, context } = practice();
  S.cfg.wdMax = 0;
  context._ssSetTotalSlot('Hospital', 1, '1st', 1);
  context._ssSetTotalSlot(remote, 1, 'Home', 1);
  context.previewAA();
  assert.equal(S.aaPreview.length, 0);
  context.applyAA();
  assert.equal(S.drShifts.length, 0);
});

test('weekend call Edit persists the new date, physician and shift type', () => {
  const { S, ui, context, persisted } = practice();
  S.weekendCalls.push({ id: 20, physId: 1, satDate: '2026-11-07', wshift: 'day' });
  for (const [field, value] of Object.entries({ phys: '2', sat: '2026-11-14', sub: 'Body', type: 'Primary', wshift: 'swing' })) {
    ui['wke-' + field + '-20'] = { value };
  }
  context.saveEditWkCall(20);
  const record = persisted().weekendCalls[0];
  assert.deepEqual([record.physId, record.satDate, record.sunDate, record.wshift, record.site],
    [2, '2026-11-14', '2026-11-15', 'swing', '']);
});

test('forced rotations clear unfillable auto slots and preserve manual overrides', () => {
  const { S, date, context } = practice();
  const item = { allowedPhysIds: [1, 2], rotation: { enabled: true, slots: [
    { id: 'reader', label: 'Reader', physRotation: [1] }, { id: 'chair', label: 'Chair', physRotation: [2] }
  ], assignments: { [date]: { reader: { physId: 1, assignedBy: 'auto' }, chair: { physId: 2, assignedBy: 'manual' } } } } };
  S.vacations.push({ physId: 1, start: date, end: date });
  const result = context._assignRotation(item, [date], { force: true });
  assert.equal(result.skipped, 1);
  assert.equal(result.conflicts[0].slotId, 'reader');
  assert.deepEqual(Array.from(context._rotationPhysIdsFor(item, date)), [2]);
  assert.equal(item.rotation.assignments[date].chair.assignedBy, 'manual');
  S.vacations = [];
  context._assignRotation(item, [date], { force: true });
  assert.deepEqual(Array.from(context._rotationPhysIdsFor(item, date)).sort(), [1, 2]);
});

test('specialty coverage counts distinct physicians, including duplicate shift records', () => {
  const { S, date, context } = practice();
  S.shiftSubNeeds = { 'Hospital|1st': { Body: 2 } };
  const slot = { date, physId: 1, site: 'Hospital', shift: '1st', sub: 'Body' };
  S.drShifts.push({ ...slot, id: 1 }, { ...slot, id: 2 });
  assert.deepEqual(Array.from(context._missingShiftSubNeeds(date, 'Hospital', '1st')), ['Body (have 1, need 2)']);
  S.drShifts.push({ ...slot, id: 3, physId: 2 });
  assert.deepEqual(Array.from(context._missingShiftSubNeeds(date, 'Hospital', '1st')), []);
});
