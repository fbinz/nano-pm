# E2E test performance

## Current setup

`e2e/playwright.config.js` enables test-level parallelism with up to four
workers, capped by the available CPU count. Each worker provisions its own
Django server and temporary `worker.e2e.sqlite3` through the shared fixtures.

`e2e/serve.py` binds Django's threaded WSGI server directly to port zero, so the
OS allocates and reserves a free port atomically. It uses Django's usual static
handler in debug mode and WhiteNoise in production mode. There is no shared
server, fixed port, or repository-root test database.

The worker still runs real migrations, resets data before each test, and
exercises the normal views, middleware, CSRF checks, password validators, and
session cookies. Its server selects `DJANGO_SETTINGS_MODULE=config.settings_e2e`.

Only password hashing changes: throwaway test users use Django's MD5 hasher,
not production-strength PBKDF2. The dedicated settings module refuses to load
unless debug, test-reset, insecure-seed opt-ins, and an explicitly named
`.e2e.sqlite3` database are configured. **Never use these settings with real
accounts.** Normal `config.settings` is unchanged.

`login(page)` in `e2e/tests/fixtures.js` fetches the real login form through
`page.request`, submits its CSRF token and credentials, then navigates the browser
to `/`. The request context shares the browser's cookie jar. There is no special
authentication bypass or persistent shared login state.

`loginThroughUI(page)` preserves browser form coverage for authentication tests.
The password-change tests also exercise invalid credentials, password validation,
session preservation, and subsequent browser login.

## Measurements

Local measurements on the same machine, using a temporary migrated SQLite
database (median of three runs):

| Operation | Normal hashing | Test-only hashing |
| --- | ---: | ---: |
| Reseed | 1,043 ms | 25 ms |
| Password hashing inside reseed | 1,014 ms | negligible |
| Login POST | 221 ms | 3 ms |

A representative 10-test Playwright subset, including startup, workload
interactions, profile password changes, browser login, theme, People navigation,
and project completion, went from **36.6 s to 20.8 s** (about **43% faster**).
Both runs passed all 10 tests. This is a subset comparison, not a full-suite
speedup claim, and individual timings will vary.

With fast hashing and API login but still serial execution, the full behavioral
spec passed **283 tests in 6 min 59 s**, with no failures, skips, or retries.
A complete pre-optimization behavioral run was not measured.

With four isolated workers, the behavioral spec passed **284 tests in 2 min 05 s**
(including the added two-server isolation regression): about **3.3× faster** than
the serial fast-hashing/API-login run. Server startup and migrations are included.
The complete suite, including screenshots and production static-asset coverage,
passed **302 tests in 2 min 17 s** with four workers and no failures, skips, or retries.

Reproduce the original subset comparison with:

```sh
cd e2e
npx playwright test tests/nano-pm.spec.js --grep 'workload check-in opens empty|workload check-in previous-value|workload save confirmation|workload settings switches|profile password changes|demo / demo logs in|theme toggle switches|sidebar nav People link|marking a project complete'
```

## Parallel execution and debugging

```sh
just e2e                          # up to four independent workers
just e2e --workers=2              # limit CPU/memory consumption
just e2e --workers=1 --grep 'title' # serial debugging
```

Use `test` from `e2e/tests/fixtures.js` for anything that needs Django. Its
`baseURL` fixture routes browser contexts and API requests to that worker's
server. The `workerServer` fixture also exposes the URL and environment when
needed. Changing the worker count does not change test data isolation. Failed tests
attach the worker's recent Django logs to their Playwright artifacts.

Persona/sidebar diagnostic screenshots use `personaPage`, which resets and
populates Alice/Bob data in the worker-local database before each case instead
of relying on a manually populated database.

Use `djangoEnv()` for management-command subprocesses. Raw SQLite subprocesses
must read `os.environ['DJANGO_DB_PATH']`; the fixture exports the worker's path
in its own Node process environment. Never hardcode the old `db.e2e.sqlite3`
filename or a server port. Each worker/retry receives a fresh temporary directory.

`startServer(env, { initialize: false })` can launch a secondary server on the
same worker-local database without rerunning migrations or wiping its current
data. The production-asset regression uses this with its own temporary static
root and production settings. `startWorkerServer()` instead creates a completely
separate database, migrates, and seeds it. Both expose an idempotent `stop()`;
always call it in `finally` for manually created servers. Fixture teardown stops
the entire uv/Python process group before removing the temporary database.

The isolation regression starts two servers and resets each database in turn,
checking that the other server's session and saved profile remain intact.

## Test-purpose review

See [the slow-test audit](e2e-test-audit.md) for the first runtime-ordered review
of the 40 slowest cases, assertion-preserving consolidations, measured subset
results, and remaining mixed-purpose candidates. The first pass reduces the
browser suite from 302 to 299 cases while expanding deterministic payload
coverage; it does not remove the real contention integrations.

## Remaining work

Continue the runtime-ordered purpose audit before optimizing individual waits.
Keep deliberate delays in contention and delayed-module tests: they reproduce
real failure modes. Do not shorten timeouts or remove resets to make the suite
appear faster.
