// "All Call for a Year" workbook (rs-v133): every DR weekend, IR and holiday call
// assignment of one year, the slots still open, and per-physician totals.
const { test, expect } = require('@playwright/test');
const zlib = require('zlib');
const { openApp, launchSyntheticUser } = require('./helpers');

// Minimal .xlsx reader: the app writes stored/deflated zip entries with inline strings.
function readXlsx(buf) {
  const files = {};
  let i = 0;
  while (i < buf.length - 4 && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8), csize = buf.readUInt32LE(i + 18), nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nlen).toString();
    const data = buf.slice(i + 30 + nlen + xlen, i + 30 + nlen + xlen + csize);
    files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString();
    i += 30 + nlen + xlen + csize;
  }
  const names = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  const sheets = {};
  names.forEach((n, k) => {
    sheets[n] = [...files[`xl/worksheets/sheet${k + 1}.xml`].matchAll(/<row r="\d+">(.*?)<\/row>/g)].map(r =>
      [...r[1].matchAll(/<c [^>]*?(?:\/>|>(.*?)<\/c>)/g)].map(c => { const v = c[1] || ''; const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(v) || /<v>(.*?)<\/v>/.exec(v); return t ? t[1] : ''; }));
  });
  return sheets;
}

test('All Call for a Year downloads every call of the year, open slots and totals', async ({ page }) => {
  await openApp(page, '/index.html?e2e=all-call');
  await launchSyntheticUser(page, 'superuser');
  await page.evaluate(() => {
    _isRestoring = true;
    const mk = (id, first, last, grp, fte, dr) => ({ id, first, last, role: 'IR', drFte: dr || 0, irFte: fte, irGroup: grp, drSubs: [], irSubs: [], shiftElig: { s1: true, wknd: true },
      irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [] });
    S.physicians = [mk(1, 'Ann', 'Alpha', 'South', 1), mk(2, 'Bob', 'Beta', 'South', 1), mk(3, 'Cy', 'Gamma', null, 0, 1)];
    S.irCalls = [
      { id: 101, physId: 1, date: '2027-03-02', callType: 'daily', irGroup: 'South', site: '', notes: 'Auto' },
      { id: 102, physId: 2, date: '2027-03-05', callType: 'weekend', irGroup: 'South', site: 'CHS', notes: 'Auto' },
      { id: 103, physId: 1, date: '2027-05-28', callType: 'weekend', irGroup: 'South', site: 'CHS', notes: 'Memorial Day (Holiday)' },
      { id: 104, physId: 2, date: '2026-12-29', callType: 'daily', irGroup: 'South', site: '', notes: 'Auto' },          // other year: left out
    ];
    S.weekendCalls = [{ id: 201, physId: 3, satDate: '2027-03-06', sunDate: '2027-03-07', wshift: 'day', sub: '' }];
    S.holidays = [{ id: 301, physId: 3, date: '2027-11-25', name: 'Thanksgiving', year: 2027, group: 'DR', wshift: 'day', sub: '' },
      { id: 302, physId: 1, date: '2027-05-29', name: 'Memorial Day', year: 2027, group: 'IR-South' }];   // already listed as the IR call above
    S.holidayDefs = [{ id: 401, name: 'Memorial Day', year: 2027, dates: ['2027-05-29', '2027-05-30', '2027-05-31'], irSlotsByGroup: { South: 1 } },
      { id: 402, name: 'Labor Day', year: 2027, dates: ['2027-09-06'], irSlotsByGroup: { South: 1 } }];
    S.openShifts = [{ id: 501, shiftType: 'Weekend Call', date: '2027-04-10', wshift: 'swing', sub: '' }];
    S.drShifts = []; S.irShifts = []; S.vacations = [];
    _isRestoring = false; if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    window.prompt = (msg, def) => '2027';
    nav('ir-cal', document.querySelector('.snav-item[data-pg="ir-cal"]'));
  });
  const button = page.locator('#page-ir-cal button', { hasText: 'All Call for a Year' });
  await expect(button).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(dl.suggestedFilename()).toBe('All_Call_2027.xlsx');
  const buf = require('fs').readFileSync(await dl.path());
  const x = readXlsx(buf);
  expect(Object.keys(x)).toEqual(['All call', 'DR weekend', 'IR call', 'Holiday call', 'Open slots', 'Totals by physician']);
  const all = x['All call'].slice(1);
  expect(all.map(r => [r[0], r[3], r[7]])).toEqual([
    ['2027-03-02', 'IR call', 'Alpha, Ann'],
    ['2027-03-05', 'IR call', 'Beta, Bob'],
    ['2027-03-06', 'DR weekend call', 'Gamma, Cy'],
    ['2027-05-28', 'IR holiday call', 'Alpha, Ann'],
    ['2027-11-25', 'DR holiday call', 'Gamma, Cy'],
  ]);
  expect(x['All call'][2][1]).toBe('2027-03-08');                       // IR weekend call runs Fri→Mon
  expect(x['Holiday call'].length - 1).toBe(2);
  const open = x['Open slots'].slice(1);
  expect(open.some(r => r[0] === '2027-04-10' && /DR weekend/.test(r[2]))).toBe(true);
  expect(open.some(r => r[0] === '2027-09-03' && r[2] === 'IR holiday weekend')).toBe(true);   // Labor Day weekend, no holiday call yet
  expect(open.some(r => r[0] === '2027-03-02')).toBe(false);                                    // held
  const tot = Object.fromEntries(x['Totals by physician'].slice(1).map(r => [r[0], r]));
  expect(tot['Alpha, Ann'][7]).toBe('1');                                // IR weekday
  expect(tot['Alpha, Ann'][11]).toBe('1');                               // IR holiday
  expect(tot['Beta, Bob'][9]).toBe('1');                                 // IR weekend
  expect(tot['Gamma, Cy'][4]).toBe('1');                                 // DR weekend day
  expect(tot['Gamma, Cy'][6]).toBe('1');                                 // DR holiday block
});

