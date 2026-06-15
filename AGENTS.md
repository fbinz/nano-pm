# nano-pm

## Default testing strategy

**Use red/green TDD with Playwright.** The canonical loop:

1. **Red.** Add or update a Playwright test in `e2e/tests/nano-pm.spec.js`
   (or a focused screenshot/persona spec when the change is purely visual) that
   fails for the bug or missing behaviour. Run only that test
   (`cd e2e && npx playwright test --grep "<title>"`) and confirm it fails
   for the expected reason — not a setup error. Treat any other failure mode
   (timeout on a `waitForFunction`, off-screen element) as a test bug to fix
   before proceeding.
2. **Green.** Make the smallest change that turns the test green.
3. **Regression.** Run `cd e2e && npx playwright test tests/nano-pm.spec.js`
   for app behaviour changes. Run the relevant screenshot specs too when a
   visual-only fixture is changed.

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

The Playwright config (`e2e/playwright.config.js`) starts Django on port **8766**,
runs migrations, and seeds `db.e2e.sqlite3` before the suite. It sets
`reuseExistingServer: false`, so do not rely on an already-running dev server.
The config also enables the test-only `/__reset__/` endpoint and insecure seed
passwords via environment variables.

### Fixtures

Use the `appPage` fixture from `e2e/tests/fixtures.js` for tests that need a
logged-in chart at the seeded state. It resets the DB via the
`DJANGO_ENABLE_TEST_RESET`-gated `/__reset__/` endpoint and logs in as
`demo` / `demo` before each test. The seeded state is documented in the fixture
comment (currently 3 projects, 8 tasks, 6 dependencies, 2 milestones).

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
- Tests run serially with one Django process and reset between tests. Keep tests
  isolated; do not depend on mutations made by an earlier test.

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
