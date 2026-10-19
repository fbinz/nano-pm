// Test fixtures for the nano-pm Playwright suite.
//
//   * `appPage`  — a Page already logged in as `demo` and parked at `/`.
//                  Before each test the DB is reset to the seeded state via
//                  the test-only `/__reset__/` endpoint on its worker's server,
//                  so every test starts
//                  from the same 3-projects-3-teams-8-tasks-6-deps-2-task-milestones fixture.

const { test: base, expect } = require('@playwright/test');
const { startWorkerServer } = require('../server');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

let workerEnvironment;
function djangoEnv(overrides = {}) {
  if (!workerEnvironment) throw new Error('This helper requires the workerServer fixture');
  return { ...workerEnvironment, ...overrides };
}

async function reset(request) {
  const r = await request.post('/__reset__/');
  if (!r.ok()) throw new Error(`reset failed: ${r.status()}`);
}

// Retry the initial navigation once. Django's runserver multithreading
// occasionally drops the very first request after a /__reset__/ cycle —
// reproduces under load (~1 in 40 tests) and never reproduces in isolation.
// Cheap to retry; expensive to debug deeper for a dev-only server.
async function gotoWithRetry(page, url) {
  try {
    await page.goto(url);
  } catch (e) {
    if (!/Timeout|net::ERR/.test(String(e))) throw e;
    await page.goto(url);
  }
}

// Keep the real login view, CSRF checks and browser session cookies, but avoid
// loading and driving the login page for every unrelated behavioral test.
async function login(page) {
  const form = await page.request.get('/accounts/login/');
  if (form.status() !== 200) throw new Error(`Login form failed: ${form.status()}`);
  const csrf = (await form.text()).match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('Login form is missing a CSRF token');
  const response = await page.request.post('/accounts/login/', {
    form: { username: 'demo', password: 'demo', csrfmiddlewaretoken: csrf },
    headers: { Referer: form.url() },
    maxRedirects: 0,
  });
  if (response.status() !== 302 || response.headers().location !== '/') {
    throw new Error(`Login failed: ${response.status()}`);
  }
  await gotoWithRetry(page, '/');
}

// Authentication-specific tests still exercise the actual form in the browser.
async function loginThroughUI(page) {
  await gotoWithRetry(page, '/accounts/login/');
  await page.fill('input[name=username]', 'demo');
  await page.fill('input[name=password]', 'demo');
  await page.click('button[type=submit]');
  await page.waitForURL('/');
}

const test = base.extend({
  workerServer: [async ({}, use) => {
    const server = await startWorkerServer();
    const previousDatabase = process.env.DJANGO_DB_PATH;
    workerEnvironment = server.env;
    // Raw SQLite subprocesses inherit the same worker-local database too.
    process.env.DJANGO_DB_PATH = server.env.DJANGO_DB_PATH;
    try { await use(server); }
    finally {
      workerEnvironment = undefined;
      if (previousDatabase === undefined) delete process.env.DJANGO_DB_PATH;
      else process.env.DJANGO_DB_PATH = previousDatabase;
      await server.stop();
    }
  }, { scope: 'worker', timeout: 90000 }],
  baseURL: async ({ workerServer }, use) => { await use(workerServer.url); },
  _serverLogs: [async ({ workerServer }, use, testInfo) => {
    await use();
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('django-server.log', { body: workerServer.logs(), contentType: 'text/plain' });
    }
  }, { auto: true }],
  // Diagnostic persona screenshots must provision their own users, not depend
  // on a preceding test or a manually populated development database.
  personaPage: async ({ page }, use) => {
    await reset(page.request);
    await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'populate_demo'], {
      cwd: path.resolve(__dirname, '../..'), env: djangoEnv(),
    });
    await use(page);
  },
  appPage: async ({ page, request }, use) => {
    await reset(request);
    await login(page);
    await use(page);
  },
});

module.exports = { test, expect, reset, login, loginThroughUI, djangoEnv };
