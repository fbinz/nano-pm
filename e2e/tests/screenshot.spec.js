// Diagnostic-only: snapshot the seeded chart so we can eyeball the rendering.
const { test, login, reset } = require('./fixtures');

test('screenshot the seeded gantt view', async ({ page, request }) => {
  await reset(request);
  await login(page);
  // Wait for chart geometry to settle.
  await page.waitForSelector('.bar');
  await page.waitForTimeout(200);
  await page.screenshot({
    path: 'screenshots/gantt-default.png',
    fullPage: false,
  });
  // Also a wider viewport — useful to see arrows on cross-project deps.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(200);
  await page.screenshot({
    path: 'screenshots/gantt-wide.png',
    fullPage: false,
  });
});
