# nano-pm

## Default testing strategy

**Use red/green TDD with Playwright.** The canonical loop:

1. **Red.** Add a Playwright test in `e2e/tests/nano-pm.spec.js` that fails
   for the bug or missing behaviour. Run only that test
   (`npx playwright test --grep "<title>"`) and confirm it fails for the
   expected reason — not a setup error. Treat any other failure mode
   (timeout on a `waitForFunction`, off-screen element) as test bugs to
   fix before proceeding.
2. **Green.** Make the smallest change that turns the test green.
3. **Regression.** Run `npx playwright test tests/nano-pm.spec.js` from
   `e2e/` to confirm the rest of the suite still passes.

There are **no Django unit tests** in this repo. All coverage is e2e
through Playwright. If you find yourself wanting a unit test, add a
Playwright test instead — Datastar/SSE flows and DOM-level state
(zoom, scroll, popover anchoring, drag/resize) are what actually break,
and only the browser surfaces those.

### Running the suite

```
cd e2e && npx playwright test                       # full suite
cd e2e && npx playwright test --grep "<title>"      # one test
cd e2e && npx playwright test tests/nano-pm.spec.js # main spec only
```

The Playwright config (`e2e/playwright.config.js`) auto-starts the Django
dev server on port 8765, runs migrations, and seeds. `reuseExistingServer`
is on outside CI, so a server you already started is reused.

### Fixtures

Use the `appPage` fixture from `e2e/tests/fixtures.js` for tests that need
a logged-in chart at the seeded state — it resets the DB via the
`DJANGO_ENABLE_TEST_RESET`-gated `/__reset__/` endpoint and logs in as
`demo` / `demo` before each test.

### Writing a good test

- Wait for **server-committed state**, not local drag preview. The chart
  re-renders via SSE patch on `mouseup`; locally-mutated `style.left`
  changes during the drag are not a safe signal. Use
  `page.waitForFunction` against `dataset.start`/`dataset.date`/etc.,
  which only flip after the SSE patch lands.
- At non-week zoom, seeded objects may sit off-screen (the chart is
  ~3× wider at day zoom). Call `scrollIntoViewIfNeeded()` before
  computing a `boundingBox()` for drag coordinates.
- Prefer assertions on data-attributes (`data-px-per-day`,
  `data-start`, `data-date`) over visual properties — they're stable
  across SSE re-renders and read directly from the view-model.

### When NOT to write a unit test

If you're tempted to add Django unit coverage for an action / reader /
model: still start with a Playwright test that exercises the behaviour
end-to-end. A unit test that passes while the e2e flow breaks is worse
than no unit test. (If the property under test really is pure — e.g.
DAG cascade math on a synthetic graph — that's a candidate for a
focused unit test, but those are rare here.)

## Django template gotchas

- **Comments.** `{# ... #}` is **single-line only** — Django parses
  multi-line `{# ... #}` blocks incorrectly and silently leaks the
  middle lines into rendered output. For anything that spans more
  than one line, use `{% comment %}...{% endcomment %}`.

## Architecture quick-ref

- `src/interfaces/web/gantt.py` — Django views, all chart-state SSE
  patch endpoints. `_patch_chart()` re-renders via `build_chart_vm`;
  `_zoom()` resolves the active zoom (URL param → session → default).
- `src/static/js/nano.js` — client-side drag/resize/dep-handle/
  rubber-band gestures. Dispatches `nano-commit` events that the
  `#nano-bridge` form in `templates/components/screens/gantt/index.html`
  forwards to Datastar's `@post`.
- `src/readers/chart_view.py` — view-model assembly: `ZOOM_PX_PER_DAY`
  table, axis ticks, bar/milestone positions, dependency arrow routing.
- `src/templates/components/screens/gantt/` — Django Cotton components
  for chart, popovers, modal.

The SSE round-trip is: gesture → `nano-commit` → form `requestSubmit()`
→ Datastar `@post` → server action + re-render → SSE `patch_elements`
→ DOM patch in place. Any state that needs to survive re-renders has
to live in the URL, the session, or the patched fragment itself —
client-only state (e.g. JS variables) does not survive.
