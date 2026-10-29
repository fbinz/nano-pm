# GitLab integration — implementation plan

Status: implemented. Setup and operational behaviour are documented in
[gitlab-integration.md](gitlab-integration.md). The sections below preserve the
implementation design and verification strategy.

## Goal and agreed behaviour

Automatically collect GitLab issues into nano-pm projects using existing issue-title
prefixes, and display implementation progress alongside the planned tasks.

- Configure a GitLab title prefix per nano-pm project; no new labels or identifiers
  are required in GitLab. Repository membership does not establish project membership.
- A matching, unassigned issue belongs to the active project collecting that prefix.
- Store ownership. Subsequent syncs must not independently rematch an assigned issue.
- Completing a project stops collection, but preserves its issues. Continue refreshing
  their GitLab states, including closures and reopenings.
- A new active project can reuse the prefix and collect all matching, unassigned
  issues, including older issues. No handover dates or creation-date filters.
- GitLab workflow labels map to configurable nano-pm issue states. Closed means done.
- GitLab execution data must not change task dates, task status, milestones,
  dependencies, or project completion.

## Proposed v1 defaults

These bound the initial implementation rather than adding requirements to GitLab.

1. One GitLab connection per workspace, supporting GitLab.com or a self-hosted
   instance. A PM selects the groups/repositories the connection may search. This
   is a discovery/access boundary, not a project-matching rule.
2. One literal prefix per nano-pm project. Parse the issue title before its first
   colon; compare after trimming and case-folding. For example, `Portal: Login`
   matches `portal`, but `Portal Admin: Login` does not. No regexes, nested prefixes,
   fuzzy matching, or AI.
3. A project has a configurable collection toggle. Collection is effective only
   while the project is not completed. Only one effective collector per normalized
   prefix is permitted within the connection's shared search scope.
4. Workflow mappings are connection defaults, with optional per-project overrides.
   Initial mappings: `In Development` → in progress; `Next Deployment` → done.
   Other labels and an optional not-started state are configurable.
5. State precedence: GitLab closed > configured done label > in-progress label >
   not-started label > configurable fallback (initially unclassified). Workflow
   labels match exactly, not by title-prefix normalization.
6. Read-only GitLab API access, background polling, and a manual sync request.
   Webhooks, OAuth, write-back, and task-level issue ownership are outside v1.

## Data model and invariants

Add `src/data/models/gitlab.py`, exports in `src/data/models/__init__.py`, and migrations.

- **GitLabConnection:** workspace, normalized instance URL, protected credential,
  explicit search scope, default workflow mapping, enabled state, configuration
  revision, last success/error, next run, and durable sync/lease metadata.
- **GitLabProjectBinding:** nano-pm project, connection, displayed/normalized prefix,
  collection preference, effective collection state, and optional workflow override.
- **GitLabIssue:** connection, GitLab numeric project ID and issue IID, title, URL,
  labels, GitLab state, source timestamps, current nano-pm issue state, owner project,
  ownership disposition, and last successful refresh.
- **GitLabIssueEvent:** source identity, event type, timestamp, and minimal data for
  label and closed/reopened transitions. Deduplicate source events on import.

Enforce unique issue identity on `(connection, GitLab project ID, IID)`, not IID alone.
Use one owner field, not many-to-many ownership. Enforce a unique effective prefix
collector in the database; update that state atomically with completion, reopening,
connection settings, and prefix edits. Do not rely only on form validation.

Distinguish unassigned issues from retired associations. Deleting a project must
not turn its former issues into fresh candidates. Preserve a minimal ownership
record with a null owner and retired disposition. Replacing credentials for the
same instance must not reset issue identities or ownership.

## Matching and project lifecycle

Implement matching/ownership in `src/actions/gitlab_matching.py`, integrated with
`src/actions/manage_projects.py`.

For each discovered issue:

1. Upsert source metadata.
2. If owned or retired, preserve ownership regardless of title changes or project
   completion; update execution state only.
