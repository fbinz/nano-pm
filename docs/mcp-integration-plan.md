# Django MCP integration plan

Status: implemented with reads and mutations in the initial release. See
[the operator/API documentation](mcp.md) for actual setup, argument conventions,
limits and verification. Authentication supports both expiring pasted bearer tokens
and django-mcpz OAuth with login, explicit consent, refresh and revocation.

## Scope and architecture

Expose nano-pm application operations through one authenticated `/mcp` endpoint,
using `django-mcpz` inside the existing synchronous Django/Gunicorn deployment.
No separate process, ASGI conversion, generic ORM tool, or Datastar endpoint proxy.

All tools below belong to the initial implementation scope. Implementation is
sequenced for reviewability, not split into a read-only release and later writes.
Credential administration and browser presentation controls are deliberately out
of scope; see the exclusions below.

Suggested structure:

- `src/interfaces/mcp/server.py`: server construction, registration, instructions.
- `src/interfaces/mcp/auth.py`: token authentication and access-policy checks.
- `src/interfaces/mcp/schemas.py`: shared typed inputs/results.
- `src/interfaces/mcp/tools/`: domain adapters and schemas, split by domain.
- `src/interfaces/mcp/mutations.py`: transactions, revisions, retry protection.
- `src/readers/mcp/`: explicit, paginated, workspace-filtered DTO queries.
- `src/permissions.py`: shared application permission predicates.
- `src/actions/manage_workspaces.py`, `manage_subscriptions.py`, etc. where
  existing web views currently contain business mutations directly.
- Models/migrations in `src/data/` for MCP token policy and mutation receipts.
- `docs/mcp.md`: deployment, permissions, token lifecycle and client examples.

Add and lock `django-mcpz`, install its main and bearer-token apps, and migrate.
At planning time PyPI reports 1.2.0, requiring Django >=5.2 and Python >=3.11;
`uv.lock` already has Django 6.0.5. Verify against the selected release before
implementation. Route `/mcp` without a trailing slash; MCP and OAuth are always
available without an opt-in setting. Keep the existing WSGI stack.

## Authentication and authorization

Transport authentication supports django-mcpz bearer tokens and OAuth. Tokens are
hashed, per client, explicitly expiring and independently revocable. OAuth uses the
existing Django login and explicit workspace/capability consent, authorization code
with S256 PKCE, rotating refresh tokens and revocation. No browser-cookie fallback
is accepted by the MCP endpoint itself.

`WorkspaceMiddleware` runs before bearer authentication and can contain another
browser user's context. Clear/ignore that context for MCP, authenticate the
bearer user, and resolve workspace membership from explicit arguments on every
call. Never use `active_workspace_id` or modify browser UI session state.

An application policy is associated with each pasted bearer token or OAuth code
family. Hourly OAuth refreshes retain the same policy, rate budget and receipts:

- Explicit allowed workspaces, intersected with the user's current memberships.
- Capabilities: `core.read`, `core.write`, `workspace.admin`, `workload.self`,
  `workload.manage`, `sharing.links`, `workspace.create`.
- Missing policy denies access. Normal integration tokens receive explicitly
  selected workspaces and core read/write; sensitive capabilities are opt-in.
- Workspace creation is a separate global capability. Creating a workspace adds
  its PM membership and token-policy binding atomically; no implicit access to
  other workspaces the user later joins.
- Capabilities only restrict access; they never grant a role or membership.
- Token-policy changes are operator/admin operations, not MCP tools.

Every workspace tool requires `workspace_id`. Exceptions: `get_me`,
`list_workspaces`, and `create_workspace`. Moves also require an explicitly
permitted `target_workspace_id`. Foreign/inaccessible object IDs use the same
not-found response as missing IDs. Check every related ID, including filters.

Permission vocabulary used in the catalog:

- **R**: `core.read` plus current membership and token workspace access.
- **W**: `core.write` plus the operation's application predicate below.
- **PM**: current workspace PM. Administrative operations also require
  `workspace.admin`, except workload management which uses `workload.manage`.
- **Project manager**: workspace PM or explicitly responsible person.
- **Task manager**: existing `can_manage_task` semantics: project manager,
  task assignee, or a member for an unassigned task.
- **Ideas**: PM or the corresponding existing Django idea model permission;
  token capability and workspace membership still apply.
- **Self**: only the authenticated user's own records; no caller-supplied actor.

