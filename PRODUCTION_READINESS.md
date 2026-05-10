# Production readiness — open issues

A snapshot of what stands between the current `main` (post-v1 pivot) and a
production deployment. Items are roughly ordered by severity within each
section. Cross-references point at file paths under `src/` unless noted.

The current state is **deployable to CapRover** with the right env vars and
a persistent volume mounted at `/data` (see Deployment & operations below).
The foundational risks (DEBUG, SECRET_KEY, ALLOWED_HOSTS, `/__reset__/`,
password validators, seeded trivial passwords), the deploy plumbing
(gunicorn, whitenoise, Dockerfile, captain-definition, HTTPS-aware settings,
migration step, `/healthz`), supply-chain hygiene (CDN scripts pinned with
SRI), error monitoring (Sentry, opt-in), and SQLite tuning (WAL, IMMEDIATE,
busy_timeout) are all in place. The remaining headline gaps for a *robust*
prod posture are: a backup cron for the SQLite volume, and a CSP.

---

## Critical — fix before any non-local deploy

- [x] **`SECRET_KEY` is hard-coded.** Now read from `DJANGO_SECRET_KEY`;
  startup raises `ImproperlyConfigured` when missing with `DEBUG=False`.
  Dev fallback only applies under `DEBUG=True`.
- [x] **`DEBUG = True` always.** Now defaults to `False`; flipped via
  `DJANGO_DEBUG=true` (set in `justfile` and Playwright's `webServer`).
- [x] **`ALLOWED_HOSTS = ["*"]`.** Now `localhost,127.0.0.1` by default,
  comma-separated `DJANGO_ALLOWED_HOSTS` to override. No wildcard support
  even in DEBUG.
- [x] **`/__reset__/` was DEBUG-gated.** Now URL is mounted **only** when
  `DJANGO_ENABLE_TEST_RESET=true`. With the flag off, the endpoint returns
  404 (not 403), so a misconfigured deploy that leaves `DEBUG=True` doesn't
  expose the wipe.
- [x] **Password validators are disabled.** Django's four default validators
  (`UserAttributeSimilarity`, `MinimumLength`, `CommonPassword`,
  `NumericPassword`) are now enabled. `DJANGO_DISABLE_PASSWORD_VALIDATORS=true`
  turns them off as an escape hatch. Note: validators only run on form-driven
  password changes (admin "set password", `PasswordChangeView`); seed
  commands and `createsuperuser` bypass them via `set_password()`.
- [x] **Seeded accounts use the username as the password.** Both `seed_data`
  and `populate_demo` now refuse to run unless
  `DJANGO_ALLOW_INSECURE_SEED=true` is set. The flag is on in `justfile` and
  the Playwright config; production deploys must leave it unset, which makes
  it impossible to materialise `demo/demo`, `alice/alice`, or `bob/bob`
  without an explicit opt-in. (The `is_staff=True` part was already fixed in
  a prior commit.)
- [x] **HTTPS / proxy hardening — wiring in place; switches must be flipped per deploy.**
  All env-toggleable from `settings.py`:
  - `DJANGO_BEHIND_TLS_PROXY=true` enables `SECURE_PROXY_SSL_HEADER` (set on
    CapRover; nginx forwards `X-Forwarded-Proto`).
  - `DJANGO_SECURE_COOKIES=true` enables `SESSION_COOKIE_SECURE` + `CSRF_COOKIE_SECURE`.
  - `DJANGO_HSTS_SECONDS=<n>` enables HSTS; `DJANGO_HSTS_INCLUDE_SUBDOMAINS`
    and `DJANGO_HSTS_PRELOAD` are separate opt-ins.
  - `DJANGO_SSL_REDIRECT=true` enables `SECURE_SSL_REDIRECT` — usually NOT
    needed on CapRover (the proxy already redirects); turning it on without
    `BEHIND_TLS_PROXY` will create a redirect loop.
- [x] **Security headers.** `SECURE_CONTENT_TYPE_NOSNIFF=True` and
  `SECURE_REFERRER_POLICY="same-origin"` are on unconditionally — verified
  via `curl -I` against the running container. `X_FRAME_OPTIONS` is Django's
  default `DENY`.
- [x] **JS deps vendored locally.** Floating UI (core + dom UMD) and
  Datastar 1.0.0-RC.7 are checked in under `src/static/vendor/`, served by
  whitenoise at `/static/vendor/<file>.<hash>.js` thanks to
  `CompressedManifestStaticFilesStorage`. No CDN dependency, no SRI needed
  (same-origin), and a future `script-src 'self'` CSP just works without a
  `cdn.jsdelivr.net` allowance. Upgrade procedure documented in the
  template's `{% comment %}` block. Datastar's `sourceMappingURL` comment
  was stripped (170KB map not worth shipping for a dep we don't debug).
- [ ] **No CSP.** With Datastar inline-evaluating expressions and Floating
  UI, you'll need a `script-src` that allows the CDN origins (or vendored
  paths) plus `'unsafe-inline'` for `data-init`/`data-on:` (Datastar uses
  inline-style expressions, not real inline scripts — but verify). Use
  `django-csp` to define a policy, then deal with violations.

## Auth & account flows

User management (create, password change, deactivate, role assignment)
happens **only via Django admin** at `/admin/`. No self-serve flows are
planned — registration, password reset, email verification, and
password-change-from-UI are intentionally out of scope. An admin (a real
superuser created via `manage.py createsuperuser`) handles all of it.

- [x] **`is_staff=True` on seeded accounts.** Removed from `seed_data` and
  `populate_demo`; existing dev-DB users updated. Seeded users are now
  regular users with no admin access.
- [ ] **`/admin/` is at the predictable default URL.** Low-priority hardening:
  consider relocating to `/{secret-slug}/admin/` (set via env) so casual
  scanners don't probe it. The admin is already gated by Django auth, so
  this is defence-in-depth rather than a real vulnerability.
- [x] **No password-strength enforcement when an admin sets a password.**
  Resolved alongside the Critical section's password-validator item — the
  admin's "set password" form runs Django's four default validators.

## Deployment & operations

- [x] **Production WSGI server.** `gunicorn` is a runtime dep, invoked from
  the Dockerfile CMD: `gunicorn config.wsgi:application --chdir src --bind
  0.0.0.0:${PORT} --workers 2 --threads 4`. Re-tune workers/threads only
  after the SQLite bottleneck is gone.
- [x] **Static files via whitenoise.** `WhiteNoiseMiddleware` sits after
  `SecurityMiddleware`; `STORAGES.staticfiles` is
  `CompressedManifestStaticFilesStorage`; the Dockerfile runs `collectstatic
  --noinput --clear` at build time so the image ships ready-to-serve.
  `STATIC_ROOT` defaults to `<repo>/staticfiles`; `DJANGO_STATIC_ROOT`
  overrides.
- [x] **Deployment artifacts (CapRover).** `Dockerfile` (multi-stage uv
  build), `captain-definition` (schema v2 → Dockerfile), and `.dockerignore`
  are at the repo root. **First-deploy checklist** in CapRover UI:
  1. App Configs → Environmental Variables — set `DJANGO_SECRET_KEY`,
     `DJANGO_ALLOWED_HOSTS=<your-domain>`, `DJANGO_BEHIND_TLS_PROXY=true`,
     `DJANGO_SECURE_COOKIES=true`, `DJANGO_HSTS_SECONDS=3600` (ramp up
     later), `SENTRY_DSN=<from sentry.io>`, `SENTRY_ENVIRONMENT=prod`.
  2. App Configs → Persistent Directories — map host path → `/data` so the
     SQLite DB survives redeploys. **Without this, all data is wiped on every
     deploy.**
  3. App Configs → Health Check Path — set to `/healthz`.
  4. HTTP Settings — enable HTTPS + force HTTPS redirect (proxy-level).
  5. Deploy. The CMD runs `migrate --noinput` before booting gunicorn.
- [x] **SQLite write contention.** Tuned in `settings.py`:
  `journal_mode=WAL` (readers never block writers), `busy_timeout=5000`
  (writers queue up to 5s instead of erroring), `transaction_mode=IMMEDIATE`
  (Django 5.1+ — write lock taken at BEGIN, no mid-transaction upgrades),
  plus `synchronous=NORMAL`, `temp_store=MEMORY`, `mmap_size=128MiB`,
  `cache_size=64MiB`. Verified live in the running container. Realistic
  edits don't queue noticeably given nano-pm's one-user-per-account model.
- [ ] **No backup strategy.** Critical now that we're keeping SQLite.
  Naive `cp` is unsafe with WAL (`-wal`/`-shm` sidecar files). Use
  `sqlite3 db.sqlite3 ".backup '/data/backups/$(date +%F).db'"` or
  `VACUUM INTO` on a cron. CapRover persistent dirs are bind-mounts on the
  host, so a host-level cron can hit them directly. Document the recovery
  drill — "restore by copying file back into `/data/db.sqlite3` and
  redeploying" — before relying on it.
- [ ] **SQLite scaling ceiling (categorical, not urgent).** Even with WAL
  it's still one writer at a time, no replication, single-host. Fine for
  this app's load profile; revisit if (a) write throughput climbs, (b) you
  want HA, or (c) you go multi-tenant with cross-user writes. Migration
  path: `dj_database_url` + Postgres.
- [ ] **No structured logging.** Default Django logging only. Configure
  `LOGGING` with a JSON formatter; route to stdout for the orchestrator
  to scrape. (Gunicorn already logs access + errors to stdout.)
- [x] **Error monitoring (Sentry).** Wired in `settings.py`, no-op when
  `SENTRY_DSN` is unset. Optional knobs: `SENTRY_ENVIRONMENT`,
  `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE` (default 0 — errors only).
  `send_default_pii=False` keeps usernames/IPs out of events. Datastar SSE
  handler errors surface via the `DjangoIntegration`, which catches
  exceptions in WSGI generators.
- [x] **Health-check endpoint.** `GET /healthz` runs a one-row `SELECT`
  through Django's connection — returns `200 ok` on success, `503 db: <err>`
  on `OperationalError`. No auth, no CSRF. Configure CapRover's HTTP health
  check at "App Configs → Health Check Path = `/healthz`" so a wedged
  container gets pulled out of the load balancer instead of TCP-pinging
  green forever.
- [ ] **No backup strategy.** Document daily snapshots of the DB; for
  Postgres this is `pg_dump`/managed snapshots; for SQLite, file-level
  copy + `VACUUM INTO` on a schedule.
- [x] **Migrations workflow.** The Dockerfile CMD runs `migrate --noinput`
  before exec'ing gunicorn — idempotent, fast when up-to-date.
- [ ] **No CI.** No GitHub Actions / GitLab CI / etc. Add a workflow that
  runs `manage.py test`, `ruff check`, and the Playwright suite on PRs.
- [x] **`pm.html`** v0 data file removed from the working tree.

## Data integrity

- [ ] **`auto_cascade` does an in-memory fixed-point loop with a 10 000
  safety counter, then `bulk_update`.** This is fine for the chart sizes
  we have but isn't atomic — if the process is killed mid-bulk-update,
  some tasks may be moved and others not. Wrap each call site (and the
  cascade) in `transaction.atomic` for a clean rollback.
- [ ] **No DB indexes beyond Django defaults.** Auto-generated indexes on
  FKs and PKs only. Add at least:
  - `Task(project_id, start)` for the per-project chart query
  - `Dependency(predecessor_id)` and `Dependency(successor_id)` (FK indexes
    exist; verify they cover the auto_cascade traversal)
- [ ] **No audit log.** Every action goes through `actions/manage_*` —
  good seam for a `signal_dispatch`-or-explicit log writer. Useful for
  "who moved this task and when" debugging plus eventual undo.
- [ ] **No data export.** Users can't get their projects out as CSV/JSON.
  Add an export endpoint per user.
- [ ] **No conflict handling for concurrent edits.** Two browser sessions
  can both move the same task; last write wins. Either ETag/version
  columns + 412 on stale, or accept it for the single-user product.
- [ ] **`Dependency` cycle prevention runs in Python in
  `actions/manage_dependencies._would_cycle`.** Correct but not enforced
  at the DB level — manual `INSERT`s could create cycles. Acceptable if
  the only writer is the app, but worth a unit test exercising large DAGs.

## UX gaps (deferred from v1; documented in DESIGN.md)

- [ ] **Undo / redo.** Needs a server-side history table or per-action
  change log. Plumbing then `Cmd-Z`/`Cmd-Shift-Z` keyboard handlers in
  `nano.js`.
- [ ] **Keyboard shortcuts.** `T`/`1-4`/`N`/`Cmd-Z`/`Delete`/`Esc`. Trivial
  once undo lands; some are independently useful.
- [ ] **Cascade preview while dragging.** Dependents only move on commit
  (mouseup) — so a long cascade snaps into place all at once. Either
  client-side simulator that walks deps, or a speculative server endpoint.
- [ ] **Real-time multi-user updates.** SSE long-poll between sessions
  (Datastar handles this natively — see the chat example in the
  reference repo). Until this lands, multiple browser tabs see stale data.
- [ ] **No search / filter** by status, person, project, free text.
- [ ] **Mobile / responsive** — the chart layout assumes a desktop viewport.
  At <768px wide it's unusable. Either accept "desktop only" or build a
  collapsed list view.
- [ ] **By-person view** (out of v1 scope; reconsider).
- [ ] **No comments / notes / attachments per task.** Spec'd as out — but
  practitioners want them.
- [ ] **No "drag with snap to predecessor end+1"** when moving a task —
  drag is purely freeform pixel-to-day.
- [ ] **No bulk operations** (multi-select tasks → move/delete/reassign).
- [ ] **Admin link is not exposed in UI.** Only available via direct URL
  to `/admin/`.
- [ ] **No internationalisation.** Strings are English-only and inline.
  Add `gettext_lazy` wrappers and an `en.po` baseline if i18n matters.

## Performance

- [ ] **Every action re-renders the entire chart fragment.** Coarse but
  simple — fine for ≤100 tasks, will get sluggish past that. Worth
  scoping patches to the affected bars (`SSE.patch_elements` per bar).
- [ ] **No caching of the chart view-model.** `build_chart_vm` runs on
  every request. Memoize per-(user, zoom, last-updated-at).
- [x] **CDN dependencies first-load round trip.** Resolved by vendoring
  (see Critical section). Vendor files are gzip + Brotli pre-compressed by
  whitenoise + served with content-hashed long-cache URLs.
- [x] **Datastar on GA.** Bumped to `1.0.1` (JS bundle vendored under
  `src/static/vendor/`; `datastar-py>=1.0.0` on the Python side).
  RC.7 → 1.0.1 was a clean upgrade — full e2e suite (38 tests) green.
- [ ] **No bundling / minification of `static/css/app.css` or
  `static/js/nano.js`.** Acceptable at current size; revisit if files grow.

## Testing & code quality

- [ ] **No Django unit tests.** All coverage is e2e via Playwright.
  Models / actions / readers should have unit tests — particularly
  `auto_cascade` (slack preservation, cycle paths) and
  `_would_cycle` (large DAG cases).
- [ ] **Property-based tests for `auto_cascade`.** Generate random DAGs,
  apply a move, assert no FS-dep is violated and minimal slack
  preservation. `hypothesis` works well here.
- [ ] **The e2e suite depends on `/__reset__/`.** Once that endpoint is
  removed/locked-down for prod, the suite must run against a separate
  test DB (or use Django's `setUp`/`tearDown` via a custom fixture that
  spawns a one-shot Django process per test file).
- [ ] **No CI runs the suites.** Add GitHub Actions workflow:
  `uv sync`, migrate, seed, `manage.py test`, `cd e2e && npx playwright test`.
- [ ] **No coverage reporting.** Add `coverage.py` for Python, Playwright's
  built-in report for e2e.
- [ ] **No `ruff` config.** `ruff` is in dev deps but no `[tool.ruff]`
  section in `pyproject.toml`. Adopt at least `E`, `F`, `I`, `B`, `UP`.
- [ ] **No type checker.** Type hints are present but not validated. Add
  `mypy` (strict for new code, lenient for legacy) or `pyright`.
- [ ] **Diagnostic screenshot specs in `e2e/tests/`.** `dep-drag-screenshot.spec.js`,
  `personas-screenshot.spec.js`, `popover-screenshot.spec.js`,
  `screenshot.spec.js`, `sidebar-screenshot.spec.js` — useful for review,
  noisy in CI. Move under `e2e/tests/_screenshots/` and exclude from the
  default test run, or convert to visual-regression assertions.
- [ ] **No visual regression tests.** Playwright supports snapshot diffs
  out of the box. Useful for catching CSS regressions on bars,
  popovers, sticky cells.

## Documentation

- [ ] **No `README.md`.** `DESIGN.md` covers the design but a top-level
  README with the elevator pitch + `just run` quick-start is conventional.
- [ ] **No deploy guide.** Once Dockerfile/Procfile/etc. land, document
  them in `docs/deploy.md` or similar.
- [ ] **No CHANGELOG.** With deploys, you'll want one. `keep-a-changelog`
  format is fine.
- [ ] **No CONTRIBUTING.md.** Once anyone other than the author touches
  the repo: branch model, test commands, lint commands, PR conventions.
- [ ] **DESIGN.md "Roadmap" section duplicates this file.** Once these
  items get triaged, prune the doc; track here for active work.

## Smaller polish (not blocking, worth doing)

- [ ] **Toast on save errors / network errors.** Currently a failed
  drag commit silently no-ops (Datastar logs to console). Add a
  user-visible toast on `data-on:datastar-error`.
- [ ] **`flashHint` toast in `nano.js`** is the only client-side toast
  primitive. Server-side errors arrive via `#toast-slot` patches. Unify.
- [ ] **`milestone_create` always sets the date to `today`.** Consider
  letting the user pick (or default to project's nearest task end +
  buffer).
- [ ] **`PROJECT_COLORS` is a fixed palette of 10.** A free-form colour
  picker in the project popover would be friendlier — or at least show
  which colours are unused vs. duplicated across the user's projects.
- [ ] **The `chart_view` view-model bakes layout constants** (`bar_h`,
  `row_h`, `proj_row_h`, `axis_h`, `left_w`). They're also defined in
  CSS. Single source of truth — generate the CSS variables from the
  Python constants at template-render time, or vice-versa.
- [ ] **`nano.js` is a single ~400-line IIFE.** Once it grows past 600
  lines, split into modules (`drag`, `popovers`, `bridge`).
