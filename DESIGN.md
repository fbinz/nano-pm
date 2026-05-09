# nano-pm — design

A Gantt-focused project management tool for a single person managing a team of
software projects. The entire tool — UI, logic, and data — lives in a single
HTML file. The HTML file itself is the source of truth.

## Scope

**In:** projects, tasks with dates and dependencies, people as assignment
targets, milestones, status, auto-cascading dates, undo, two-tier persistence.

**Out:** multi-user, auth, comments, attachments, time tracking, custom fields,
sub-tasks, percent-complete, multiple dependency types (FS only), critical-path
or resource-leveling algorithms, a by-person view.

The tool is single-user. Team members are modelled in the data but are not
users of the tool.

## Data model

Five entity types:

| Entity     | Fields                                                                      |
|------------|-----------------------------------------------------------------------------|
| Project    | `id`, `name`, `color`, `order`                                              |
| Task       | `id`, `project_id`, `title`, `start`, `end`, `status`, `assignee_ids[]`     |
| Person     | `id`, `name`                                                                |
| Dependency | `predecessor_id`, `successor_id`  (FS only, DAG)                            |
| Milestone  | `id`, `project_id`, `title`, `date`                                         |

`status ∈ {planned, in-progress, blocked, done}`.

Tasks have no `order` field — sorted by `start` within their project.

### Behaviors

- **Auto-cascade** is forward-only: moving a task later shifts dependents
  later. Moving a task earlier does not pull predecessors.
- **Slack is preserved.** If B was scheduled a week after A, pushing A by 3
  days moves B by 3 days, keeping the week of slack.
- **Cycle prevention** is enforced at edit time: a dependency that would form
  a cycle is refused with a quiet error.

## Physical encoding

Data lives in a hidden `<div id="data">` block at the top of `<body>`. One
`<div>` per entity, with `data-*` attributes for fields and the user-visible
title as text content.

```html
<div id="data" hidden>
  <div class="people">
    <div class="person" data-id="p_alex">Alex Chen</div>
    <div class="person" data-id="p_sam">Sam Patel</div>
  </div>

  <div class="project" data-id="proj_api" data-color="#3b82f6" data-order="1">
    <h3 class="name">API Migration</h3>

    <div class="task" data-id="t_001"
         data-start="2026-05-12" data-end="2026-05-22"
         data-status="in-progress" data-assignees="p_alex">
      Spike on auth changes
    </div>

    <div class="task" data-id="t_002"
         data-start="2026-05-25" data-end="2026-06-05"
         data-status="planned" data-assignees="p_alex,p_sam">
      Migrate /users endpoints
    </div>

    <div class="milestone" data-id="m_001" data-date="2026-06-10">
      v2 API beta
    </div>
  </div>

  <div class="dependencies">
    <div class="dep" data-from="t_001" data-to="t_002"></div>
  </div>
</div>
```

Choices baked in:

- Tasks and milestones nest inside their project — grouping is visible
  structurally, diff- and grep-friendly.
- People and dependencies are top-level (cross-cutting / relational).
- Title is text content, not an attribute (no quote-escaping issues).
- Assignees are comma-separated IDs in one attribute.

## Interaction model

### Direct manipulation

- **Click bar / diamond** → select.
- **Drag bar horizontally** → move task. Dependents auto-cascade with slack
  preserved.
- **Drag bar edge** → resize. If end moves later, dependents cascade.
- **Drag milestone diamond** → move date.
- **Rubber-band on a project row** → new task; the new task opens for editing.
- **Drag from a bar's right edge onto another bar** → new dependency. Refused
  with a quiet error if it would form a cycle.
- **Click a dependency arrow** → select; `Delete` removes.
- **Cascade preview while dragging:** dependents render as ghosts at their
  projected positions; commit on mouseup.

### Editing

Click on a bar opens an **inline popover** with all five task fields: title,
start, end, status, assignees. Dismisses on outside-click.

### Timeline navigation

- Drag empty timeline to pan; mousewheel / trackpad to scroll.
- Zoom presets: day / week / month / quarter (keys `1` / `2` / `3` / `4`).
- Persistent **today** line; **T** key jumps to today.

### Keyboard accelerators

| Key       | Action                  |
|-----------|-------------------------|
| `Cmd-Z`   | Undo                    |
| `Cmd-⇧-Z` | Redo                    |
| `1`–`4`   | Zoom presets            |
| `T`       | Jump to today           |
| `N`       | New task (focused row)  |
| `Delete`  | Remove selection        |

### Project & people management

- Click on a project header strip → edit project name, color, order.
- Header button opens a **people modal** for add / rename / remove.

### Undo

`Cmd-Z` keeps a deep stack of full-data snapshots. One drag can move many
dependents; without undo, one bad gesture corrupts the plan. Snapshots are
small and cheap.

## Persistence

Two-tier, feature-detected at load:

```
                   ┌─ window.showSaveFilePicker present? ─┐
                   │                                      │
            yes ───┴───                              ───── no
                   │                                      │
        Autosave mode                          Download saver mode
        (Chromium, Edge)                       (Firefox, Safari)
```

### FS Access API path (happy path)

- **First run:** page detects no stored handle → shows a one-time
  "Enable autosave" affordance → calls `showOpenFilePicker()` → user
  re-picks the same `nano-pm.html` they have open → handle stored in
  IndexedDB keyed by app id.
- **Subsequent runs:** read handle, `verifyPermission()`, autosave silently.
- **Save timing:** debounced **~500ms** after last edit. Drags coalesce into
  one write.

