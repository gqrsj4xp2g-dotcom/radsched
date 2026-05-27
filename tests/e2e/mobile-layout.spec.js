const { test, expect } = require('@playwright/test');
const { openApp, launchSyntheticUser, openToolsOps } = require('./helpers');

test.use({
  viewport: { width: 390, height: 900 },
  isMobile: true,
});

test('Tools System Health has no horizontal overflow on mobile', async ({ page }) => {
  await openApp(page, '/index.html?e2e=mobile-health');
  await launchSyntheticUser(page, 'superuser');
  await openToolsOps(page);
  await page.evaluate(() => {
    window.renderSystemHealth(true);
    document.getElementById('sys-health-result')?.scrollIntoView({ block: 'start' });
  });

  await expect(page.locator('#sys-health-result')).toContainText('Quick health');

  const layout = await page.evaluate(() => {
    const sidebar = getComputedStyle(document.querySelector('.sidebar'));
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      sidebarPosition: sidebar.position,
      activeTab: document.getElementById('page-tools')?.getAttribute('data-active-tab'),
    };
  });

  expect(layout.activeTab).toBe('ops');
  expect(layout.sidebarPosition).toBe('fixed');
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 2);
  expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.clientWidth + 2);
});
