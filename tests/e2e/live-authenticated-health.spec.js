const { test, expect } = require('@playwright/test');

test('real authenticated superuser deep System Health is clean enough for go-live', async ({ page }) => {
  test.skip(process.env.RAD_E2E_LIVE !== '1', 'Set RAD_E2E_LIVE=1 plus RAD_E2E_EMAIL/RAD_E2E_PASSWORD to run live authenticated health.');
  test.skip(!process.env.RAD_E2E_EMAIL || !process.env.RAD_E2E_PASSWORD, 'Live credentials were not provided.');

  await page.goto('/index.html?e2e=live-health', { waitUntil: 'domcontentloaded' });
  await page.fill('#li-email', process.env.RAD_E2E_EMAIL);
  await page.fill('#li-pw', process.env.RAD_E2E_PASSWORD);
  await page.locator('#af-login .abtn').click();

  await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    localStorage.setItem('rs.toolsTab', 'ops');
    const navFn = globalThis.nav || Function('return typeof nav === "function" ? nav : null')();
    navFn('tools', document.querySelector('.snav-item[data-pg="tools"]'), 'ops');
  });
  await page.getByRole('button', { name: '▶ Run health check' }).click();
  await expect(page.locator('#sys-health-result')).toContainText('System health');
  await expect(page.locator('#sys-health-result')).toContainText('Auth session');
  await expect(page.locator('#sys-health-result')).toContainText('Practice data row');

  const text = await page.locator('#sys-health-result').innerText();
  expect(text).not.toMatch(/\b[1-9]\d* fail\b/);
});
