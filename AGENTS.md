# nano-pm

## Default testing strategy

**Use red/green TDD with Playwright for behavior changes and bug fixes.**
Small presentation-only changes—text copy, translations, spacing, colors, borders,
and similar layout or styling tweaks—do **not** require adding or updating tests,
or a red/green cycle. Use judgment: existing tests, screenshots, or a quick visual
check can be useful, but a test run is not mandatory for these small changes.
If a layout change affects interactions (drag geometry, focus, scrolling, responsive
controls, etc.), treat it as a behavior change and use TDD.

For behavior changes, the canonical loop is:

1. **Red.** Add or update a Playwright test in `e2e/tests/nano-pm.spec.js`
   (or a focused screenshot/persona spec when the change is purely visual) that
   fails for the bug or missing behaviour. Run only that test
   (`cd e2e && npx playwright test --grep "<title>"`) and confirm it fails
   for the expected reason — not a setup error. Treat any other failure mode
   (timeout on a `waitForFunction`, off-screen element) as a test bug to fix
   before proceeding.
2. **Green.** Make the smallest change that turns the test green.
3. **Regression.** Run `cd e2e && npx playwright test tests/nano-pm.spec.js`
   for app behaviour changes. Run relevant screenshot specs when useful for
   visual verification; small presentation-only changes do not require them.

There are currently **no meaningful Django unit tests** in this repo. Most
coverage is e2e through Playwright. If you find yourself wanting a unit test for
an action / reader / model flow, start with a Playwright test instead —
Datastar/SSE flows and DOM-level state (zoom, scroll, popover/drawer anchoring,
drag/resize, Sortable drag) are what actually break, and only the browser
surfaces those. Pure deterministic code can still justify a focused unit test,
but that is the exception.

### Running checks

```
cd e2e && npx playwright test                       # full e2e suite
cd e2e && npx playwright test --grep "<title>"      # one test by title
cd e2e && npx playwright test tests/nano-pm.spec.js # main behavioural spec
just e2e --grep "<title>"                          # same via just
uv run ruff check .                                 # Python lint
```

Playwright runs up to **4 parallel workers** by default (capped by available
CPUs). Each worker starts its own threaded Django server on an OS-assigned port,
runs migrations, and seeds a fresh temporary `worker.e2e.sqlite3` database.
Servers and temporary databases are cleaned up when the worker exits; do not
rely on an already-running dev server. Use `--workers=1` for serial debugging.

`e2e/server.js` and `e2e/serve.py` manage those servers. They select
`config.settings_e2e`, which uses fast hashing only for throwaway accounts and
requires explicit debug/reset/seed opt-ins and a database path ending in
`.e2e.sqlite3`. Normal development and production retain secure hashing.

### Fixtures

Use the `appPage` fixture from `e2e/tests/fixtures.js` for tests that need a
logged-in chart at the seeded state. It resets the DB via the
`DJANGO_ENABLE_TEST_RESET`-gated `/__reset__/` endpoint and logs in as
`demo` / `demo` before each test. The seeded state is documented in the fixture
comment (currently 3 projects, 8 tasks, 6 dependencies, 2 milestones).

Routine fixture login uses the real, CSRF-protected login endpoint through
`page.request`, sharing its session cookies with the browser, then navigates
directly to the chart. Use `loginThroughUI` from the same fixture module when
the test specifically needs to exercise the browser login form. Do not skip
resets or share mutable browser/database state to improve runtime.

For management-command subprocesses, use `djangoEnv()` from the fixture module
so they target the current worker's database. Raw SQLite helpers must use
`os.environ['DJANGO_DB_PATH']`, not a hardcoded filename. Additional servers must
also bind an OS-assigned port; the production-asset test uses `startServer()`
with `initialize: false` so it cannot reseed its worker's live database.

See `docs/e2e-testing.md` for performance measurements and runner details.

### Writing a good Playwright test

- Wait for **server-committed state**, not local drag preview. The chart
  re-renders via SSE patch after gesture commits; locally-mutated `style.left`
  / `style.width` during the drag are not a safe signal. Prefer
  `page.waitForFunction` against `dataset.start`, `dataset.end`, `dataset.date`,
  `dataset.status`, etc., which only change after the SSE patch lands.