Proposed MCP policy deliberately tightens some existing web mutation endpoints:
project creation/reordering and people/team edits require PM; project edits
require project management; task creation requires target-project management;
task updates/deletes require task management; milestone edits require project
management (and task management when changing a linked task); dependency writes
require task management for both endpoints. Moving tasks/milestones between
projects requires management of source and destination projects. Automatic
schedule cascades are documented consequences within the authorized workspace,
not separate user-authored edits needing individual assignee approval.

Preserve explicit self-claim paths for unowned projects/unassigned tasks.
Do not silently copy the fact that several current web endpoints only enforce
login. Extract existing predicates and document/test these additional MCP
restrictions. Broader web permission hardening is a separate change, not an
incidental rewrite during integration.

`permission=` filters tool discovery using capabilities and whether any allowed
workspace could permit the operation. Object-level and exact workspace checks
always happen inside the call, including direct calls to undiscovered tools.

## Shared tool contract

- Typed `msgspec` inputs and explicit output DTOs; reject unknown fields.
- IDs are positive integers; dates are ISO `YYYY-MM-DD`; timestamps include zone.
- Task intervals are `[start, end)`, with exclusive end dates and derived status.
  Never offer a writable task `status` field.
- List tools accept bounded `limit` (default 25, maximum 100) and opaque cursor,
  with deterministic ordering and filters bound into the cursor. No unbounded
  nested workspace dump. Text descriptions/bodies belong in detail results.
- Patch semantics: omitted = unchanged; null clears only nullable fields;
  an empty array clears a relationship. Never use action-layer sentinel `0` in
  the public API. Reject empty patches and invalid references instead of silent
  filtering, coercion or partial success.
- Each object detail includes a revision covering relevant scalar and relation
  state. Existing `updated_at` alone is insufficient: some relation changes and
  actions do not update it. Use a deterministic state fingerprint checked inside
  the transaction, with aggregate revisions for ordering/settings/bulk changes.
- Updates/deletes require `if_match`; bulk tools require revisions for every
  explicit target. Responses return committed state/new revisions, deleted IDs,
  and bounded summaries of affected tasks/milestones plus a continuation path.
- Every mutation requires a client-generated `operation_id` UUID. Store a receipt
  keyed by token/tool/workspace/operation ID, argument hash and safe result in
  the same database transaction as the action. Matching retries replay the
  result; a changed payload is a conflict. Recheck current access before replay.
  Document a seven-day replay window and cleanup; do not claim exactly-once
  execution beyond receipt retention.
- Creation with several fields/relationships is atomic even where it composes
  multiple existing action functions. Conversion, bulk moves, notifications,
  audit writes and receipts share that transaction.
- Structured tool errors: `not_found`, `forbidden`, `validation_error`,
  `conflict`, `cycle_detected`, `reason_required`, `feature_disabled`.
  Preserve JSON-RPC envelopes and return expected domain failures in-band.
- Mark reads `read_only`; flag deletion, transfer, privilege, publication and
  disruptive operations as destructive. These are client hints, not consent or
  authorization enforcement. Do not rely on an LLM-supplied confirmation boolean
  as proof of human approval. Client-side approval policy remains necessary.
- Actor always comes from the authenticated user. No raw credentials, arbitrary
  queryset parameters, arbitrary URLs to fetch, arbitrary SQL or code execution.

Common arguments above are omitted from the catalog's input column for brevity.
Every mutation below includes operation ID and appropriate revision checks.

## Complete initial tool catalog

### Identity, workspaces and history

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `get_me` | Minimal user identity, granted capabilities; no contact addresses | Authenticated |
| `list_workspaces` | Accessible workspace summaries and current roles | Policy intersected with membership |
| `get_workspace` | Safe workspace details and effective permissions | R |
| `create_workspace` | `name`; creates workspace and PM membership | `workspace.create` |
| `update_workspace` | Patch `name`, `prompt_milestone_move_reason` | PM + admin |
| `list_activity` | Entity type/ID, actor and date filters; redacted changes | R; idea/workload visibility rules also apply |
| `get_schedule` | Bounded date window, optional project IDs; task/milestone/dependency page and workspace-local today | R |

