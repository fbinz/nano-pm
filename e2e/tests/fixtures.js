// Test fixtures for the nano-pm Playwright suite.
//
//   * `appPage`  — a Page already logged in as `demo` and parked at `/`.
//                  Before each test the DB is reset to the seeded state via
//                  the DEBUG-only `/__reset__/` endpoint, so every test starts
//                  from the same 3-projects-8-tasks-6-deps-2-milestones fixture.

const { test: base, expect } = require('@playwright/test');

async function reset(request) {
  const r = await request.post('/__reset__/');
  if (!r.ok()) throw new Error(`reset failed: ${r.status()}`);
}

async function login(page) {
  await page.goto('/accounts/login/');
  await page.fill('input[name=username]', 'demo');
  await page.fill('input[name=password]', 'demo');
  await page.click('button[type=submit]');
  await page.waitForURL('/');
}

const test = base.extend({
  appPage: async ({ page, request }, use) => {
    await reset(request);
    await login(page);
    await use(page);
  },
});

module.exports = { test, expect, reset, login };