The "pick the same file you already have open" friction is unavoidable on the
web platform — the same papercut TiddlyWiki has lived with for two decades.
One click, one navigation, then never again.

### Download saver path (fallback)

- Save is **explicit** (header button). Each save downloads a `nano-pm.html`
  that replaces the original.
- `beforeunload` warns if unsaved.

### Save mechanics (both paths)

The data lives in the DOM. On every edit we mutate the `<div id="data">`
block, so the DOM is always current.

```
save() = `<!DOCTYPE html>\n` + document.documentElement.outerHTML  →  write
```

No string-splicing, no template stitching. The whole file rewrites every
save. The file is small enough that this is fine.

### Safety net

- **localStorage mirror** of the current data blob on every edit. If a file
  write fails (permission revoked, file moved, disk full) the data isn't
  lost — recover from localStorage on next load.
- **Header indicator:** "Last saved at HH:MM" in the header.
- **Title signal:** `•` prefix on the page title when dirty.

## Rendering

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ nano-pm   • Unsaved      [day|week|month|quarter]  [T] [Save]  │
├─────────────────┬───────────────────────────────────────────────┤
│                 │  May 2026         │ June 2026                 │
│                 │  M T W T F S S M T W T F S S M T W T F S ...  │
├─────────────────┼───────────────────────────────────────────────┤
│ ● API Migration │                                               │
│   Spike auth    │  ▓▓▓▓▓▓▓▓                                     │
│   Migrate users │              ▒▒▒▒▒▒▒▒▒▒▒▒                     │
│   ◇ v2 beta     │                              ◆                │
└─────────────────┴───────────────────────────────────────────────┘
                         ↑ today line
```

- **Header strip (toolbar):** save status, zoom presets, today button, save
  button.
- **Sticky left column** (~250–300px): project header rows with color stripe
  and name, followed by indented task title rows.
- **Sticky time axis** at the top of the chart area.
- **Main chart area:** horizontally pannable. Vertical scroll moves the left
  column and chart together.

### Row strategy

**One row per task.** Projects are visual groups: a project header row
(color stripe + name) followed by indented task rows. Bars never collide;
task titles read cleanly in the left column.

### Color encoding

- **Project = hue.** Each `Project` carries a color; bar fill = project color.
- **Status = treatment:**
  - `planned` — 50% opacity / pale fill
  - `in-progress` — full saturation / solid fill
  - `blocked` — solid + diagonal-stripe overlay or red 2px border
  - `done` — full but desaturated, with a check icon; no longer drag-editable
- Milestone diamonds inherit their project's color. A past-due milestone
  (date < today, no `done` task pointing at it) gets a red ring.

### Time axis per zoom

| Zoom    | Major header | Minor ticks      | Grid lines  |
|---------|--------------|------------------|-------------|
| day     | Month        | Day of week + #  | every day   |
| week    | Month        | Week-start date  | every week  |
| month   | Quarter/Year | Month name       | every month |
| quarter | Year         | Quarter (Q1…)    | every Q     |

Weekends shaded subtly at day and week zoom.

### Dependency arrows

Orthogonal right-angles, routed through shared gutters between rows.
Arrowhead at the successor end. Click an arrow to select; `Delete` removes.

### Today line and overdue treatment

- Vertical 1px accent line spanning the chart at today's date.
- Tasks where `end < today` and `status != done` get a red left-border so
  slippage scans visibly.

### Implementation

Hybrid:

- **HTML/CSS** for toolbar, time axis, left column, project rows, task rows,
  bars, milestones, and the inline popover. Native event handlers, easy
  popover positioning, ordinary CSS for theming.
- **One SVG overlay** layered on top of the chart area for dependency arrows.
  Sized and scrolled in lockstep with the chart so arrows align precisely
  with bar endpoints.

## First run

Two states are detected independently at load time and handled separately.

### Empty data → welcome card

When the data div has no entities, a centered, dismissible welcome card
appears over the (otherwise rendered) empty chart:

- **Start fresh** → dismiss the card, leave the chart empty. A subtle
  centered affordance prompts "+ Create your first project".
- **Try a demo** → dismiss the card and inject a demo dataset into the DOM,
  generated by JS so dates are always relative to today. The demo data
  persists to the data div on the next save like any other edit.

The card never shows again once data exists.

### Demo dataset (richer)

Generated at first run, dated relative to today:

- **3 projects** with distinct colors.
- **~8 tasks** across the projects, spanning a window of roughly four weeks
  on either side of today.
- **Multiple dependencies**, including at least one **cross-project**
  dependency to demonstrate the orthogonal arrow routing.
- **2 milestones**, one in the past (with `done` predecessor) and one ahead.
- A mix of statuses (planned / in-progress / blocked / done) and a couple of
  multi-assignee tasks so all rendering treatments are visible.

### No save handle → dismissible header banner

Independent of data state. If `window.showSaveFilePicker` is present and no
handle is stored in IndexedDB, a slim banner sits in the header strip:

> Autosave isn't set up yet. Click to enable.

The banner disappears on enable, or on explicit dismiss (flag persisted in
localStorage so it stays dismissed across reloads). On browsers without FS
Access API the banner never appears — the explicit Save button is the
expected mode.

### Shipped file header

A short comment block sits at the top of the file for anyone who opens it in
a text editor before a browser:

```html
<!--
  nano-pm — a single-file Gantt PM tool. Open this file in a browser to use it.
  Your data lives inside <div id="data"> below; you can hand-edit it if you like.
-->
```