### Projects

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `list_projects` | Search, completed state, responsible person/team | R |
| `get_project` | Project details, responsible IDs, counts; children via list tools | R |
| `create_project` | `name`, optional description/color/responsible IDs | W + PM |
| `update_project` | Patch name/description/color/responsible IDs | W + project manager |
| `claim_project` | Project ID; claim self only if no responsible people | W + linked workspace person |
| `set_project_completed` | Project ID, explicit `completed` boolean, not toggle | W + project manager |
| `reorder_projects` | Ordered, unique workspace project IDs; omitted IDs retain relative order | W + PM |
| `move_project_to_workspace` | Project ID, destination; return remapping/detachment summary | W + PM in both; admin capability |
| `delete_project` | Project ID; return child deletion/detachment summary | W + project manager |

Workspace transfer preserves existing action semantics: internal dependencies
move, external dependencies are removed, assignees/responsible people remap by
linked user, subscriptions clear, GitLab source ownership retires, and workload
project references detach. Make these consequences explicit in its description.

### Tasks and scheduling

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `list_tasks` | Project, assignee/team, derived status, text, date-overlap filters | R |
| `get_task` | Details, assignees, linked milestone, predecessor/successor IDs | R |
| `create_task` | Project, title, start/end; optional description/assignees/milestone | W + target-project manager |
| `update_task` | Patch title/description/start/end/project/assignees/milestone | W + task manager; project-transfer checks |
| `claim_task` | Task ID; assign self only when unassigned | W + linked workspace person |
| `move_task` | Task ID, `new_start`; preserve duration, run cascade | W + task manager |
| `move_tasks` | Bounded task ID/revision list, common `delta_days`; all-or-nothing | W + task manager for every target |
| `delete_task` | Task ID; disclose linked milestone deletion and dependency removal | W + task manager |

Resize is expressed through `update_task`, not duplicate gesture-shaped tools.
Reject end <= start rather than silently normalizing it. All task modifications
use existing cascade/synchronization paths and expose resulting committed dates.

### Milestones and dependencies

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `list_milestones` | Project/date window/linked-task filters | R |
| `get_milestone` | Details, linkage, move-reason requirement and visible history | R |
| `create_milestone` | Project, title, date; optional description/task/reason requirement | W + project manager; reason-policy changes PM-only |
| `update_milestone` | Patch title/description/date/project/task/reason requirement, `move_reason` | W + project manager; linked-task checks; reason-policy changes PM-only |
| `delete_milestone` | Milestone ID; remove milestone, not linked task | W + project manager |
| `list_dependencies` | Optional project/task filters; explicit predecessor/successor | R |
| `add_dependency` | Predecessor/successor IDs; return edge and cascade summary | W + both task-manager checks |
| `delete_dependency` | Predecessor/successor IDs | W + both task-manager checks |

Milestone moves must validate the existing reason rule (at least three trimmed
characters when required). Linked milestones follow task end dates. A direct
linked-milestone move changes the task end through the existing action, not by
independently editing its date. Validate linkage constraints and cycle prevention.
Existing cascade-triggered milestone notifications retain their current behavior;
do not invent a new reason requirement for every derived cascade effect.

### People, teams and membership

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `list_people` | Name/team/linked-account filters; minimal assignment identities | R |
| `get_person` | Person name, team IDs, linked-account presence; not private contact data | R |
| `create_person` | Name, optional team IDs; no Django account creation | W + PM |
| `update_person` | Patch name/team IDs | W + PM |
| `delete_person` | Person ID; disclose assignment/responsibility removal, not account deletion | W + PM |
| `list_teams` | Search, minimal member IDs/counts | R |
| `create_team` | Name | W + PM |
| `update_team` | Team ID, name | W + PM |
| `delete_team` | Team ID; detach memberships without deleting people | W + PM |
| `list_memberships` | Membership ID, linked person/user label, role, workload participation | PM + admin |
| `set_member_role` | Membership ID, explicit `pm`/`member` role | PM + admin; cannot demote last PM |
| `create_person_invite` | Person ID; get/create invitation and explicitly return sensitive invite URL | PM + admin + sharing.links |

Role changes must resolve membership directly, including users with no Person
record; refactor the existing person-based action into a shared membership action
rather than creating a second last-PM protection implementation. Person deletion
must not be confused with revoking a Membership or disabling a user account.

### Ideas

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `list_ideas` | Search/status/tag filters | R + idea view permission |
| `get_idea` | Title/body/status/tags/creator/conversion IDs | R + idea view permission |
| `create_idea` | Title, optional body/tags; creator = caller | W + idea add permission |
| `update_idea` | Patch title/body/status/tags | W + idea change permission |
| `convert_idea_to_project` | Idea ID, optional project name | W + idea change permission + project-create permission |
| `convert_idea_to_task` | Idea ID, target project, dates, optional title | W + idea change permission + target-project manager |
| `delete_idea` | Idea ID; keep previously converted project/task | W + idea delete permission |

