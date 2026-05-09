# nano-pm — design

A Gantt-focused project management tool for a single person managing a team of
software projects.

> **v0 → v1 pivot.** The original v0 was a single-file HTML app
> (`legacy/nano-pm.html`, with its Playwright suite at `legacy/tests/`). The
> file-as-source-of-truth design hit hard limits — autosave permission UX on
> reload, opaque update workflow, no concurrent users — so v1 is a server-rendered
> app on Django + Datastar + Django-Cotton + SQLite, modelled on
> [`/home/binz/Repositories/django-datastar`](../django-datastar).
>
> The behavioural contract (entities, auto-cascade, gestures, rendering) carries
> over almost verbatim. What's gone: single-file persistence, FS-Access-API,
> localStorage backup, autosave banner, the import/update workflow.

## Stack

| Tech | Role |
|---|---|
| **Django 5** | Backend, function-based views, CQRS-shaped layout |
| **Datastar 1.0-RC** | Server-driven reactivity — server emits SSE patches |
| **Django-Cotton** | Component templates (`<c-name :prop="…">`) |
| **SQLite** | Persistence (the file is `db.sqlite3` at the repo root) |
| **uv + just** | Tooling — `just run` / `just reset` |

## Scope

**In:** projects, tasks with dates and dependencies, people as assignment
targets, milestones, status, auto-cascading dates, **per-user accounts**.

**Out (deliberate cuts vs v0):** comments, attachments, time tracking, custom
fields, sub-tasks, percent-complete, multiple dependency types (FS only),
critical-path or resource-leveling algorithms, a by-person view, undo/redo,
keyboard shortcuts, cascade preview while dragging.

## Auth model

Standard Django auth. Every entity is scoped to a `User`. Projects and people
have an `owner = ForeignKey(User)`; tasks/milestones/dependencies inherit the
owner via `project.owner`. Reads are filtered by `request.user`; writes
double-check ownership before mutating.

The only user-facing auth chrome is `/accounts/login/` and a Sign-out button in
the topbar. `seed_data` creates user `demo` with password `demo`.

## Data model

Five entities, scoped under a `User`:

| Entity | Fields |
|---|---|
| `Project` | `owner`, `name`, `color`, `order` (float for cheap inserts) |
| `Person` | `owner`, `name` (assignment target, **not** a User) |
| `Task` | `project`, `title`, `start`, `end`, `status`, `assignees` (M2M Person) |
| `Dependency` | `predecessor` (Task), `successor` (Task) — FS only, unique edge, no self-loop |
| `Milestone` | `project`, `title`, `date` |

`TaskStatus = {planned, in-progress, blocked, done}`.

Tasks have no `order` field — sorted by `start` within their project.

### Behaviours

- **Auto-cascade** is forward-only: moving a task later shifts dependents later
  by exactly the violation. Moving a task earlier (or shrinking it) doesn't
  violate any FS dep on the predecessor side, so it never pulls anything.
- **Slack is preserved.** If B was scheduled a week after A and you push A
  three days later, B moves three days later (still a week of slack).
- **Cycle prevention** is enforced in `actions/manage_dependencies.add_dependency`
  with a forward DFS over the existing edges; a back-edge attempt is refused
  with a toast.

## Layout

```
src/
├── config/                          # settings, urls, wsgi
├── data/
│   ├── models/                      # one file per entity
│   ├── management/commands/seed_data.py
│   └── migrations/
├── actions/                         # writes (CQRS write side)
│   ├── manage_projects.py
│   ├── manage_people.py
│   ├── manage_tasks.py              # incl. move_task, resize_start, resize_end
│   ├── manage_dependencies.py       # add (cycle-checked) + delete
│   ├── manage_milestones.py
│   └── auto_cascade.py              # forward-only, slack-preserved
├── readers/                         # reads (CQRS read side)
│   ├── gantt.py                     # ChartState + per-entity getters
│   └── chart_view.py                # build_chart_vm: pixel-geometry view-model
├── interfaces/web/
│   └── gantt.py                     # full page + SSE fragment endpoints + URLs
├── templates/
│   ├── accounts/login.html
│   └── components/                  # Cotton — COTTON_DIR=components
│       ├── layouts/base.html
│       └── screens/gantt/
│           ├── index.html           # full page
│           ├── chart.html           # the grid + axis + rows + arrows
│           ├── bar.html
│           ├── milestone.html
│           ├── task-popover.html
│           ├── project-popover.html
│           └── people-modal.html
└── static/
    ├── css/app.css                  # all styles in one file
    └── js/nano.js                   # client-side drag glue (~250 lines)
```

## Datastar response pattern

Almost every interaction is a function-based view decorated with
`@datastar_response`, yielding one or more `SSE.patch_elements(...)` calls.
After any data mutation, the server re-renders the chart fragment and patches
`#grid-scroll`:

```python
@datastar_response
def task_update(request, task_id):
    update_task(owner=request.user, task_id=task_id, …)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="popover-slot"></div>')  # close popover
```

