# Workload estimates

Workload estimates describe a member's typical current workload as percentages.
They are not timesheets, hours, utilization measurements, or automatic estimates
from Gantt task durations. Estimates remain current until replaced or reviewed.

## Setup

Run `just migrate` after deploying. Existing and new workspaces start with the
feature disabled. A workspace PM can open **Workload settings** to enable it.
The reporting toggle and both participation-default toggles save immediately,
without a Save button or a page reload. Each toggle updates only its own setting
and shows a dismissible success toast. The overview navigation updates immediately.
On first enable, an empty category list receives Maintenance, Project work and
Meetings, which appear immediately. Categories are shown in an editable table. Existing names save when
you leave the cell; their Active and project-breakdown checkboxes save
immediately, without a page reload. The final table row adds a category using
the same columns and an Add category button, then resets for the next entry.
Successful saves show a dismissible success toast naming the category;
validation errors appear beneath the category name, without a separate Status
column. Categories can be added, renamed, archived (uncheck Active), and
configured to allow an optional project breakdown. The trash button beside a
category name permanently deletes it after confirmation. Only workspace PMs
can delete categories. Existing estimates, project breakdowns and history are
preserved with their original category names; members redistribute the deleted
category's percentage when they next edit their estimate. Reviewing an existing
estimate with Still accurate preserves its original allocations.

Members participate by default; PMs are exempt. Change either default or set a
membership override (Inherit, Included, Exempt). The overrides table has one
radio-button column per option; selecting an option saves immediately and shows
a success toast, without a page reload or a separate Save button. Radio groups
are independent for each member. Overrides are workspace-specific.
Settings list all account memberships, including users without a Person profile.
Linked people also have a Workload participation control on the People page.
Exempt PMs can still view the overview. Members cannot read another member's
estimates or edit workspace settings.

Disabling reporting prevents new submissions and reviews, including for members
with an Included override. Existing estimates remain accessible to PMs at
`/workload/overview/`, even while reporting is disabled.

## Reporting

**My workload** is a sub-page of **My profile** at `/profile/workload/`,
not a separate sidebar entry. Participating members can open it from their
profile and return using the My profile link; the sidebar keeps My Profile
highlighted on the sub-page. Exempt members do not see the profile link and
cannot access the sub-page. Old `/workload/` links redirect to the new location;
the old save endpoint remains compatible with existing clients.

The editor pairs a live donut with category sliders and exact percentage inputs.
The donut center always shows the current summed category percentage; remaining
and over-allocation messages appear below it. Empty inputs contribute zero.
A muted remainder shows unallocated workload; overallocated drafts show an explicit
warning rather than a normalized pie. **Fill remaining** assigns the remainder to
one category without changing the others. Hovering/focusing a row highlights its
slice; clicking a slice (or using Enter/Space) focuses its number input. Project
breakdowns expand on demand: unselected projects appear as “+ Project” chips,
and only selected projects expose percentage inputs and a remove button. Adding
focuses a zero-valued input; removing clears its share, restores its chip, and
returns that share to the unspecified remainder. Draft selections survive server
validation errors; saved estimates restore only projects with a nonzero share.
Suggested-project chips also open and select a project without assigning a share.

A thin outer donut ring visualizes project shares aligned to each parent category,
on the same overall-workload percentage scale. A muted outer segment represents
the unspecified category remainder. Project names and shares appear in a legend
even while editing controls are collapsed; clicking a segment or legend entry
opens and focuses its input. Invalid breakdowns are not normalized into misleading
arcs. A small stacked bar also previews the category breakdown inside the editor.
Saving is explicit and disabled for invalid drafts.
The draft preview is reinitialized from server values after SSE patches. Category
rows and sliders have stable IDs so Datastar can morph them in place and preserve
focus. Helper rows reserve space even when hidden to prevent sliders moving during
native pointer drags; already-synced range values are not reassigned by the preview.
The layout stacks on mobile and respects reduced-motion preferences. Percentage
inputs have nonshrinking, three-digit text areas with native steppers hidden;
keyboard arrows and category sliders still provide stepping. These input overrides
live in the utilities layer so DaisyUI cannot override them. Tight project rows
stack their name above the controls based on available container width.

**My workload** accepts whole percentages between 0 and 100. Category shares
must total 100%. Optional project shares are percentages of the entire workload,
not percentages of the category. They cannot exceed the category total; the
remainder is shown as unspecified project work. Suggested projects are advisory:

- unfinished projects with a task assigned to one of the user's workspace Person
  profiles, where `start <= today < end` (task end dates are exclusive);
- unfinished projects where the user is explicitly responsible.

Any unfinished project in the workspace can be selected, regardless of assignment.
No account-linked Person profile is required to report percentages.

Every successful save and **Still accurate** review creates an immutable snapshot.
Reviewing preserves all percentages and historical labels while refreshing the
review date. Editing prefills currently active categories and unfinished projects;
older archived/completed items remain visible in the current estimate/history.
The running form total can therefore change after category configuration changes.

## Overview and history

PMs can filter current membership rows by team and person. Coverage distinguishes
missing reports from exempt members. Averages use the latest snapshot for each
participating respondent only; missing, exempt and former members are not counted
as zero. Percentages are unweighted respondent averages, not absolute team capacity.
Estimates older than 90 days are labelled outdated but remain in the averages.

The overview and personal screen show the latest 20 snapshots. All snapshots are
retained in the database. Snapshot category/project/user labels survive renames or
deletions. Project moves detach historical project links rather than transferring
reports to another workspace. Removing a Person or membership does not delete a
report; deleting a user retains the snapshot with its user label. Deleting an
entire workspace removes its reports.

## Code and tests

- Models/migration: `src/data/models/workload.py`, migration `0024`.
- Writes and validation: `src/actions/manage_workload.py`.
- Project guidance and summaries: `src/readers/workload.py`.
- Web/SSE: `src/interfaces/web/workload.py` and workload Cotton components.
- Draft preview: `src/static/js/workload.js`; styles in `src/css/input.css`.
- Desktop/mobile/theme screenshots: `e2e/tests/workload-screenshot.spec.js`.
- Behavioural tests: `e2e/tests/nano-pm.spec.js`, describe `workload estimates`.

Run focused tests with `cd e2e && npx playwright test --grep 'workload estimates'`.
