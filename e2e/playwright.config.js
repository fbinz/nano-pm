// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 8765;
const BASE_URL = `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  // Tests share one Django process, so run serially. Each test resets to seed
  // before mutating, so even serial ordering is forgiving.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    actionTimeout: 8000,
    navigationTimeout: 15000,
  },
  webServer: {
    // Migrate + seed once, then start the dev server.
    command:
      `cd .. && ` +
      `uv run --project . python src/manage.py migrate --noinput && ` +
      `uv run --project . python src/manage.py seed_data && ` +
      `uv run --project . python src/manage.py runserver ${PORT} --noreload`,
    url: BASE_URL + '/accounts/login/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