3. Otherwise, parse its prefix and find the effective collector.
4. Atomically assign it, conditional on still being unassigned and the collector
   still being eligible. No match means no assignment; a conflict is surfaced,
   never resolved by project order or creation time.

Prefix edits and new bindings trigger discovery/backfill and reevaluation of
unassigned candidates, even when those issues have not recently changed in GitLab.
Owned issues whose titles no longer match remain visible with an explanatory badge.
Provide an explicit, permission-checked move to another project in the same workspace;
manual moves persist through later syncs.

Completing releases the effective prefix claim. Reopening reacquires it only if
there is no conflict; otherwise explain that collection must first be disabled or
the prefix changed. Apply the same invariant to every completion/reopening endpoint.

On a cross-workspace project move, remove its binding and retire its source-workspace
associations before the move. Do not carry GitLab credentials or private issue data
into the destination workspace; show a confirmation explaining this consequence.

## Workflow history and dates

Implement a deterministic event reducer in `src/actions/gitlab_workflow.py`.

- Import GitLab label events and closed/reopened events. Do not infer work start
  from issue creation or generic `updated_at`.
- Replay configured rules chronologically to derive execution intervals. Preserve
  multiple work cycles rather than overwriting one start/end pair.
- Entering done closes an in-progress interval. A later closure does not move an
  already-recorded done time. Reopening alone does not imply in progress if a
  configured done label is still present: use the same precedence consistently.
- Missing history remains unknown. An observed in-progress state without a known
  start must not acquire a fabricated start date.
- Changing workflow mappings replays cached events under the new mapping; it does
  not invent a transition at configuration-save time. Mark derived results with
  the mapping revision and rebuild them atomically per issue.

## API client and synchronization

Add `src/interfaces/gitlab/client.py`, `src/actions/gitlab_sync.py`, and management
command `sync_gitlab` with continuous and `--once` modes.

- Initial discovery includes open and closed issues, with complete pagination.
  Apply exact prefix matching locally even if API search is used to narrow results.
- Subsequently poll updated issues with overlap and durable per-source checkpoints.
  Repeated pages/events must be harmless. Advance checkpoints only after successful
  persistence; configuration changes trigger the required backfill.
- Refresh owned issues independently of their current prefix and project completion.
  Fetch/cache history for associated issues rather than importing every issue's
  full history across the search scope.
- A permission loss, 404, or temporary outage marks source data unavailable/stale;
  it must not unassign the issue, mark it done, or erase its cached history.
- Use bounded HTTP timeouts, pagination guards, Retry-After/backoff for rate limits,
  and sanitized error categories. Authentication errors pause sync until corrected.
- Claim a durable lease; perform network I/O outside SQLite write transactions.
  Recheck configuration revision and eligibility when committing assignments.
  Handle SQLite contention without replaying successful network work unnecessarily.
- Manual sync queues durable work; no API calls during normal chart rendering.

Run the worker as a separate process through `src/run_services.py`, following the
existing Teams worker pattern. Add a local `just gitlab-worker` command and deployment
instructions. Show queued/running/stale/failed status and last successful sync.

## Settings and presentation

- Add PM-only workspace connection/workflow settings via
  `src/interfaces/web/gitlab.py`, `src/interfaces/web/urls.py`, and new templates.
- Extend project settings in `src/interfaces/web/detail_forms.py`,
  `src/interfaces/web/projects.py`, and the project detail template with prefix,
  collection toggle, optional workflow override, and a matching-title preview.
- Add a cached issue list on project details: GitLab reference, title, interpreted
  state, timing, stale/mismatched-prefix indicators, and explicit project transfer.
  Counts describe issue completion, not an estimate of completed effort.
- Add a collapsed-by-default GitLab execution section below each project's planned
  task rows. Read-only bars span inclusive local-day boundaries, so same-day work
  and lone known boundaries occupy a whole day without changing source timestamps.
  Issues without usable dates remain accessible
  in the issue list/undated section. Never invent durations.
- Persist expansion through Datastar patches using session-backed UI state. An
  explicit refresh after worker completion reloads cached data; live push is not
  required in v1. Keep issue history from automatically stretching the planned
  chart range; clip out-of-range intervals and expose their dates in details.
