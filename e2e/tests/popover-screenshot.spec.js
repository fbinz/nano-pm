// Diagnostic-only — capture popovers so we can eyeball positioning.
const { test, login, reset } = require('./fixtures');

test('popover positioning snapshots', async ({ page, request }) => {
  await reset(request);
  await login(page);
  await page.waitForSelector('.bar');

  // 1) Click a bar near the middle of the chart and snapshot.
  const bar = page.locator('.bar', { hasText: 'Migrate /users endpoints' });
  await bar.click();
  await page.waitForSelector('#task-popover');
  await page.screenshot({ path: 'screenshots/popover-task-mid.png' });

  // Close it and try a project header click.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.locator('.left-cell.proj', { hasText: 'API Migration' }).click();
  await page.waitForSelector('#project-popover');
  await page.screenshot({ path: 'screenshots/popover-project.png' });
});