- At non-week zoom, seeded objects may sit off-screen (the chart is much wider
  at day zoom). Call `scrollIntoViewIfNeeded()` before computing a
  `boundingBox()` for drag coordinates.
- Prefer assertions on data attributes (`data-px-per-day`, `data-start`,
  `data-end`, `data-date`, `data-status`) over visual properties where possible
  — they are stable across SSE re-renders and read directly from the view-model.
- Tests run in parallel with a separate Django process/database per worker and
  reset between tests. Keep tests isolated; do not depend on mutations made by
  an earlier test or on another worker's data.

## German UI tone

Use informal singular address throughout the German UI: `du`, `dich`, `dir`,
`dein` and singular imperatives (e.g. „Gib … ein“, „Wähle …“, „Speichere …“).
Capitalize only at the start of a sentence or heading; never address users with
formal `Sie` / `Ihr`. This applies to all pages, help text, validation messages,
public roadmaps, and both `django` and `djangojs` catalogs. Neutral button labels
such as „Speichern“ are fine. Preserve grammatical third-person pronouns
(e.g. „Sie kann …“ referring to an email address).

## Django template gotchas

- **Comments.** `{# ... #}` is single-line only. For anything that spans more
  than one line, use `{% comment %}...{% endcomment %}`.
- Client event handlers use Datastar attributes such as `data-on:click`,
  `data-on:submit__prevent`, and `data-on:input__debounce.150ms`. Gesture code
  in `nano.js` dispatches custom browser events rather than calling endpoints
  directly.

## Architecture quick-ref

- `src/interfaces/web/pages.py` — full-page Gantt render (`index`) and density
  slider endpoint (`zoom_set`).
- `src/interfaces/web/helpers.py` — shared web helpers: `zoom()`, per-zoom
  `ppd()`, session-backed UI state, role checks, `request_data()`, and
  `patch_chart()`.
- `src/interfaces/web/tasks.py`, `milestones.py`, `projects.py`,
  `dependencies.py`, `resources.py`, `people.py`, `kanban.py`, `workspaces.py`
  — Datastar/SSE endpoints for each domain.
- `src/static/js/nano.js` — client-side drag/resize/dependency-handle,
  rubber-band creation, sidebar resize, drawer/popover positioning, and kanban
  Sortable glue. Dispatches `nano-commit` and `nano-fetch` events.
- `src/templates/components/layouts/app-shell.html` — app shell, drawer/toast
  slots, and the global Datastar bridge that forwards `nano-commit` to `@post`
  with JSON `payload` and CSRF headers, and `nano-fetch` to `@get`.
- `src/readers/chart.py` — workspace-scoped chart state query/assembly.
- `src/readers/chart_view.py` — view-model assembly: zoom defaults/ranges,
  axis ticks, bar/milestone positions, dependency arrow routing, resource and
  kanban VMs.
- `src/templates/components/screens/gantt/` — Django Cotton components for the
  Gantt/resource chart, bars, milestones, drawers/popovers, and filters.
- `src/templates/components/screens/kanban/` and `people/` — Cotton components
  for the Tasks board and People page.

The Datastar round-trip is: gesture/form/click → `nano-commit`/Datastar
`@post` or `@get` → server action + re-render → `SSE.patch_elements(...)` → DOM
patch in place. State that must survive re-renders lives in the URL, session,
DB, localStorage (sidebar width), or the patched fragment. Pure client-side
state is fragile unless `nano.js` explicitly reapplies it after patches (for
example multi-select outlines and Sortable bindings).

## Other project notes

- The app is workspace-scoped by `src/middleware/workspace.py`; use
  `request.workspace` and role/membership helpers instead of querying global
  data.
- Styles are generated from `src/css/input.css` into `src/static/css/app.css`
  with `just css`; do not hand-edit generated CSS unless you are intentionally
  updating the built artifact too.
- i18n uses Django `django` and `djangojs` catalogs. Run
  `just messages <lang>` after adding translatable Python/template/JS strings,
  and `just messages-compile` after editing `.po` files.
