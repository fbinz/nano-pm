# Project workspace

A project has one permanent home, from the first idea to review. Open its detail
page from the chart, or use **Project library** in the chart toolbar to find
projects by name and phase. Creating a project in the library requires only a
name; chart and MCP creation also default to the **Idea** phase.

## Lifecycle

Idea → Discovery → Shaping → Planned → Delivery → Review → Completed.
Parked and Dropped are also available. These are labels, not approval gates:
phases can be skipped or revisited and never reschedule tasks or milestones.
Completed synchronizes with the existing completion flag, chart filter, and
GitLab collection rules. The old completion/reopen controls use Completed and
Delivery respectively. A failed GitLab reopening check leaves both phase and
journal unchanged.

Existing projects keep their execution semantics on upgrade: Delivery for open
projects, Completed for completed projects. **Existing Idea records are not
migrated, copied, or deleted.** The separate Ideas UI, routes, editor, and MCP
operations are removed. The legacy model/table remains only to retain those
records; new planning uses Project exclusively.

## Project detail tabs

The tab order is **Project · Workspace · Plan · GitLab**. Labels use
Django translations (German: **Projekt · Arbeitsbereich · Plan · GitLab**).
Project is first visually, but existing projects still open on **Workspace** by
default; an explicit `?tab=project`, `?tab=workspace`, `?tab=plan`, or
`?tab=gitlab` selects its own view and survives reload/language switching.

Project contains the normal validated property editor for PMs/responsible people,
without an extra disclosure to open. Saving stays on Project; Cancel returns to
Workspace. Members without management permission see the read-only brief there
and cannot submit edits. Task detail editors retain their original disclosure.

The default Workspace tab contains:

- A concise brief with description and responsible people.
- A journal for short notes, questions, decisions, and progress updates. Only the
  body is required; entries default to Note. Links are clickable and content is
  escaped plain text, not executable HTML.
- Replies, answered/reopened questions, type filters, permalinks, and pagination.
- Phase changes with an optional reason. Each journal entry retains the phase in
  which it was written; changing phase does not relabel old discussion.

The journal uses a compact composer and a single divided feed, rather than a
separate padded card and reply box for every entry. Entry bodies remain fully
visible. Reply threads start collapsed; select **Reply** or the reply count to
expand one (mouse, touch, Enter or Space). Submitting a reply reopens just that
thread via its stable entry ID in the URL, preserving the type filter and page.
Validation errors keep that thread open and retain the draft. Other threads
stay collapsed, and phase-change SSE patches preserve an open thread and draft.

The former desired outcome, scope, constraints, and checkpoint/date fields are
no longer shown or editable in the web UI. Existing stored values are retained;
saving ordinary project details does not clear them. Existing MCP fields remain
available for compatibility.

Text boxes support **Ctrl+Enter** (or **Cmd+Enter** on Mac) to submit their
own form, including journal entries, replies, detail editors, and drawers.
Plain Enter still inserts a newline in text areas. The shortcut uses the normal
submit action and validation, and never skips a disabled primary action to
invoke a secondary one.

The lifecycle strip is interactive for project managers: hold a phase for about
350 ms to move there. Its fill shows progress; releasing early, moving away,
scrolling, Escape, or losing focus cancels without a write. Keyboard users can
hold Space or Enter. A saved transition gets a small checkmark/pulse/sparkle;
reduced-motion users get a static confirmation instead. Nothing celebrates
until the server commits, and failures leave the current phase unchanged.

The gesture uses the existing `nano-commit` → Datastar/SSE bridge, patching only
the phase strip/badge, confirmation, and applicable journal entry. Unposted
notes, tab/filter, focus, and horizontal scroll are preserved. The separate
phase-control sidebar card is not displayed; use the lifecycle buttons to change
phase and journal entries to document the context. Parked/Dropped remain available
through the existing phase API/MCP tools.

Plan contains tasks and milestones only, using the existing scheduling tools
and task detail editors. GitLab issues, project binding settings, refresh/state
filters, and issue transfers live exclusively on the GitLab tab; chart summary
links and post-action redirects target it.

The GitLab tab appears only when the current workspace has a saved
GitLabConnection. A disconnected configuration retains the tab and cached issues;
a workspace with no configuration gets neither tab nor panel, even when another
workspace is configured. A direct unavailable/unknown tab falls back to Workspace.
Tabs wrap naturally on small screens.

Workspace PMs can create named projects directly in the library; existing chart
creation remains available to all members. PMs and responsible people manage the
brief and phase. All workspace
members can contribute entries and replies. Question authors and project
managers can mark questions answered or reopen them. All reads and writes are
scoped through the current workspace, including replies and resolution actions.

The journal and new brief fields are internal even when the project is visible
on a public roadmap. The existing public project description remains public
when explicitly enabled; nothing in the journal is published automatically.

MCP project DTOs expose phase and brief fields. `list_projects` accepts a phase
filter; `update_project` updates brief fields; `set_project_phase` records a
transition and reason. Phase changes use the same permissions, optimistic
revisions, operation receipts, and GitLab checks as other project mutations.

## Checks

```sh
cd e2e && npx playwright test tests/nano-pm.spec.js --grep 'project workspace|MCP projects start'
cd e2e && npx playwright test tests/nano-pm.spec.js
uv run ruff check .
```

The responsive workspace test writes light/dark desktop/mobile screenshots into
its Playwright output directory for visual inspection.
