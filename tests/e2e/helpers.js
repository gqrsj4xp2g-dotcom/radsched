const { expect } = require('@playwright/test');

const SUPABASE_HOST = 'https://tpbgwvisikbuqhmlqtky.supabase.co';

async function installNetworkMocks(page) {
  await page.route(`${SUPABASE_HOST}/auth/v1/token**`, route => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }),
  }));
  await page.route(`${SUPABASE_HOST}/rest/v1/**`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: route.request().method() === 'GET' ? '[]' : '{}',
  }));
  await page.route(`${SUPABASE_HOST}/functions/v1/**`, route => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Expected without credentials' }),
  }));
}

async function openApp(page, path = '/index.html?e2e=1', options = {}) {
  await installNetworkMocks(page);
  if (!options.serviceWorker) {
    await page.addInitScript(() => {
      window.__RS_E2E_DISABLE_SW = true;
    });
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.launchApp === 'function' && typeof window.renderSystemHealth === 'function');
}

async function installSyntheticSupabase(page, { session = null, aal = 'aal2', mfaFactors = null } = {}) {
  await page.evaluate(({ session, aal, mfaFactors }) => {
    const mockRows = [];
    const mockAuditRows = [];
    const mockBackupRows = [];
    const mockTelemetryRows = [];
    let currentAal = aal || 'aal2';
    const factors = mfaFactors || [{ id: 'e2e-totp', factor_type: 'totp', status: 'verified' }];
    const rowsFor = tableName => {
      if (tableName === 'radscheduler_audit') return mockAuditRows;
      if (tableName === 'radscheduler_backups') return mockBackupRows;
      if (tableName === 'radscheduler_telemetry') return mockTelemetryRows;
      if (tableName === 'radscheduler') return mockRows;
      return [];
    };
    const replaceById = (store, row) => {
      if (!row || row.id === undefined || row.id === null) {
        store.push(row);
        return;
      }
      const idx = store.findIndex(existing => String(existing?.id) === String(row.id));
      if (idx >= 0) store[idx] = { ...store[idx], ...row };
      else store.push(row);
    };
    const makeQuery = initialRows => {
      let rows = (initialRows || []).slice();
      const api = {
        eq(column, value) {
          rows = rows.filter(row => String(row?.[column]) === String(value));
          return api;
        },
        order(column, opts = {}) {
          rows = rows.slice().sort((a, b) => {
            const av = a?.[column] || '';
            const bv = b?.[column] || '';
            return opts.ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
          });
          return api;
        },
        limit: async n => ({ data: rows.slice(0, n), error: null }),
        single: async () => ({ data: rows[0] || null, error: rows[0] ? null : { message: 'mocked no row' } }),
        maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      };
      return api;
    };
    const tableApi = tableName => ({
      select() {
        return makeQuery(rowsFor(tableName));
      },
      order: async () => ({ data: [], error: null }),
      limit: async () => ({ data: [], error: null }),
      insert: async payload => {
        const rows = Array.isArray(payload) ? payload : [payload];
        rowsFor(tableName).push(...rows);
        return { data: payload, error: null };
      },
      upsert: async payload => {
        const rows = Array.isArray(payload) ? payload : [payload];
        const store = rowsFor(tableName);
        rows.forEach(row => replaceById(store, row));
        return { data: payload, error: null };
      },
      delete() {
        return {
          eq: async (column, value) => {
            const store = rowsFor(tableName);
            for (let i = store.length - 1; i >= 0; i--) {
              if (String(store[i]?.[column]) === String(value)) store.splice(i, 1);
            }
            return { data: null, error: null };
          },
        };
      },
    });
    const mock = {
      __rows: mockRows,
      __auditRows: mockAuditRows,
      __backupRows: mockBackupRows,
      __telemetryRows: mockTelemetryRows,
      from(tableName) {
        return tableApi(tableName);
      },
      channel() {
        return {
          on() { return this; },
          subscribe() { return this; },
        };
      },
      removeChannel: async () => {},
      auth: {
        getSession: async () => ({ data: { session }, error: null }),
        refreshSession: async () => ({ data: { session }, error: null }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: currentAal, nextLevel: 'aal2' },
            error: null,
          }),
          listFactors: async () => ({
            data: { totp: factors.filter(f => (f.factor_type || 'totp') === 'totp') },
            error: null,
          }),
          challenge: async ({ factorId }) => ({
            data: { id: `challenge-${factorId || 'factor'}` },
            error: null,
          }),
          verify: async ({ code }) => {
            if (code !== '123456') return { data: null, error: { message: 'Invalid MFA code' } };
            currentAal = 'aal2';
            return { data: { access_token: 'mock-token' }, error: null };
          },
          enroll: async () => ({
            data: {
              id: 'e2e-enrolled',
              type: 'totp',
              totp: { qr_code: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', secret: 'E2ESECRET' },
            },
            error: null,
          }),
        },
      },
    };
    mock.__setAal = next => { currentAal = next; };
    window.__rsMockSupabase = mock;
    _supabase = mock;
    _initSupabase = () => mock;
    _initAuthClient = () => mock;
    doLogout = async () => {};
    _pullFromSupabase = async () => null;
    _initLeaderElection = () => {};
    _initPresence = () => {};
    _startAutoRefreshTrafficLoop = () => {};
    _bootOnCallReminders = () => {};
    fsTryRestoreAutosave = () => {};
    _runDailyBackupIfDue = () => {};
  }, { session, aal, mfaFactors });
}

