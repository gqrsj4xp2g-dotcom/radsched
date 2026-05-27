const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser, openToolsOps, installSyntheticSupabase } = require('./helpers');

test('login screen renders and rejects bad credentials without entering the app', async ({ page }) => {
  await openApp(page, '/index.html?e2e=login');

  await expect(page.locator('#auth')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#li-email')).toBeVisible();
  await expect(page.locator('#li-pw')).toBeVisible();

  await page.evaluate(() => {
    document.getElementById('li-email').value = 'bad-login@example.com';
    document.getElementById('li-pw').value = 'not-the-password';
  });
  await page.evaluate(() => window.doLogin());

  await expect(page.locator('#aerr')).toContainText('Invalid email or password');
  await expect(page.locator('#app')).toBeHidden();
});

test('superuser can open Tools ops and run quick and deep system health', async ({ page }) => {
  await openApp(page, '/index.html?e2e=health');
  await launchSyntheticUser(page, 'superuser');
  await openToolsOps(page);

  await page.evaluate(() => window.renderSystemHealth(true));
  await expect(page.locator('#sys-health-result')).toContainText('Quick health');
  await expect(page.locator('#sys-health-result')).toContainText('App build marker');
  await expect(page.locator('#sys-health-result')).toContainText('Data sanity');
  await expect(page.getByRole('button', { name: /Rollback timeline/i })).toHaveCount(2);

  await page.getByRole('button', { name: '▶ Run health check' }).click();
  await expect(page.locator('#sys-health-result')).toContainText('Service worker source');
  await expect(page.locator('#sys-health-result')).toContainText('PWA manifest and icons');
});

test('non-admin role gate blocks Tools access', async ({ page }) => {
  await openApp(page, '/index.html?e2e=role-gate');
  await launchSyntheticUser(page, 'user');

  let dialogText = '';
  page.on('dialog', async dialog => {
    dialogText = dialog.message();
    await dialog.dismiss();
  });

  await page.evaluate(() => {
    window.nav('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'ops');
  });

  await expect(page.locator('#page-tools')).toBeHidden();
  expect(dialogText).toContain('restricted to administrators');
});

test('service worker source and registration use the current app shell version', async ({ page, request }) => {
  const [html, sw] = await Promise.all([
    request.get('/index.html').then(r => r.text()),
    request.get('/sw.js').then(r => r.text()),
  ]);
  const htmlBuild = html.match(/const\s+_RS_HTML_BUILD\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const htmlSw = html.match(/const\s+_SW_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const swVersion = sw.match(/const\s+CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  expect(htmlBuild).toBeTruthy();
  expect(htmlBuild).toBe(htmlSw);
  expect(htmlSw).toBe(swVersion);

  await openApp(page, '/index.html?e2e=sw');
  const registration = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return {
      supported: true,
      scope: reg.scope,
      activeScript: reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '',
    };
  });
  expect(registration.supported).toBe(true);
  expect(registration.scope).toContain('/');
  expect(registration.activeScript).toContain('/sw.js');
});

test('basic Supabase save path writes the active practice row through the client', async ({ page }) => {
  await openApp(page, '/index.html?e2e=sync');
  await installSyntheticSupabase(page);
  const result = await page.evaluate(async () => {
    CU = { id: 'e2e-admin', email: 'admin@example.com', role: 'admin', first: 'E2E', last: 'Admin', practiceId: 'main' };
    _ROW_ID = 'main';
    _PRACTICE_ID = 'main';
    S.physicians = [{ id: 99001, first: 'Sync', last: 'Tester', role: 'DR', fte: 1 }];
    S._remoteSavedAt = null;
    S._lastSaved = new Date();
    const ok = await _pushToSupabase();
    const saved = window.__rsMockSupabase.__rows[0] || null;
    return {
      ok,
      rowId: saved?.id,
      hasSavedAt: !!(saved && JSON.parse(saved.data).savedAt),
      physicianCount: saved ? JSON.parse(saved.data).physicians.length : 0,
    };
  });

  expect(result.ok).toBe(true);
  expect(result.rowId).toBe('main');
  expect(result.hasSavedAt).toBe(true);
  expect(result.physicianCount).toBe(1);
});
