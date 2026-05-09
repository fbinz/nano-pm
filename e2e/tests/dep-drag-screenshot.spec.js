// Diagnostic-only — capture the live dep-drag preview.
const { test, login, reset } = require('./fixtures');

test('dep-handle live drag preview', async ({ page, request }) => {
  await reset(request);
  await login(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForSelector('.bar');
  const from = page.locator('.bar', { hasText: 'A/B test setup' });
  await from.hover();
  const fromBox = await from.boundingBox();
  await page.mouse.move(fromBox.x + fromBox.width + 6, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // Drop the cursor near (but not on) another bar, capturing mid-drag.
  await page.mouse.move(fromBox.x + 480, fromBox.y - 120, { steps: 8 });
  await page.waitForSelector('#dep-drag path[d]');
  await page.screenshot({ path: 'screenshots/dep-drag-live.png' });
  await page.mouse.up();
});
