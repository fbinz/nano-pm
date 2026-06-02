// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 8766;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = 'db.e2e.sqlite3';

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
    // 30s matches Playwright's default. Earlier 15s cap caught a Django
    // runserver hiccup (very first request after /__reset__/ occasionally
    // takes ~17s on a loaded box) — fixture has its own retry too.
    navigationTimeout: 30000,
  },
  webServer: {
    // Migrate + seed once, then start the dev server.
    command:
      `cd .. && ` +
      `uv run --project . python src/manage.py migrate --noinput && ` +
      `uv run --project . python src/manage.py seed_data && ` +
      `uv run --project . python src/manage.py runserver ${PORT} --noreload`,
    url: BASE_URL + '/accounts/login/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      // Required by settings.py — DEBUG for static-file serving in
      // runserver, ENABLE_TEST_RESET so the suite's /__reset__/ fixture
      // endpoint is mounted, ALLOW_INSECURE_SEED so seed_data (run before
      // the server starts and on every /__reset__/ call) accepts the
      // demo/demo credentials the suite logs in with.
      DJANGO_DEBUG: 'true',
      DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      DJANGO_ENABLE_TEST_RESET: 'true',
      DJANGO_ALLOW_INSECURE_SEED: 'true',
      DJANGO_DB_PATH: TEST_DB_PATH,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
