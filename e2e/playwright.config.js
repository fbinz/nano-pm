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
    env: {
      // Required by settings.py — DEBUG for static-file serving in
      // runserver, ENABLE_TEST_RESET so the suite's /__reset__/ fixture
      // endpoint is mounted.
      DJANGO_DEBUG: 'true',
      DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      DJANGO_ENABLE_TEST_RESET: 'true',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
