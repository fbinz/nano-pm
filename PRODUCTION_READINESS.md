# Production readiness — open issues

A snapshot of what stands between the current `main` (post-v1 pivot) and a
production deployment. Items are roughly ordered by severity within each
section. Cross-references point at file paths under `src/` unless noted.

The current state is **fine for local exploration**. The four foundational
risks (DEBUG, SECRET_KEY, ALLOWED_HOSTS, `/__reset__/`) have been resolved.
The remaining items below would still be needed to expose this on the
open internet — most importantly, password validators, HTTPS, and CSP.

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
- [ ] **Password validators are disabled.** `AUTH_PASSWORD_VALIDATORS = []`.
  Restore Django's defaults at minimum (`MinimumLength`, `CommonPassword`,
  `NumericPassword`, `UserAttributeSimilarity`).
- [ ] **Seeded accounts use the username as the password.** `seed_data` and
  `populate_demo` set `demo/demo`, `alice/alice`, `bob/bob`, plus
  `fabian/fabian`. They're also `is_staff=True` (admin access). Either
  scrub these from any non-dev DB or refuse to seed when `DEBUG=False`.
- [ ] **No HTTPS enforcement.** Add `SECURE_SSL_REDIRECT=True`,
  `SESSION_COOKIE_SECURE=True`, `CSRF_COOKIE_SECURE=True`,
  `SECURE_HSTS_SECONDS`, `SECURE_PROXY_SSL_HEADER` (if behind a proxy).
- [ ] **No security headers.** Add `SECURE_CONTENT_TYPE_NOSNIFF`,
  `SECURE_REFERRER_POLICY="same-origin"`. `X_FRAME_OPTIONS` is on by
  default; verify it survives any reverse proxy.
- [ ] **CDN `<script>` tags have no SRI.** `templates/components/layouts/base.html`
  pulls Datastar and Floating UI from jsDelivr without `integrity=`/
  `crossorigin=` attributes. Pin versions and add SRI hashes; ideally
  vendor the libraries into `static/` and serve them locally.
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
- [ ] **No password-strength enforcement when an admin sets a password.**
  Once `AUTH_PASSWORD_VALIDATORS` is restored (see the Critical section),
  the admin's "set password" form picks them up automatically.

## Deployment & operations

- [ ] **No production WSGI server.** `manage.py runserver` is dev-only.
  Add `gunicorn` (or `uvicorn` if going async) to deps, document the
  invocation. Likely `gunicorn config.wsgi:application -b 0.0.0.0:$PORT`.
- [ ] **Static files served by Django dev server.** Add `whitenoise`
  (`WhiteNoiseMiddleware` after `SecurityMiddleware`, set
  `STATICFILES_STORAGE = "whitenoise.storage.CompressedManifestStaticFilesStorage"`)
  and run `collectstatic` in deploy.
- [ ] **SQLite as the production DB is risky.** Multiple concurrent writers
  serialize on the file lock; long auto-cascades + e2e/`__reset__/` will
  fight in prod. Switch to Postgres for any multi-user scenario; keep
  SQLite for single-user local. Migrate via `dj_database_url` + env.
- [ ] **No deployment artifacts.** No Dockerfile, no compose, no
  Procfile/Heroku-style config, no systemd unit. Pick a target (Fly.io /
  Railway / a VM with systemd / Kubernetes) and write the bootstrap.
- [ ] **No structured logging.** Default Django logging only. Configure
  `LOGGING` with a JSON formatter; route to stdout for the orchestrator
  to scrape.
- [ ] **No error monitoring.** Add Sentry (or similar) with
  `SENTRY_DSN` env. Especially valuable because Datastar errors surface
  client-side and silently fail.
- [ ] **No health-check endpoint.** Add `/healthz` (DB connectivity) and
  `/readyz`. Most platforms need at least one for autoscaling.
- [ ] **No backup strategy.** Document daily snapshots of the DB; for
  Postgres this is `pg_dump`/managed snapshots; for SQLite, file-level
  copy + `VACUUM INTO` on a schedule.
- [ ] **No migrations workflow.** Migrations are committed but no
  pre-deploy `python manage.py migrate --noinput` step is documented.
- [ ] **No CI.** No GitHub Actions / GitLab CI / etc. Add a workflow that
  runs `manage.py test`, `ruff check`, and the Playwright suite on PRs.
- [ ] **`db.sqlite3` in `.gitignore` is correct, but `pm.html` is also
  untracked** — that's user data from v0. Remove it from the working
  tree once you've migrated anything you wanted to keep.

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
- [ ] **CDN dependencies cost a first-load round trip.** Pinned versions +
  SRI and `<link rel="preconnect">` would help; vendoring would help more.
- [ ] **`Datastar 1.0.0-RC.7` is a release candidate.** Once GA ships,
  upgrade and retest. RC versions can have subtle breaking changes.
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

- [ ] **`pm.html`** untracked at the repo root is your v0 data file. Decide:
  delete it, move to `legacy/`, or extract any data you want to keep.
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
