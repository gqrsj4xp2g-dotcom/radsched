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

async function openApp(page, path = '/index.html?e2e=1') {
  await installNetworkMocks(page);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.launchApp === 'function' && typeof window.renderSystemHealth === 'function');
}

async function installSyntheticSupabase(page, { session = null } = {}) {
  await page.evaluate(({ session }) => {
    const mockRows = [];
    const queryResult = async () => ({ data: null, error: { message: 'mocked no row' } });
    const tableApi = {
      select() {
        return {
          order: async () => ({ data: [], error: null }),
          limit: async () => ({ data: [], error: null }),
          eq() {
            return {
              single: queryResult,
              maybeSingle: queryResult,
              order: async () => ({ data: [], error: null }),
              limit: async () => ({ data: [], error: null }),
            };
          },
        };
      },
      order: async () => ({ data: [], error: null }),
      limit: async () => ({ data: [], error: null }),
      upsert: async payload => {
        mockRows.push(payload);
        return { data: payload, error: null };
      },
      delete() {
        return {
          eq: async () => ({ data: null, error: null }),
        };
      },
    };
    const mock = {
      __rows: mockRows,
      from() {
        return tableApi;
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
      },
    };
    window.__rsMockSupabase = mock;
    _supabase = mock;
    _initSupabase = () => mock;
    _initAuthClient = () => mock;
    _pullFromSupabase = async () => null;
    _initLeaderElection = () => {};
    _initPresence = () => {};
    _startAutoRefreshTrafficLoop = () => {};
    _bootOnCallReminders = () => {};
    fsTryRestoreAutosave = () => {};
    _runDailyBackupIfDue = () => {};
  }, { session });
}

async function launchSyntheticUser(page, role = 'superuser') {
  await installSyntheticSupabase(page);
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