Conversions must reject already-converted ideas unless an explicitly documented
supported transition is intended, and be atomic with content copy and activity.
Use `update_idea` for status changes rather than exposing a redundant tool.

### Workload

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `get_my_workload` | Own latest estimate, editable categories/projects, check-in state | Self + workload.self + participation |
| `submit_my_workload` | Category/project percentage allocations, `checkin` boolean | Self + workload.self + participation |
| `review_my_workload` | Copy own latest estimate into new reviewed snapshot | Self + workload.self + participation |
| `snooze_my_workload_checkin` | Fixed seven-day snooze, matching current app | Self + workload.self + participation |
| `get_workload_overview` | Optional team/member filters; current aggregate view | PM + workload.manage |
| `list_workload_reports` | Member/date filters; paginated immutable snapshots | PM + workload.manage |
| `get_workload_report` | Report ID; own report or PM-accessible report | workload.self + self, or PM + workload.manage |
| `get_workload_settings` | Enabled flags, check-in interval, participation defaults | PM + workload.manage |
| `update_workload_settings` | Typed patch to those settings only | PM + workload.manage |
| `list_workload_categories` | Category ID/name/active/supports-projects/order | Participant + workload.self, or PM + workload.manage |
| `create_workload_category` | Name/active/supports-projects | PM + workload.manage |
| `update_workload_category` | Patch category name/active/supports-projects | PM + workload.manage |
| `delete_workload_category` | Category ID; preserve historical snapshot labels/values | PM + workload.manage |
| `set_workload_participation` | Membership ID, `inherit`/`included`/`exempt` | PM + workload.manage |

Use integer percentages, require category total 100, and require project
allocations not to exceed their category. Validate projects/categories in the
workspace, preserve immutable snapshots and clear snooze after successful check-in.
Never accept a different user's ID for self-service submission/review/snooze.
Typed patches must not accidentally clear unrelated HTML checkbox settings when
adapting to the existing form-shaped action inputs. No generic report mutation.

### GitLab integration

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `get_gitlab_connection` | Safe configured/enabled/sync status and source IDs; never credential fields | PM + admin |
| `list_gitlab_issues` | Owner project/state/text filters; cached workspace data only | R |
| `get_gitlab_issue` | Cached issue details, URL, owner, state, execution intervals | R |
| `get_project_gitlab_binding` | Project ID; prefix and collection setting | R |
| `update_project_gitlab_binding` | Project ID, prefix/collect patch | W + project manager |
| `transfer_gitlab_issue` | Issue ID, destination project; local ownership only | W + source and destination project managers |
| `request_gitlab_sync` | Queue durable sync; return request/status, do not poll synchronously | PM + admin |
| `update_gitlab_workflow` | Typed workflow label mapping | PM + admin |

Keep existing ownership/prefix-conflict/completion rules. These tools do not edit
remote GitLab issues and never perform arbitrary outbound requests. Operators
still configure instance credentials in the browser. Extract safe settings actions
from web views, with actor-aware audit for exposed mutations that lack it today.

### Notifications, subscriptions and public sharing

| Tool | Main inputs / result | Access |
| --- | --- | --- |
| `get_notification_settings` | Event preferences, allowed subscriber domains, configured boolean only | PM + admin |
| `update_notification_settings` | Patch event preferences/allowed subscriber domains; no webhook URL | PM + admin |
| `list_notification_deliveries` | Status/date filters; safe status/timestamps/error classification, no raw payloads | PM + admin |
| `list_my_project_subscriptions` | Caller-owned followed projects | R |
| `set_my_project_subscription` | Project ID, explicit `subscribed` boolean; enabled-roadmap/active-project rules | W + self |
| `get_public_roadmap_settings` | Enabled/title/description; no bearer URL/token | PM + admin |
| `update_public_roadmap_settings` | Patch enabled/title/description; first enable generates token internally | PM + admin |
| `get_public_roadmap_link` | Explicitly return current enabled roadmap URL | PM + admin + sharing.links |
| `rotate_public_roadmap_link` | Replace token and enable roadmap, matching current behavior; return new URL | PM + admin + sharing.links |

