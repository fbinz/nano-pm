# GitLab integration

## Setup

1. Apply migrations and configure a dedicated encryption key in **both** the web
   and GitLab worker environments. Generate a key once, then keep it stable:

   ```sh
   uv run python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
   # Store the generated value in DJANGO_GITLAB_ENCRYPTION_KEY through your secret manager.
   just migrate
   ```

   Do not commit the key or store it beside database backups. There is no production
   fallback to Django's secret key. The guarded e2e settings use a throwaway key only.

2. A workspace PM opens **Workspace settings** using the cog beside the workspace
   name, then finds the **GitLab integration** section. Enter the GitLab
   HTTPS origin (for example `https://gitlab.example.com`), a token with the
   `read_api` scope and sufficient source access, and comma-separated numeric GitLab
   project and/or group IDs. Group searches include subgroups and exclude projects
   shared from outside the group. There is one connection per workspace.
3. Select only sources whose cached metadata may be visible to **all workspace
   members**. nano-pm does not impersonate individual GitLab users or reproduce
   issue-specific GitLab permissions. Titles, labels, states, and transition history
   are cached; descriptions and comments are not imported. Nothing is published on
   public roadmaps.
4. Open a nano-pm project's details → **GitLab project settings**. Enter its title
   prefix and enable **Collect matching GitLab issues**. For example, prefix
   `Portal` matches `Portal: Add login`, ignoring case and surrounding spaces.
   It does not match `Portal Admin: Add login`, titles without a colon, or a prefix
   occurring later in the title. No labels or GitLab writes are needed.
5. Configure the workspace workflow, optionally overriding it in individual project
   settings. Enter one exact GitLab label per line. Defaults are
   `In Development` → in progress and `Next Deployment` → done.
6. Run the GitLab worker. **Sync GitLab now** queues work; it does not make the web
   process fetch from GitLab. Refresh the settings/project page after synchronization.
   Expand **GitLab execution** under a project's task rows to see cached intervals.

## Ownership and prefix reuse

The prefix discovers an issue; the stored owner determines its subsequent project.

- Only one active collecting project can claim a normalized prefix in the shared
  discovery scope. Conflicts are rejected, including when reopening a completed
  project. Disable collection or change the conflicting prefix before reopening.
- Completing a project releases its prefix claim without removing its issues.
  Their source states continue refreshing.
- A new active project can reuse the prefix. It receives **all matching unassigned
  issues**, including issues with old creation dates. No dated handover is needed.
- Renaming issues, changing a prefix, closing/reopening an issue, and repeated syncs
  never automatically transfer ownership. Changed-prefix issues carry a badge.
- Use **Move issue** for an explicit transfer within the workspace. The user must
  be authorized to manage both projects; that choice survives later syncs.
- Removing a source stops discovery/collection from that source. Existing owned
  issues are retained and refreshed directly while the credential still permits it.
- Deleting a project or moving it to another workspace retires its associations.
  Only minimal issue-identity tombstones remain in the source workspace, preventing
  a new project from silently reclaiming the deleted project's issues. Cached titles
  and history for those associations are cleared. A workspace move removes the
  binding and never carries credentials/private source data into the destination.

An old project's newly created issue with a reused prefix is indistinguishable from
new-project work: it goes to the current collector. Use an explicit move for exceptions,
or different prefixes for projects collecting concurrently.

## Workflow and timing

Precedence is **closed → done label → in-progress label → not-started label →
configured fallback**. Multiple labels can map to a state. The initial fallback is
unclassified. Mapping changes replay cached history; saving settings never becomes
a fake work-start/finish event.

Label history and close/reopen events establish execution intervals, including
multiple work cycles. Closing an issue already marked done does not move its
recorded finish. Reopening while a done label is still present leaves it done under
the same precedence rule. Events newer than the fetched issue snapshot wait for a
subsequent sync.