- Extend `src/readers/chart.py`, `src/readers/chart_view.py`, and
  `src/templates/components/screens/gantt/`. Update dependency-arrow row offsets
  both in `chart_view.py` and `src/static/js/nano.js`: both currently count task
  and spacer rows explicitly. Issue rows must never participate in drag, resize,
  dependency creation, task selection, or task-creation gestures.
- Respect existing project/team/completed visibility; task-status filters do not
  reinterpret GitLab execution states. Leave resource and kanban views unchanged.
- Put source styles in `src/css/input.css`; regenerate CSS and translations using
  the repository commands. Use informal singular German UI copy.

## Security and access

- Credentials use a read-only GitLab API scope with only the intended source access.
  For v1, cache visibility follows workspace membership, not each viewer's GitLab
  permissions. State this explicitly when connecting and selecting sources.
- Protect stored tokens with established encryption and a deployment-managed key;
  never render saved tokens, include them in activity snapshots, or log raw bodies.
- HTTPS in production. Validate configured instance origins and outbound targets;
  self-hosted private-network access requires explicit deployment authorization.
  Do not forward credentials across redirects or trust arbitrary API-provided URLs.
- Scope every lookup, settings action, sync job, manual transfer, and chart query to
  its workspace. Only PMs configure connections/rules; project managers configure
  their authorized bindings. GitLab metadata never appears on public roadmaps.
- Disconnect stops sync and clears the credential without making existing issues
  unassigned. Reconnecting the same source preserves associations. Changing the
  instance requires an explicit reset/archive flow, not relabelling cached identities.

## Delivery sequence and verification

Use small vertical slices. For each behaviour, add a Playwright test in
`e2e/tests/nano-pm.spec.js`, demonstrate the expected red failure, implement the
smallest green change, then run the main behavioural spec.

1. **Connection and test infrastructure:** fake GitLab HTTP server on an ephemeral
   port, secure settings, permissions, credential redaction, and sync `--once`.
2. **Prefix collection:** initial import through the project issue list, pagination,
   normalized exact matching, duplicate IIDs across repositories, and idempotency.
3. **Stable ownership:** title edits, completion/reuse, old unassigned issues,
   reopening conflicts, concurrent claims, manual transfers, deletion, and workspace
   moves. This is the primary acceptance milestone before timeline work.
4. **Workflow interpretation:** configurable mappings/overrides, conflicting labels,
   closed precedence, real transition dates, repeated cycles, missing history,
   mapping changes, and event deduplication.
5. **Reliable polling:** incremental updates, configuration-triggered backfill,
   auth/rate-limit failures, stale state, restarts, and worker lease/SQLite contention.
6. **Execution overlay:** persistence through SSE patches, zoom/scroll, collapse,
   completed/team filtering, correct dependency arrows below issue rows, and no
   accidental drag/task creation from issue interactions.
7. **Deployment/documentation:** supervisor integration, worker commands, initial
   setup, token rotation, prefix reuse, visibility model, failure recovery, and i18n.

Tests must never contact real GitLab. Use `appPage` resets, worker-local fake servers,
`djangoEnv()` for subprocesses, and committed DOM data attributes for assertions.
Do not start a continuously polling worker in ordinary e2e tests; execute `--once`
deterministically. Focused pure tests can supplement Playwright for prefix parsing
and event reduction, but do not replace browser coverage of integration flows.

Final checks: `cd e2e && npx playwright test tests/nano-pm.spec.js`, relevant screenshot
specs for the chart, and `uv run ruff check .`. Verify migrations and production
worker startup separately. No existing project starts collecting until configured.

## Completion criteria

A PM can connect a source, configure a prefix and workflow, and see matching issues
with execution progress. Completing project A and creating project B with the same
prefix preserves A's ownership while B automatically receives matching unassigned
issues, including older ones. Repeated syncs, restarts, title changes, and GitLab
reopenings never duplicate or silently transfer ownership. The execution layer does
not alter the plan or break existing chart interactions, and private data remains
workspace-scoped.