`_patch_chart()` calls `build_chart_vm(state, zoom)` then renders the
`screens/gantt/chart` Cotton component. The patch-by-id behaviour replaces the
whole `#grid-scroll` element. Coarse, but the chart is small and this avoids a
class of partial-update bugs.

## Drag UX

Datastar is server-driven, but a Gantt with server-roundtripped drags would
feel awful. So `static/js/nano.js` does the live mouse work:

1. **Bar move**, **edge resize**, **rubber-band create**, **dep-handle drag** —
   each handler updates `bar.style.left/.width` in real time during mousemove.
2. **On mouseup**, the JS `fetch`-POSTs the final dates to the appropriate
   endpoint (`/tasks/<id>/move/`, `/tasks/<id>/resize/end/`, etc.).
3. The server applies the change, runs `auto_cascade`, and returns the chart
   fragment as an SSE patch. A small `applySseText()` helper in `nano.js`
   parses the SSE framing and replaces matching elements by id (manual fetch
   bypasses Datastar's own dispatch loop).

For pure clicks, form submits, and nav (project popover, people modal, dep
deletion via `×`), Datastar drives the request directly via `data-on:click` /
`data-on:submit__prevent`. No JS glue needed.

## Rendering

`readers/chart_view.py` produces a `ChartVM` with everything pre-pixelised:

```python
@dataclass
class ChartVM:
    zoom: str               # day | week | month | quarter
    px_per_day: int         # 36 | 12 | 3 | 1
    chart_width: float
    today_x: float
    axis_majors: list[AxisTick]    # month/quarter/year header band
    axis_minors: list[AxisTick]    # day-of-week / week / month / quarter ticks
    weekend_tiles: list[AxisTick]  # only at day/week zoom
    row_groups: list[ProjectRowVM]
    deps: list[DepArrowVM]         # SVG `d` paths, orthogonal routing
    show_today_line: bool
```

The template (`screens/gantt/chart.html`) is dumb — it iterates and emits
absolutely-positioned divs and SVG paths. The grid uses CSS `position: sticky`
on left cells (column) and the time-axis row, so they stay locked while the
chart pans.

Bar visuals: project hue + status treatment.
- `planned` — 50% opacity
- `in-progress` — solid fill
- `blocked` — diagonal stripe + red ring
- `done` — desaturated, "✓" prefix
- `overdue` (any non-done task with `end < today`) — red left border

## URL surface

```
GET   /                                 page (login required)
GET   /accounts/login/                  Django auth
POST  /accounts/logout/

GET   /tasks/<id>/popover/              SSE → task-popover
POST  /tasks/<id>/update/               SSE → chart + close popover
POST  /tasks/<id>/move/                 SSE → chart                (drag)
POST  /tasks/<id>/resize/start/         SSE → chart                (drag)
POST  /tasks/<id>/resize/end/           SSE → chart                (drag)
POST  /tasks/                           SSE → chart                (rubber-band)
POST  /tasks/<id>/delete/               SSE → chart + close popover

POST  /dependencies/                    SSE → chart                (dep-handle)
POST  /dependencies/<from>/<to>/delete/ SSE → chart

POST  /projects/                        SSE → chart
GET   /projects/<id>/popover/           SSE → project-popover
POST  /projects/<id>/update/            SSE → chart + close popover
POST  /projects/<id>/move/?dir=±1       SSE → chart + close popover
POST  /projects/<id>/delete/            SSE → chart + close popover

GET   /people/modal/                    SSE → people-modal
POST  /people/                          SSE → people-modal
POST  /people/<id>/update/              SSE → people-modal + chart
POST  /people/<id>/delete/              SSE → people-modal + chart
```

## Roadmap (deferred from v1)

- **Undo/redo** — needs a server-side history table or per-action change log.
- **Keyboard shortcuts** — `T`/`1-4`/`N`/`Cmd-Z`. Trivial once undo lands.
- **Cascade preview while dragging** — show ghost positions for transitive
  successors during drag. Requires either a client-side cascade simulator or
  speculative server endpoint.
- **Real-time multi-user** — when two users edit the same project, an SSE
  long-poll endpoint can push patches between sessions (Datastar handles this
  natively; cf. the chat example in the reference repo).

## Legacy: v0 single-file design

The original v0 design lives in two places:
- The shipped artefact: `legacy/nano-pm.html` (~2 200 lines, self-contained).
- The Playwright suite that drove its TDD: `legacy/tests/`, runnable via
  `legacy/package.json` if you reinstall its node deps.

v0's distinctive choices were:
- HTML file as source of truth — data lived in `<div id="data" hidden>` with
  per-entity divs and `data-*` attributes.
- Persistence: File System Access API on Chromium with debounced 500ms
  autosave; download-saver fallback elsewhere; localStorage mirror.
- Welcome card with "Try a demo" / "Start fresh", autosave banner with stored
  handle re-grant flow, runtime UI never serialised into the file.

The new stack supersedes all of that. The behavioural design (auto-cascade,
slack preservation, cycle prevention, the five entities, popover-with-deps,
drag-to-resize-each-end with visible pill, dep handle on hover, rubber-band
new-task) is preserved and ported.