Sensitive invitation/roadmap links are available only through their explicit tools,
never embedded in generic object results, error logs or activity snapshots. Mark
responses non-cacheable and avoid retaining their raw URLs in mutation receipts:
store a reference/version and reconstruct only after rechecking access, failing
safely if the link has since rotated. Report rotation/publication consequences.
No management of anonymous visitors' subscriptions through MCP.

## Intentionally not tools

- Browser-only zoom, sidebar width, expansion, filter toggles, popovers/drawers,
  workspace switching, overlay toggles or HTML/SSE rendering.
- Password/login/session management, account email/profile changes, arbitrary
  account creation/deactivation, MCP token/policy administration or Django admin.
- GitLab token/instance credential setup, webhook URL setup, encryption keys,
  raw delivery payloads, public-visitor emails or capability-cookie management.
- Workspace deletion or member removal: these are not supported application
  actions today. Do not invent a new destructive domain operation incidentally.
- Generic batch commands, SQL/ORM execution, code evaluation, arbitrary URL fetch,
  background worker controls, or remote GitLab issue edits.
- Separate resize/status/toggle tools when a typed update or explicit set operation
  already expresses the same domain operation.

## Implementation sequence (one feature release)

1. Dependency/configuration, token policy, auth boundary, protocol smoke test.
2. Shared permissions, DTO readers, schema conventions, revision/receipt storage.
3. Projects/tasks/milestones/dependencies: reads and writes together, cascading
   tests, destructive consequences and transfer behavior.
4. People/teams/membership and ideas: reads/writes, last-PM protection, conversions.
5. Workload tools with privacy, immutable-report and total/percentage tests.
6. GitLab, notification/subscription and sharing tools; extract web-only actions
   without duplicating business rules or weakening existing network protections.
7. Audit/redaction, real-client interoperability, deployment and operator docs.

These are review/test checkpoints, not reasons to ship a read-only endpoint first.

## Verification and acceptance

Follow repo Playwright red/green TDD in `e2e/tests/nano-pm.spec.js`, using worker
servers and `djangoEnv()` for token/policy setup. Add shared JSON-RPC helpers.
A missing endpoint must first fail with a clear HTTP assertion, not a timeout.

For every tool family cover successful calls and unauthenticated, wrong-workspace,
wrong-capability and wrong-role cases; direct calls must not bypass discovery.
Include cookie/bearer user mismatch, session-workspace mismatch, revoked/expired
credentials, inactive users, removed memberships and missing policy.

Mutation tests must verify committed database/browser state after reload, correct
actor/history/outbox effects, no partial writes on invalid relationships, retry
replay, changed-payload conflicts, stale revisions and simultaneous conflicting
writes. Test task-exclusive dates, cycles, cascading/linked milestones and reasons,
completion-prefix conflicts, cross-workspace transfer detachments, all-or-nothing
bulk moves, conversion retries, last-PM demotion and non-account person deletion.

Privacy tests must enumerate fields and confirm ordinary read tokens cannot see
workload reports, memberships, private contact data, source tokens, webhooks,
invitation/public-roadmap URLs or raw notification payloads. Sensitive-link replay
must not restore a rotated/invalidated credential. Redact activity separately;
existing audit records can contain fields that generic MCP reads must not expose.

Run the main behavioral regression suite plus Ruff. Verify actual target clients
against django-mcpz's stateless JSON HTTP transport and legacy initialization; do
not assume SSE/resources/prompts are implemented. Reject invalid Origin headers,
retain strict ALLOWED_HOSTS, require production HTTPS, bound request/output sizes
and bulk sizes, and set rate limits/timeouts appropriate for SQLite/Gunicorn.

Log tool, actor/token identifiers, workspace, outcome and duration, but not raw
arguments, sensitive results or exception bodies. Use the existing activity log
for business changes and a redacted MCP call log for denied/read calls. Schedule
expired/revoked token and receipt cleanup. Endpoints are always mounted; calls
still require authentication and an explicit access policy.
Document how existing browser pages observe MCP changes (reload/next render;
no cross-client live broadcast is promised).

## References

- https://django-mcpz.readthedocs.io/en/latest/servers.html
- https://django-mcpz.readthedocs.io/en/latest/bearer_tokens.html
- https://django-mcpz.readthedocs.io/en/latest/oauth.html
- https://django-mcpz.readthedocs.io/en/latest/protocol.html
- https://pypi.org/project/django-mcpz/
