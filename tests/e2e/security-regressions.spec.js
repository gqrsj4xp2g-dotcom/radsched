const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser } = require('./helpers');

test('stored schedule fields render as text and cannot execute HTML', async ({ page }) => {
  await openApp(page, '/index.html?e2e=stored-xss');
  await launchSyntheticUser(page, 'user');

  const result = await page.evaluate(() => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const day = `${ym}-15`;
    const attack = `\"><img data-rs-attack src=x onerror="window.__rsXss=(window.__rsXss||0)+1">`;
    window.__rsXss = 0;
    CU.physId = 7001;
    S.physicians = [{ id: 7001, first: 'Safe', last: 'Viewer', role: 'DR', drFte: 1, irFte: 1, irGroup: 'North', active: true }];
    S.drShifts = [{ id: 1, physId: 7001, date: day, shift: attack, site: attack, sub: attack, slotLabel: attack }];
    S.weekendCalls = [{ id: 2, physId: 7001, satDate: day, sunDate: day, site: attack }];
    S.irCalls = [{ id: 3, physId: 7001, date: day, callType: 'daily', irGroup: attack, site: attack }];
    S.irShifts = [{ id: 4, physId: 7001, date: day, shift: '1st', site: attack, sub: attack, slotLabel: attack }];
    S.holidays = [];
    S.vacations = [];
    document.getElementById('my-mo').value = ym;
    localStorage.setItem('rs.mysched.view', 'month');
    renderMySched();
    return {
      executed: window.__rsXss,
      injectedNodes: document.querySelectorAll('#my-content [data-rs-attack]').length,
      text: document.getElementById('my-content').textContent,
    };
  });

  expect(result.executed).toBe(0);
  expect(result.injectedNodes).toBe(0);
  expect(result.text).toContain('<img data-rs-attack');
});

test('practice creation and switching are superuser-only', async ({ page }) => {
  await openApp(page, '/index.html?e2e=tenant-admin-boundary');
  await launchSyntheticUser(page, 'admin');

  const allowed = await page.evaluate(() => _superuserOnly('switch practices'));
  expect(allowed).toBe(false);
});
