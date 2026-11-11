# MCP endpoint

nano-pm exposes 76 explicitly registered tools, including mutations, through
`django-mcpz` at **`/mcp`** (no trailing slash). The tool catalog and permission
matrix are in [the integration plan](mcp-integration-plan.md#complete-initial-tool-catalog).
Input and output JSON schemas are advertised through `tools/list`; both are
validated at runtime. No models are automatically exposed.

Projects now start in the `idea` phase. Use `list_projects` with `phase`,
`update_project` for brief fields (`outcome`, `scope`, `constraints`, `checkpoint`,
`checkpoint_date`), and `set_project_phase` with an optional `reason` to move
through the lifecycle. Completion remains synchronized with
`set_project_completed`. Separate idea/conversion tools have been removed;
existing idea records are not migrated. See [Project workspace](project-workspace.md).

## Setup

MCP and OAuth are **enabled by default**, with no additional environment variable.
Install dependencies/migrations and restart the application:

```sh
uv sync
uv run python src/manage.py migrate
```

Use the normal Django environment for these commands (`DJANGO_SECRET_KEY`, database
path, etc.; local development can use `DJANGO_DEBUG=true`). Existing Docker startup
already applies migrations. No extra server, worker or ASGI deployment is needed.

## Connect using OAuth

Hosted assistants can connect directly to `https://nano-pm.example.com/mcp`.
No pasted token or operator-provisioned policy is needed: the assistant discovers
OAuth, registers itself (or uses a client ID metadata document), opens the existing
Django login, and asks you to approve access.

The consent screen names the unverified client and callback host. Select the
workspaces and permissions to share; **no workspace is preselected**. Only requested
permissions can be approved. Sensitive permissions start unchecked. When a client
omits scope, the available defaults are `core.read core.write`. Decline unexpected
requests. Existing role and object-level permission checks still apply after consent.

OAuth uses public clients with authorization code + S256 PKCE, exact redirect URI
validation, audience-bound opaque tokens, rotating refresh tokens, and revocation.
There are no client secrets or client-credentials grants. Default lifetimes are
five minutes for codes, one hour for access tokens and thirty days for refresh
tokens. Optional Django settings `MCPZ_OAUTH_ACCESS_TOKEN_LIFETIME` and
`MCPZ_OAUTH_REFRESH_TOKEN_LIFETIME` accept `timedelta` values. Registration defaults
to enabled; `MCPZ_OAUTH_DYNAMIC_REGISTRATION=False` disables it, but may prevent
hosted clients from connecting. Metadata-document fetching retains django-mcpz's
public-HTTPS-only, no-redirect network protections.

Endpoints, always mounted:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server/oauth`
- `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`
- `/accounts/mcp/` — your own connections and immediate disconnect, also linked
  from **My profile → Assistant connections**.

OAuth endpoints require HTTPS except on localhost/loopback development hosts.
Configure the trusted TLS proxy so Django sees the external scheme/host correctly;
tokens are bound to the exact MCP origin/path. Do not add wildcard CORS/hosts or
exempt consent from CSRF. Proxy-rate-limit public registration, authorization and
token endpoints. If deploying under a path prefix, route the corresponding
`/.well-known/` documents at the host root as described in django-mcpz's OAuth docs.

A consent policy belongs to the authorization-code family, not an individual
hourly access token. Refresh therefore preserves workspace bounds, request-rate
state and mutation receipts. Refresh can narrow scopes, but cannot expand them;
new memberships do not expand consent. Code/refresh replay revokes the token family.
Disconnect revokes both access and refresh tokens immediately; reconnect to approve
different access. Operators can also inspect/revoke grants without seeing secrets:

```sh
uv run python src/manage.py mcp_access oauth-list
uv run python src/manage.py mcp_access oauth-revoke <POLICY_ID>
```

Browser integration tests exercise the full login/consent/code/refresh/revocation
flow. Hosted services still require a reachable HTTPS deployment; configure your
assistant's connector with `/mcp` and verify its own client-specific flow there.

## Pasted bearer tokens

Developer clients that accept custom headers can continue using one expiring
bearer token per client, as an existing active user:

```sh
uv run python src/manage.py mcp_access create "My assistant" \
  --user alice --workspace 12 \
  --capability core.read --capability core.write \
  --expires-in-days 30
```

The credential is printed once. Store it in your client's secret store; do not
commit it, put it in a URL, or paste it into logs. Only its hash is stored in the
credential table. Workspace IDs must be current memberships of the selected user.
Repeat `--workspace` and `--capability` as needed. Expiry must be 1–365 days.

A token created using django-mcpz's generic admin/command is **not sufficient**:
nano-pm also requires an explicit access policy and a non-null expiry. A missing
policy fails closed. Use `mcp_access` to configure that policy.

## Capabilities

| Capability | Permits, subject to current application permissions |
| --- | --- |
| `core.read` | Safe projects/tasks/milestones/people/teams/activity/cache reads |
| `core.write` | Planning mutations; PM/responsible-person/task-assignee checks still apply |
| `workspace.admin` | PM-only workspace, membership, notification, sharing and GitLab administration |
| `workload.self` | Own workload reads/submissions/reviews/check-ins; reporting participation still applies |
| `workload.manage` | PM-only workload reports, aggregate views, settings/categories/participation |
| `sharing.links` | Additional opt-in for explicit invitation/roadmap link disclosure and rotation |
| `workspace.create` | Create a workspace as its PM; also binds that new workspace to this token |

Capabilities are not hierarchical: an administrative capability does not imply
`core.read`, `core.write`, or access to another user's workload. Effective access
is the intersection of credential/consent policy, token scopes, current user membership and current role/object
permissions. New memberships do not automatically expand a token's allowed workspaces.
`get_me` and `list_workspaces` remain available with an active policy even when no
allowed memberships remain, so a client can discover that its access was removed.

MCP deliberately uses stricter write checks than some older browser endpoints:
project creation/reordering and people/team edits require PM; project edits require
project management; task creation requires target-project management; task edits
require task management; dependencies require management of both endpoints.
Explicit `claim_project`/`claim_task` tools preserve self-service claiming of an
unowned project or unassigned task by a linked workspace person.

## Manage/revoke/clean up

```sh
# Metadata only: never prints stored credential values.
uv run python src/manage.py mcp_access list

# Replaces the entire allowed workspace/capability set, not a partial patch.
uv run python src/manage.py mcp_access configure 7 \
  --workspace 12 --capability core.read

uv run python src/manage.py mcp_access revoke 7

# Schedule daily through the deployment's cron/job runner.
uv run python src/manage.py mcp_access cleanup
```

Cleanup deletes expired/revoked bearer credentials, expired OAuth tokens/codes,
unused registered clients, and mutation receipts older than seven days. Active
OAuth code families remain while tokens still need them for refresh/replay protection.
Bearer rotation means creating a replacement credential, updating the client secret,
then revoking the old credential. Credential administration is never an MCP tool;
OAuth users can disconnect only their own grants through their profile.

## Configure a bearer client

Configure an HTTP MCP client that supports custom headers with:

```json
{
  "mcpServers": {
    "nano-pm": {
      "url": "https://nano-pm.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}
```

Client configuration syntax varies; prefer its secret/environment-variable support
rather than a literal credential in a shared config. Cookie login does not
authenticate MCP. A browser session belonging to another user or workspace never
selects the API workspace.

OAuth and pasted bearer clients share the same endpoint, tool catalog and permission
checks. Browser cookies alone never authorize an MCP call.

The transport is stateless, synchronous JSON HTTP under WSGI. Legacy MCP clients
can initialize with `2025-11-25`, `2025-06-18` or `2025-03-26`; no MCP session ID
is issued. GET/SSE notification streams, subscriptions to server events, resources
and prompts are not provided. Browser Datastar SSE is an unrelated UI transport.

## Calling tools

Start with `get_me` and `list_workspaces`. Every workspace-scoped call requires
`workspace_id`; there is no session/workspace-switch tool. Detail and single-object
mutation tools generally identify their target using **`id`**. Relationship fields
remain explicit (`project_id`, `task_id`, `assignee_ids`, etc.). Always consult the
advertised schema for the exact tool.

For example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_task",
    "arguments": {
      "workspace_id": 12,
      "operation_id": "66761cf6-70e4-4624-8b58-15dbe1241257",
      "project_id": 35,
      "title": "Review deployment",
      "start": "2030-01-10",
      "end": "2030-01-11",
      "assignee_ids": [9]
    }
  }
}
```

Task dates represent `[start, end)`: the example is a one-day task. Status is derived
from dates and the workspace-local current day; it cannot be set. Dates are ISO
`YYYY-MM-DD`; end must be strictly after start. Finish-to-start successors may
start at their predecessor's exclusive end. Cascades only push overlapping
successors forward and synchronize linked milestone dates.

### Revisions and retry protection

- Mutation calls require a client-generated `operation_id` UUID. Reuse it only to
  retry the same normalized arguments after a transport failure. A different
  payload under the same credential policy/tool/workspace/operation ID is a conflict.
- Updates/deletes also require `if_match`, obtained from the object's `revision`.
  Fingerprints include relevant relationships, not just `updated_at`.
- For `reorder_projects`, use the top-level revision from `list_projects`.
- For workload submission/review/snooze, use `get_my_workload.item.revision` (or
  the `state.revision` returned by submission/review), not a report's revision.
- GitLab binding edits use `get_project_gitlab_binding.item.revision`; sync and
  workflow edits use the connection revision. Settings edits use the corresponding
  settings tool's item revision.
- `move_tasks` accepts `targets: [{id, if_match}, ...]` and `delta_days`, maximum
  100 targets. All targets are validated before any write.
- `add_dependency` requires both `predecessor_revision` and `successor_revision`;
  deletion uses an edge revision from `list_dependencies` plus endpoint IDs.

Receipts, business writes, activity and queued notification effects commit in the
same transaction. A matching retry replays the original result, not another
creation/conversion. Authorization is checked again, including current task/project
management where relevant. Receipt replay is guaranteed only inside the seven-day
retention window (including across OAuth refreshes); after cleanup, inspect current state before resubmitting an old
operation. There is no claim of exactly-once execution forever or across external
notification delivery.

Conflict means reread/review state and issue a **new** operation ID with the current
revision. It does not mean automatically overwrite another user's change.

### Patches, side effects and errors

Omit unchanged fields. Empty arrays clear assignments/teams/responsibilities.
Use `milestone_id: null` to unlink a task milestone and `task_id: null` to unlink
from a milestone; null is rejected for non-nullable fields. Empty descriptions
clear text. The API does not expose the internal action-layer sentinel ID `0`.
Invalid/foreign related IDs fail the entire operation, rather than being ignored.

Date changes can cascade within the workspace. Mutation `effects` contain bounded
changed/deleted task/milestone IDs and counts; use `list_tasks`/`list_milestones`
for further reads when truncated. A task deletion also deletes its linked
milestone and dependency edges. Milestone deletion does not delete its task.
A direct linked-milestone date change resizes the task. Where required, provide
`move_reason` with at least three trimmed characters.

Project transfer requires PM and token access in both workspaces. It moves child
tasks/milestones, preserves internal dependencies, removes cross-project edges and
subscriptions, remaps people by linked user, retires GitLab ownership and detaches
workload project references. Person deletion removes planning assignments, **not**
the login account or workspace membership. Role updates cannot demote the last PM.

Tools return structured results through MCP `structuredContent`. Expected domain
failures have `isError: true` and JSON text containing a stable `code` and message:
`not_found`, `forbidden`, `validation_error`, `conflict`, `cycle_detected`,
`reason_required`, or `feature_disabled`. Unexpected failures return a generic
`internal_error`. Schema errors and unavailable/undiscoverable tools use django-mcpz's
standard protocol/error responses. Tool discovery is capability-filtered; direct
calls cannot bypass those checks. Foreign/inaccessible objects look missing.

Lists default to 25 items, maximum 100. Cursors are signed, query/credential-policy-bound and
expire after an hour. Do not reuse a cursor with different filters. Schedule
windows are bounded to 366 days. List ordering is deterministic, but lists are not
long-lived snapshots across concurrent writes.

## Privacy and deployment

- Generic readers never return source credentials, webhook URLs, invitation/roadmap
  tokens, private account contact fields, raw delivery payloads or arbitrary audit
  snapshots/metadata. Workload access requires dedicated capabilities.
- Only the explicit invitation/roadmap-link tools reveal capability URLs, with
  `sharing.links` plus PM/admin access. Those responses are non-cacheable. Receipts
  store a reference/version rather than the URL, and cannot replay a rotated link.
- Destructive annotations are client hints, **not user consent**. Configure client
  approval for deletion, transfer, privilege changes and public publication. A model
  supplying `confirm: true` would not establish human approval; no such bypass exists.
- No arbitrary SQL, ORM expressions, code execution or URL-fetch tool exists.
  GitLab tools operate on the local cache or queue normal background work; credential
  setup stays in the browser. Existing network protections are unchanged.
- Require HTTPS in production, explicit `DJANGO_ALLOWED_HOSTS`, and correct trusted
  TLS-proxy configuration. django-mcpz rejects invalid Origin headers. Do not add
  wildcard CORS/hosts or disable normal browser CSRF protections.
- Limits: 128 KiB request body, 1 MiB wire response, maximum 100 bulk targets,
  and 240 authenticated requests/credential policy/minute (shared across OAuth refreshes). Rate state is database-backed across
  Gunicorn workers. Rejections return 429 with Retry-After. Configure matching proxy
  body/rate/time limits; protect unauthenticated traffic at the proxy too.
- Mutation result size/schema checks happen before commit. Oversized operations
  fail atomically; reduce the batch. Keep tools short and never poll GitLab inside
  a request. SQLite's existing immediate transactions serialize checks/writes.
- `interfaces.mcp` logs tool, numeric actor/policy/workspace IDs, outcome and duration,
  not arguments/results or raw exception bodies. Avoid enabling SQL/request-body
  debugging or a custom django-mcpz logging handler that records arguments in production.
- Business activity is written in the same transaction as the action. Existing
  browser pages observe MCP changes on reload/next render; no cross-client push
  broadcast is promised.

## Tests

Behavior and transport tests are in `e2e/tests/nano-pm.spec.js`, with helpers in
`e2e/tests/mcp-helpers.js`. Servers use isolated migrated worker databases without
an MCP opt-in. Tests cover all 76 tool registrations and successful domain flows,
auth/permissions, privacy, initialization, paging, stale/concurrent writes, replay,
atomic rollback, link rotation, operator setup and always-available authenticated endpoints. OAuth tests
cover real browser login and consent, forged workspace/scope selection, CSRF, PKCE,
refresh/narrowing/replay, audience/expiry binding, disconnect and legacy migration.

```sh
cd e2e && npx playwright test --grep 'MCP '
cd e2e && npx playwright test tests/nano-pm.spec.js
uv run ruff check .
```
