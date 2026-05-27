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

  await page.evaluate(() => {
    const renderHealth = globalThis.renderSystemHealth || Function('return typeof renderSystemHealth === "function" ? renderSystemHealth : null')();
    renderHealth(true);
  });
  await expect(page.locator('#sys-health-result')).toContainText('Quick health');
  await expect(page.locator('#sys-health-result')).toContainText('App build marker');
  await expect(page.locator('#sys-health-result')).toContainText('Data sanity');
  await expect(page.getByRole('button', { name: /Rollback timeline/i })).toBeVisible();

  await page.getByRole('button', { name: '▶ Run health check' }).click();
  await expect(page.locator('#sys-health-result')).toContainText('Service worker source');
  await expect(page.locator('#sys-health-result')).toContainText('PWA manifest and icons');
  await expect(page.locator('#sys-health-result')).toContainText('Audit side table');
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
    const navFn = globalThis.nav || Function('return typeof nav === "function" ? nav : null')();
    navFn('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'ops');
  });

  await expect(page.locator('#page-tools')).toBeHidden();
  expect(dialogText).toContain('restricted to administrators');
});

test('role matrix allows only admin and superuser into Tools ops', async ({ browser }) => {
  for (const { role, allowed } of [
    { role: 'superuser', allowed: true },
    { role: 'admin', allowed: true },
    { role: 'user', allowed: false },
  ]) {
    const page = await browser.newPage();
    await openApp(page, `/index.html?e2e=role-matrix-${role}`);
    await launchSyntheticUser(page, role);

    let dialogText = '';
    page.on('dialog', async dialog => {
      dialogText = dialog.message();
      await dialog.dismiss();
    });

    await page.evaluate(() => {
      const navFn = globalThis.nav || Function('return typeof nav === "function" ? nav : null')();
      navFn('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'ops');
    });

    if (allowed) {
      await expect(page.locator('#page-tools')).toBeVisible();
      await expect(page.locator('#tools-subnav .tab[data-tt="ops"]')).toHaveClass(/on/);
    } else {
      await expect(page.locator('#page-tools')).toBeHidden();
      expect(dialogText).toContain('restricted to administrators');
    }
    await page.close();
  }
});

test('admin MFA gate blocks privileged navigation until aal2 verification', async ({ page }) => {
  await openApp(page, '/index.html?e2e=admin-mfa');
  await launchSyntheticUser(page, 'admin', { aal: 'aal1' });

  let dialogText = '';
  page.once('dialog', async dialog => {
    dialogText = dialog.message();
    await dialog.dismiss();
  });
  await page.evaluate(() => {
    const navFn = globalThis.nav || Function('return typeof nav === "function" ? nav : null')();
    navFn('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'ops');
  });
  await expect(page.locator('#page-tools')).toBeHidden();
  expect(dialogText).toContain('MFA');
  await expect(page.locator('#rs-admin-mfa-gate')).toBeVisible();

  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('prompt');
    await dialog.accept('123456');
  });
  const verified = await page.evaluate(async () => {
    const verify = globalThis._mfaChallengeAdmin || Function('return typeof _mfaChallengeAdmin === "function" ? _mfaChallengeAdmin : null')();
    return verify();
  });
  expect(verified).toBe(true);

  await page.evaluate(() => {
    const navFn = globalThis.nav || Function('return typeof nav === "function" ? nav : null')();
    navFn('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'ops');
  });
  await expect(page.locator('#page-tools')).toBeVisible();
  await expect(page.locator('#rs-admin-mfa-gate')).toHaveCount(0);
});

test('go-live readiness checklist surfaces launch guardrails', async ({ page }) => {
  await openApp(page, '/index.html?e2e=golive');
  await launchSyntheticUser(page, 'superuser');
  await openToolsOps(page);

  await page.getByRole('button', { name: 'Run readiness checklist' }).click();
  await expect(page.locator('#golive-result')).toContainText('Go-live readiness');
  await expect(page.locator('#golive-result')).toContainText('Authenticated health test');
  await expect(page.locator('#golive-result')).toContainText('Supabase leaked-password protection');
  await expect(page.locator('#golive-result')).toContainText('Migration drift guard');
  await expect(page.locator('#golive-result')).toContainText('Backup restore confidence');
  await expect(page.locator('#golive-result')).toContainText('Edge function monitoring');
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
    const push = globalThis._pushToSupabase || Function('return typeof _pushToSupabase === "function" ? _pushToSupabase : null')();
    const ok = await push();
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

test('backup restore drill validates and applies a Supabase backup row', async ({ page }) => {
  await openApp(page, '/index.html?e2e=backup-restore');
  await launchSyntheticUser(page, 'admin');

  const result = await page.evaluate(async () => {
    const buildPayload = globalThis._buildPersistedPayload || Function('return typeof _buildPersistedPayload === "function" ? _buildPersistedPayload : null')();
    const restore = globalThis.restoreFromBackup || Function('return typeof restoreFromBackup === "function" ? restoreFromBackup : null')();
    const payload = JSON.parse(JSON.stringify(buildPayload('online')));
    payload.savedAt = '2026-05-01T00:00:00.000Z';
    payload.physicians = [{ id: 99002, first: 'Restored', last: 'Doctor', role: 'DR', fte: 1, active: true }];
    payload.sites = [{ id: 88001, name: 'Restored Site', type: 'DR', active: true }];
    payload.drShifts = [];
    payload.irShifts = [];
    payload.irCalls = [];
    payload.weekendCalls = [];
    payload.holidays = [];
    payload.vacations = [];

    S.physicians = [{ id: 99003, first: 'Current', last: 'Doctor', role: 'DR', fte: 1, active: true }];
    S._lastLocalChange = 0;
    window.__rsMockSupabase.__backupRows.push({
      id: 'main_backup_e2e',
      practice_id: 'main',
      created_at: '2026-05-27T12:00:00.000Z',
      data: JSON.stringify(payload),
    });
    window.confirm = () => true;
    window.alert = msg => { window.__lastAlert = msg; };

    const ok = await restore('main_backup_e2e');
    await new Promise(resolve => setTimeout(resolve, 30));
    const saved = window.__rsMockSupabase.__rows.find(row => row.id === 'main');
    const savedData = saved ? JSON.parse(saved.data) : {};
    return {
      ok,
      alert: window.__lastAlert || '',
      currentFirst: S.physicians[0]?.first || '',
      savedRestoredFromBackup: savedData._restoredFromBackup || '',
      sideAuditRows: window.__rsMockSupabase.__auditRows.filter(row => row.action === 'admin.restoreBackup').length,
    };
  });

  expect(result.ok).toBe(true);
  expect(result.alert).toBe('');
  expect(result.currentFirst).toBe('Restored');
  expect(result.savedRestoredFromBackup).toBe('main_backup_e2e');
  expect(result.sideAuditRows).toBeGreaterThanOrEqual(1);
});

test('audit log dual-writes to the side table and exports canonical rows', async ({ page }) => {
  await openApp(page, '/index.html?e2e=audit');
  await launchSyntheticUser(page, 'admin');

  const auditWrite = await page.evaluate(async () => {
    const audit = globalThis._audit || Function('return typeof _audit === "function" ? _audit : null')();
    audit('e2e.audit.write', { physId: 99001, note: 'side table row' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const sideRows = window.__rsMockSupabase.__auditRows.filter(r => r.action === 'e2e.audit.write');
    const blobRows = S.auditLog.filter(r => r.action === 'e2e.audit.write');
    return {
      sideRows: sideRows.length,
      blobRows: blobRows.length,
      action: sideRows[0]?.action || '',
      practiceId: sideRows[0]?.practice_id || '',
    };
  });

  expect(auditWrite.sideRows).toBe(1);
  expect(auditWrite.blobRows).toBe(1);
  expect(auditWrite.action).toBe('e2e.audit.write');
  expect(auditWrite.practiceId).toBe('main');

  await openToolsOps(page);
  await page.evaluate(() => {
    const render = globalThis.renderAuditLog || Function('return typeof renderAuditLog === "function" ? renderAuditLog : null')();
    render();
  });
  await expect(page.locator('#al-result')).toContainText('side table');
  await expect(page.locator('#al-result')).toContainText('e2e.audit.write');

  const exportRows = await page.evaluate(async () => {
    const rowsForExport = globalThis._auditRowsForExport || Function('return typeof _auditRowsForExport === "function" ? _auditRowsForExport : null')();
    return rowsForExport();
  });
  expect(exportRows.some(row => row.action === 'e2e.audit.write')).toBe(true);
});
