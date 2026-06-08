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

test('dashboard shows role-aware home panel', async ({ page }) => {
  await openApp(page, '/index.html?e2e=role-home');
  await launchSyntheticUser(page, 'admin');

  await page.evaluate(() => {
    S.openShifts = [{ id: 990, date: '2026-05-28', shiftType: '1st', claimedBy: null }];
    S.swapRequests = [{ id: 991, status: 'pending' }];
    const render = globalThis.renderDash || Function('return typeof renderDash === "function" ? renderDash : null')();
    render();
  });

  await expect(page.locator('#dash-role-home')).toContainText('Operations snapshot');
  await expect(page.locator('#dash-role-home')).toContainText('Open shifts');
  await expect(page.locator('#dash-role-home')).toContainText('Pending swaps');
});

test('dashboard fairness and equity use category-specific FTE pools', async ({ page }) => {
  await openApp(page, '/index.html?e2e=fairness-equity');
  await launchSyntheticUser(page, 'admin');

  const result = await page.evaluate(() => {
    const today = fmtDate(new Date());
    const future = n => addDays(today, n);
    const yr = new Date().getFullYear();
    S.physicians = [
      { id: 1, first: 'Dana', last: 'DR Full', role: 'DR', drFte: 1, irFte: 0, irGroup: null, active: true },
      { id: 2, first: 'Henry', last: 'DR Half', role: 'DR', drFte: 0.5, irFte: 0, irGroup: null, active: true },
      { id: 3, first: 'Iris', last: 'IR Full', role: 'IR', drFte: 0, irFte: 1, irGroup: 'North', active: true },
      { id: 4, first: 'Nia', last: 'IR Half', role: 'IR', drFte: 0, irFte: 0.5, irGroup: 'North', active: true },
    ];
    S.weekendCalls = [
      { id: 101, physId: 1, satDate: future(12), sunDate: future(13) },
      { id: 102, physId: 1, satDate: future(19), sunDate: future(20) },
      { id: 103, physId: 1, satDate: future(26), sunDate: future(27) },
    ];
    S.holidays = [
      { id: 201, physId: 1, name: 'Thanksgiving', year: yr, date: `${yr}-11-26`, group: 'DR' },
      { id: 202, physId: 1, name: 'Thanksgiving', year: yr, date: `${yr}-11-27`, group: 'DR' },
    ];
    S.drShifts = [
      { id: 301, physId: 1, date: `${yr}-03-02`, shift: '2nd' },
      { id: 302, physId: 1, date: `${yr}-03-03`, shift: '2nd' },
      { id: 303, physId: 1, date: `${yr}-03-04`, shift: '2nd' },
      { id: 304, physId: 1, date: future(5), shift: '1st' },
      { id: 305, physId: 1, date: future(6), shift: '1st' },
      { id: 306, physId: 1, date: future(7), shift: '1st' },
    ];
    S.irCalls = [
      { id: 401, physId: 3, date: `${yr}-04-01`, callType: 'daily', irGroup: 'North' },
      { id: 402, physId: 3, date: `${yr}-04-02`, callType: 'daily', irGroup: 'North' },
      { id: 403, physId: 3, date: `${yr}-04-03`, callType: 'daily', irGroup: 'North' },
      { id: 404, physId: 3, date: future(8), callType: 'weekend', irGroup: 'North' },
      { id: 405, physId: 3, date: future(15), callType: 'weekend', irGroup: 'North' },
      { id: 406, physId: 3, date: future(16), callType: 'daily', irGroup: 'North', notes: 'Auto (Holiday)' },
    ];

    _renderFairnessScoreboard(true);
    _renderEquityHeatmap();
    const collect = selector => [...document.querySelectorAll(`${selector} tbody tr`)].map(tr => ({
      name: tr.cells[0].textContent.trim(),
      cells: [...tr.cells].slice(1).map(td => {
        const chip = td.querySelector('span');
        return {
          text: td.textContent.trim(),
          title: chip ? chip.getAttribute('title') : '',
        };
      }),
    }));
    return {
      fairness: collect('#dash-fairness'),
      heatmap: collect('#dash-equity-heatmap'),
    };
  });

  const fairnessDr = result.fairness.find(row => row.name.includes('DR Full'));
  const fairnessIr = result.fairness.find(row => row.name.includes('IR Full'));
  const heatmapDr = result.heatmap.find(row => row.name.includes('DR Full'));
  const heatmapIr = result.heatmap.find(row => row.name.includes('IR Full'));
  expect(fairnessDr).toBeTruthy();
  expect(fairnessIr).toBeTruthy();
  expect(heatmapDr).toBeTruthy();
  expect(heatmapIr).toBeTruthy();

  expect(fairnessDr.cells[0].title).toContain('3 actual vs 2.0 expected (Weekend Call, DR FTE pool)');
  expect(fairnessDr.cells[1].title).toContain('1 actual vs 0.7 expected (Holiday, holiday pool)');
  expect(fairnessDr.cells[2].title).toContain('3 actual vs 2.0 expected (2nd Shift, DR FTE pool)');
  expect(fairnessDr.cells[4].title).toContain('No expected IR Daily Call workload');
  expect(fairnessIr.cells[0].title).toContain('No expected Weekend Call workload');
  expect(fairnessIr.cells[4].title).toContain('3 actual vs 2.0 expected (IR Daily Call, IR group FTE pool)');

  expect(heatmapDr.cells[0].title).toContain('3 actual vs 2.0 expected (DR shifts, next 90d, DR FTE pool)');
  expect(heatmapDr.cells[1].title).toContain('No expected IR call workload');
  expect(heatmapDr.cells[2].title).toContain('3 actual vs 2.0 expected (Weekend, next 90d, DR FTE pool)');
  expect(heatmapIr.cells[0].title).toContain('No expected DR shifts workload');
  expect(heatmapIr.cells[1].title).toContain('2 actual vs 1.3 expected (IR call, next 90d, IR group FTE pool)');
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

test('enterprise readiness writes and renders telemetry evidence', async ({ page }) => {
  await openApp(page, '/index.html?e2e=enterprise');
  await launchSyntheticUser(page, 'superuser');
  await openToolsOps(page);

  await page.getByRole('button', { name: 'Run enterprise check' }).click();
  await expect(page.locator('#enterprise-result')).toContainText('Enterprise readiness');
  await expect(page.locator('#enterprise-result')).toContainText('Privileged MFA');
  await expect(page.locator('#enterprise-result')).toContainText('Security pipeline');
  await expect(page.locator('#enterprise-result')).toContainText('RBAC matrix');
  await expect(page.locator('#enterprise-result')).toContainText('Immutable audit chain');
  await expect(page.locator('#enterprise-result')).toContainText('Telemetry table');

  const telemetryCount = await page.evaluate(() => window.__rsMockSupabase.__telemetryRows.length);
  expect(telemetryCount).toBeGreaterThanOrEqual(1);

  await page.getByRole('button', { name: 'Telemetry events' }).click();
  await expect(page.locator('#enterprise-result')).toContainText('enterprise.readiness_run');

  await page.getByRole('button', { name: 'Ops dashboard' }).click();
  await expect(page.locator('#enterprise-result')).toContainText('Telemetry events');
  await expect(page.locator('#enterprise-result')).toContainText('Audit entries');
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
    window.__lastAdminOpsCall = null;
    window._invokeEdgeFn = async (name, body) => {
      window.__lastAdminOpsCall = { name, body };
      if (name !== 'admin-ops') throw new Error('Unexpected edge function: ' + name);
      const backup = window.__rsMockSupabase.__backupRows.find(row => row.id === body.backupId);
      if (!backup) throw new Error('Mock backup not found');
      const restored = {
        ...JSON.parse(backup.data),
        savedAt: '2026-05-27T12:01:00.000Z',
        _restoredFromBackup: body.backupId,
        _restoredAt: '2026-05-27T12:01:00.000Z',
      };
      const store = window.__rsMockSupabase.__rows;
      const idx = store.findIndex(row => row.id === body.practiceId);
      const nextRow = { id: body.practiceId, data: JSON.stringify(restored) };
      if (idx >= 0) store[idx] = nextRow;
      else store.push(nextRow);
      window.__rsMockSupabase.__auditRows.push({
        practice_id: body.practiceId,
        action: 'admin.restoreBackup',
        detail: { backupId: body.backupId, via: 'admin-ops' },
      });
      return { ok: true, payload: restored, savedAt: restored.savedAt, warnings: [] };
    };

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
      edgeFunctionName: window.__lastAdminOpsCall?.name || '',
      edgeAction: window.__lastAdminOpsCall?.body?.action || '',
    };
  });

  expect(result.ok).toBe(true);
  expect(result.alert).toBe('');
  expect(result.currentFirst).toBe('Restored');
  expect(result.savedRestoredFromBackup).toBe('main_backup_e2e');
  expect(result.sideAuditRows).toBeGreaterThanOrEqual(1);
  expect(result.edgeFunctionName).toBe('admin-ops');
  expect(result.edgeAction).toBe('restore-backup');
});

test('stress-test revert helper opens backup restore picker', async ({ page }) => {
  await openApp(page, '/index.html?e2e=stress-revert-helper');
  await launchSyntheticUser(page, 'admin');

  await page.evaluate(() => {
    window.__rsMockSupabase.__backupRows.push({
      id: 'main_backup_stress_revert_e2e',
      practice_id: 'main',
      created_at: '2026-06-08T12:00:00.000Z',
      data: JSON.stringify({ physicians: [], sites: [], drShifts: [] }),
    });
    const openBackups = globalThis.renderRestoreFromBackups || Function('return typeof renderRestoreFromBackups === "function" ? renderRestoreFromBackups : null')();
    openBackups();
  });

  await expect(page.locator('#page-settings')).toBeVisible();
  await expect(page.locator('#backup-picker')).toContainText('main_backup_stress_revert_e2e');
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