Creation time and general `updated_at` are **not** work-start dates. Missing history
remains unknown. For display, starts snap to the beginning of their local day and
finishes to the end of their local day. Same-day work occupies one full day; a lone
known boundary also occupies that day without filling in the unknown timestamp.
Ongoing work extends through the end of today. Undated issues remain in the issue
list. The chart clips execution to the existing planning range rather than
stretching it for historical issues. Expansion survives page refreshes and Datastar
patches.

Execution is read-only: it never changes task dates, date-derived task status,
milestones, dependencies, or nano-pm project completion. Issue counts measure issues,
not effort. The resource and kanban views are unchanged.

## Running synchronization

For development, run alongside `just run`:

```sh
just gitlab-worker
# One deterministic pass, also suitable for cron:
uv run python src/manage.py sync_gitlab --once
```

Docker starts Gunicorn, Teams delivery, and GitLab polling through
`src/run_services.py` after migrations. Outside Docker, supervise the command
separately with the same database and environment as the web process. Do not start
it in Gunicorn hooks, migrations, or ordinary e2e server startup.

Normal polling runs approximately every five minutes. Initial/configuration-triggered
backfills include open and closed issues and paginate fully. Incremental polling uses
overlapping update checkpoints. A durable, renewable ten-minute lease prevents
duplicate polling; a hard-killed worker's lease eventually expires. Network I/O is
outside SQLite write transactions; result-write lock retries reuse fetched data.

Transient failures back off from 30 seconds to one hour, honoring longer numeric
`Retry-After` values (up to one day). Authentication/credential/access failures pause
automatic polling until settings are repaired or an explicit sync is requested.
`--once` ignores the normal schedule but not an active lease or authentication pause.

The UI shows queued/running/success/error status and last success; data is marked
potentially stale after 15 minutes without success or on failure. Permission loss,
missing sources, or outages do not unassign issues or mark them done. A directly
unavailable issue keeps its last known state and receives an availability badge.

## Credentials, self-hosting, and recovery

- API calls use HTTPS, bounded timeouts/responses, no proxy environment, and no
  redirect following. Saved credentials are encrypted with Fernet; tokens and raw
  API/error bodies are never rendered or logged by the worker.
- DNS results are checked and the connection is pinned to the validated address.
  Private/reserved addresses are denied unless the deployment explicitly lists
  the lowercase hostname in `DJANGO_GITLAB_PRIVATE_HOSTS` (comma-separated). This is a
  trusted deployment setting, not a workspace-editable SSRF exception. Loopback
  HTTP is only allowed with the existing explicit test-reset opt-in.
- API-provided issue links are accepted only on the configured origin; otherwise
  a numeric-project GitLab link is used.
- Saving a blank token preserves the credential; entering a token rotates it.
  Disconnect clears the stored credential and stops polling, preserving ownership.
  Reconnecting the same instance retains identity and mappings.
- Changing to another GitLab instance requires a new workspace; disconnecting is
  intentionally not an identity reset.
- If changing/loss of the encryption key makes credentials unavailable, configure
  the same new key for web/worker and re-enter each workspace's token. Do not reset
  ownership to fix an authentication problem.
- Protect the database and backups: encryption protects the token, not cached
  private issue metadata. Avoid production SQL debug logging.

Diagnostic error codes include `authentication-failed`, `credential-unavailable`,
`access-denied`, `address-not-allowed`, `not-found`, `rate-limited`,
`connection-failed`, `invalid-response`, and `request-failed`. Fix source access,
network/deployment configuration, or credentials as appropriate, then request a sync.

## Verification

Playwright uses isolated worker databases and ephemeral local fake GitLab APIs;
it never contacts a real GitLab instance.

```sh
cd e2e && npx playwright test tests/nano-pm.spec.js --grep GitLab
cd e2e && npx playwright test tests/nano-pm.spec.js
uv run ruff check .
```

Coverage includes credential protection, paginated imports, source scopes, immutable
ownership/prefix reuse, workflow overrides/history, missing dates, source failures,
backoff/redirect safety, leases, in-flight settings changes, real SQLite contention,
deletion/workspace isolation, and read-only overlay geometry through chart patches.