test('a holiday call filed on the last day of the year is listed once, in its holiday year; an unassigned weekday IR holiday is an open slot', async ({ page }) => {
  await openApp(page, '/index.html?e2e=all-call-2');
  await launchSyntheticUser(page, 'superuser');
  await page.evaluate(() => {
    _isRestoring = true;
    const mk = (id, first, last, grp, fte) => ({ id, first, last, role: 'IR', drFte: 0, irFte: fte, irGroup: grp, drSubs: [], irSubs: [], shiftElig: { s1: true, wknd: true },
      irCallBlackouts: [], siteRules: [], tbRules: [], dayConditions: [], callDayRules: [], siteSeqRules: [], allowedSites: [] });
    S.physicians = [mk(1, 'Ann', 'Alpha', 'South', 1), mk(2, 'Bob', 'Beta', 'South', 1)];
    // 'NY' of 2027 is observed on Thu 2026-12-31: the Holiday tab files it under 2027, the synced IR call is dated 2026.
    S.holidayDefs = [{ id: 411, name: 'NY', year: 2027, dates: ['2026-12-31'], irSlotsByGroup: { South: 1 } },
      { id: 412, name: 'Thanksgiving', year: 2027, dates: ['2027-11-25'], irSlotsByGroup: { South: 1 } }];
    S.irCalls = [{ id: 111, physId: 1, date: '2026-12-31', callType: 'daily', irGroup: 'South', site: '', notes: 'NY (Holiday)' }];
    S.holidays = [{ id: 311, physId: 1, date: '2026-12-31', name: 'NY', year: 2027, group: 'IR-South' }];
    S.weekendCalls = []; S.openShifts = []; S.drShifts = []; S.irShifts = []; S.vacations = [];
    _isRestoring = false; if (typeof _markDateIdxDirty === 'function') _markDateIdxDirty();
    nav('ir-cal', document.querySelector('.snav-item[data-pg="ir-cal"]'));
  });
  const button = page.locator('#page-ir-cal button', { hasText: 'All Call for a Year' });
  const book = async yr => {
    await page.evaluate(y => { window.prompt = () => y; }, String(yr));
    const [dl] = await Promise.all([page.waitForEvent('download'), button.click()]);
    return readXlsx(require('fs').readFileSync(await dl.path()));
  };
  const y26 = await book(2026), y27 = await book(2027);
  const ny = x => x['All call'].slice(1).filter(r => r[0] === '2026-12-31');
  expect(ny(y27).length).toBe(1);                              // listed once, under its holiday year
  expect(ny(y26).length).toBe(0);                              // was: also in the 2026 workbook
  const ann = x => (x['Totals by physician'].find(r => /Alpha/.test(r[0])) || []);
  expect(ann(y26).slice(-1)[0] || '0').toBe('0');
  expect(y27['Open slots'].slice(1).some(r => r[0] === '2027-11-25' && r[2] === 'IR holiday weekday' && r[3] === 'South')).toBe(true);   // was: missing
});
