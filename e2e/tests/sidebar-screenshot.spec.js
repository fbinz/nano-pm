// Diagnostic — capture the sidebar at rest and after horizontal/vertical scroll.
const { test } = require('./fixtures');

async function loginAs(page, who) {
  await page.goto('/accounts/login/');
  await page.fill('input[name=username]', who);
  await page.fill('input[name=password]', who);
  await page.click('button[type=submit]');
  await page.waitForURL('/');
}

test('sidebar after horizontal scroll', async ({ page }) => {
  await loginAs(page, 'alice');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForSelector('.bar');
  await page.evaluate(() => {
    document.getElementById('grid-scroll').scrollLeft = 600;
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'screenshots/sidebar-scrolled-h.png' });
});

test('sidebar after vertical scroll', async ({ page }) => {
  await loginAs(page, 'alice');
  await page.setViewportSize({ width: 1400, height: 600 });
  await page.waitForSelector('.bar');
  await page.evaluate(() => {
    document.getElementById('grid-scroll').scrollTop = 200;
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'screenshots/sidebar-scrolled-v.png' });
});

test('sidebar after extreme horizontal scroll', async ({ page }) => {
  await loginAs(page, 'alice');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForSelector('.bar');
  await page.evaluate(() => {
    const sc = document.getElementById('grid-scroll');
    sc.scrollLeft = sc.scrollWidth - sc.clientWidth;
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'screenshots/sidebar-scrolled-h-far.png' });
});

test('sidebar at day zoom + scrolled', async ({ page }) => {
  await loginAs(page, 'alice');
  await page.goto('/?zoom=day');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForSelector('.bar');
  await page.evaluate(() => {
    document.getElementById('grid-scroll').scrollLeft = 1500;
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'screenshots/sidebar-day-zoom.png' });
});
