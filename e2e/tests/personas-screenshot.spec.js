// Diagnostic: confirm alice + bob personas render and screenshot each.
const { test } = require('./fixtures');

async function loginAs(page, who) {
  await page.goto('/accounts/login/');
  await page.fill('input[name=username]', who);
  await page.fill('input[name=password]', who);
  await page.click('button[type=submit]');
  await page.waitForURL('/');
}

test('alice persona renders', async ({ page }) => {
  await loginAs(page, 'alice');
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForSelector('.bar');
  await page.screenshot({ path: 'screenshots/persona-alice.png' });
});

test('bob persona renders', async ({ page }) => {
  await loginAs(page, 'bob');
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForSelector('.bar');
  await page.screenshot({ path: 'screenshots/persona-bob.png' });
});