async function launchSyntheticUser(page, role = 'superuser', options = {}) {
  await installSyntheticSupabase(page, options);
  await page.evaluate(async role => {
    const fallback = { id: 'e2e-user', email: 'e2e@example.com', role, first: 'E2E', last: 'User', practiceId: 'main' };
    const base = (USERS || []).find(u => u.role === role) || (USERS || [])[0] || fallback;
    CU = { ...base, role, first: base.first || 'E2E', last: base.last || 'User', practiceId: 'main' };
    _ROW_ID = 'main';
    _PRACTICE_ID = 'main';
    _PRACTICES = [{ id: 'main', name: 'E2E Practice' }];
    const launch = globalThis.launchApp || Function('return typeof launchApp === "function" ? launchApp : null')();
    launch._running = false;
    await launch();
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    const privileged = role === 'admin' || role === 'superuser';
    document.querySelectorAll('.admin-only').forEach(el => {
      if (el.classList.contains('page')) {
        el.style.display = privileged ? '' : 'none';
      } else {
        el.style.display = privileged ? 'block' : 'none';
      }
    });
  }, role);
}

async function openToolsOps(page) {
  await page.evaluate(() => {
    const getFn = name => globalThis[name] || Function(`return typeof ${name} === "function" ? ${name} : null`)();
    const fallback = { id: 'e2e-user', email: 'e2e@example.com', role: 'superuser', first: 'E2E', last: 'User', practiceId: 'main' };
    const base = (USERS || [])[0] || fallback;
    localStorage.setItem('rs.toolsTab', 'ops');

    CU = { ...base, role: 'superuser', first: base.first || 'E2E', last: base.last || 'User', practiceId: 'main' };
    _ROW_ID = 'main';
    _PRACTICE_ID = 'main';
    _PRACTICES = [{ id: 'main', name: 'E2E Practice' }];

    const renderHealth = getFn('renderSystemHealth');
    const auth = document.getElementById('auth');
    const app = document.getElementById('app');
    if (auth) auth.style.display = 'none';
    if (app) app.style.display = 'flex';
    document.querySelectorAll('.page').forEach(page => {
      page.classList.remove('on');
      page.style.display = 'none';
    });
    const pageTools = document.getElementById('page-tools');
    if (pageTools) {
      pageTools.classList.add('on');
      pageTools.style.display = '';
      pageTools.setAttribute('data-active-tab', 'ops');
      pageTools.querySelectorAll('[data-tools-tab]').forEach(card => {
        card.style.display = card.getAttribute('data-tools-tab') === 'ops' ? '' : 'none';
      });
    }
    document.querySelectorAll('.snav-item').forEach(item => {
      item.classList.toggle('on', item.getAttribute('data-pg') === 'tools');
    });
    document.querySelectorAll('#tools-subnav .tab').forEach(tab => {
      tab.classList.toggle('on', tab.getAttribute('data-tt') === 'ops');
    });
    renderHealth(true);
  });
  await expect(page.locator('#page-tools')).toBeVisible();
  await expect(page.locator('#sys-health-result')).toBeVisible();
}

module.exports = {
  installNetworkMocks,
  installSyntheticSupabase,
  launchSyntheticUser,
  openApp,
  openToolsOps,
};
