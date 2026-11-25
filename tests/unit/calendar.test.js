const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
const start = html.indexOf('function _myEventsInRange(');
const end = html.indexOf('/* CSV schedule export', start);
assert.ok(start >= 0 && end > start);
const script = new vm.Script(html.slice(start, end));
function exportCalendar(state, from, to) {
  const context = vm.createContext({ S: state, CU: { physId: 1 }, addDays(iso, n) {
    const d = new Date(iso+'T12:00:00Z');
    d.setUTCDate(d.getUTCDate()+n);
    return d.toISOString().slice(0,10);
  } });
  script.runInContext(context);
  return context._eventsToICS(context._myEventsInRange(from, to), 'Synthetic calendar');
}

test('vacation overlap includes spanning leave, ends exclusively and preserves other shifts', () => {
  const state = { vacations: [
    { id: 1, physId: 1, start: '2026-07-01', end: '2026-07-02' },
    { id: 2, physId: 1, start: '2026-11-20', end: '2026-12-01' },
    { id: 3, physId: 2, start: '2026-11-28' },
  ], drShifts: [{ id: 4, physId: 1, date: '2026-11-28', shift: '1st' }] };
  const ics = exportCalendar(state, '2026-11-28', '2026-11-29');
  assert.match(ics, /UID:dr-4@/);
  assert.match(ics, /UID:vac-2@/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261202/);
  assert.doesNotMatch(ics, /UID:vac-[13]@/);
});

test('middle-of-weekend selection exports the whole IR call with stable UID and configured times', () => {
  const state = { irCalls: [{ id: 1, physId: 1, date: '2026-11-27', callType: 'weekend' }],
    shiftTimes: { 'IR Call': { start: '18:00', end: '08:00' } } };
  for (const [from, to] of [['2026-11-27','2026-11-30'], ['2026-11-28','2026-11-29']]) {
    const ics = exportCalendar(state, from, to);
    assert.match(ics, /UID:irc-1@/);
    assert.match(ics, /DTSTART:20261127T180000\r\nDTEND:20261130T080000/);
  }
  assert.doesNotMatch(exportCalendar(state, '2026-12-01', '2026-12-01'), /BEGIN:VEVENT/);
});
