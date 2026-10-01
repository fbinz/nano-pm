# Teams milestone notifications

## Setup

1. Create a Teams **Workflow** that receives a webhook request and posts the
   supplied Adaptive Card to the desired channel. Keep the generated URL secret.
   No custom bot, Graph permissions, or delegated OAuth connection is needed.
2. In nano-pm, open **Teams notifications** in the sidebar. A workspace PM uses
   **Set up new webhook** (**Neuen Webhook einrichten**) to enter the URL in a
   dialog. Saving replaces any existing connection; a non-empty, valid URL is
   required. **Disconnect webhook** (**Webhook trennen**) disables delivery.
   Saved URLs are never displayed. Configure milestone events separately with
   **Save workspace notifications**; changing the connection preserves these
   preferences, and saving preferences does not change the connection.
3. Each interested workspace member opens **My Profile** in the sidebar,
   then enters their **Teams email address** (the Microsoft sign-in
   UPN). In German this is **Teams-E-Mail-Adresse**. This setting is specific to
   the active workspace and independent of their contact email or Person record.
   Clearing it disables mentions, not subscriptions. Existing addresses are
   preserved; no data migration is needed for the profile move.
4. Enable the public roadmap from the workspace menu. Each project card has a
   **Follow** button. Once subscribed it shows **Subscribed** (**Abonniert**);
   click it to open **Unfollow**. Following and project filtering are separate
   controls, and the current tab's project filters survive subscription changes.
5. Public visitors can follow without an account by default. To restrict their
   email domains, enter **Allowed domains for public followers** in the Teams
   settings (e.g. `mycompany.com`, or a comma-separated list). Blank allows any
   email domain. Matching is case-insensitive and exact: `sub.mycompany.com` must be
   listed separately. URLs, wildcards and `@` prefixes are not accepted.
   Visitors click **Follow**, enter their own **Teams email address**, and are
   subscribed immediately. No confirmation email or nano-pm account is required.
   After a successful follow, the validated address is remembered in
   `localStorage`, separately for each roadmap. Subsequent **Follow** clicks
   reuse it without reopening the dialog. The server still checks current domain
   restrictions; rejected addresses reopen the dialog for correction. **Use
   another email address** clears the saved address so the next follow asks
   again; existing subscriptions are unchanged. When browser storage is
   unavailable, the dialog remains available.

The **Teams notifications** page and sidebar link are PM-only. Regular members
manage their own Teams address through **My profile**. On that page all users
can also edit their first name, last name, and contact email (account-wide).
Usernames remain read-only; roles, permissions, and other users' accounts cannot
be edited. Profile names do not automatically rename workspace Person records.
The separate **Change password** form verifies the current password, applies
Django's password validators, and preserves the current login session.

UPNs are self-declared, not verified against Microsoft. nano-pm does not discover
channel membership: followers must have access to the channel, and the UPN must
resolve there. Test guest/shared/private-channel scenarios in your tenant.
Recipients and their subscriptions are never listed on the public roadmap.

### Public follower ownership and limitations

Anonymous subscription ownership uses a random, signed, HttpOnly, SameSite=Lax
browser cookie (one-year lifetime; Secure over HTTPS). Only its hash is stored
with a subscription. The roadmap shows only that browser's follow state and
remembered email, never other visitors' addresses or capability tokens. Knowing another person's address is
not sufficient to unsubscribe their browser's subscription. Keep the same
browser and its cookies to unfollow; clearing or losing them loses management
access. Subscriptions remain stored until explicitly removed or their project
is deleted. Different browsers may subscribe the same address; mentions are
deduplicated, including against authenticated members' addresses.

These addresses are **self-declared and not verified**. A domain allowlist is
not proof of address ownership or Teams channel access; someone can enter
another person's allowed-domain address. Configure allowed domains for the
intended public audience, and use proxy-level rate limiting if exposing it broadly.
There is no email confirmation, account recovery or cross-browser subscription
management yet.

Domain restrictions apply to public followers, not authenticated workspace
members' profile addresses. A non-empty allowlist excludes public followers
outside those domains from **newly queued** messages; clearing the list removes
the restriction. Disabling the public roadmap excludes all public followers
from newly queued messages. Existing outbox messages retain their recipient snapshot.
Owners can still unfollow after domain restrictions change. Moving a project to
another workspace clears both member and public subscriptions; public tokens
and project IDs cannot be mixed across workspaces.

## Behaviour

- One channel message per selected milestone event, mentioning the project's
  subscribed, active users with non-empty UPNs. Duplicate UPNs are mentioned once.
- Date/detail changes are enabled by default. Creation, deletion, and project
  transfers can also be enabled. No subscribers still means a channel post,
  just without mentions.
- Direct milestone edits, linked-task moves/resizes, dependency cascades, and
  task/project deletions all go through the notification path.
- Placeholder creation is silent. Its first meaningful title/description edit
  emits a creation event. Discarding an unchanged placeholder is silent.
- A milestone transfer within a workspace sends one message mentioning the
  union of both projects' followers. Moving a whole project to another workspace
  clears its subscriptions rather than carrying identities across workspaces.
- Cards retain the existing German wording. Long text is truncated; unusually
  large follower lists are split into multiple cards below Teams' size limit.
- The message and recipient list are snapshots taken when the event occurs.
  Unfollowing/changing your UPN affects future events, not already queued cards.

## Running delivery

Run migrations before starting the application. For local development use two
terminals:

```sh
just migrate
just run
# In the second terminal:
just teams-worker
```

The Docker image starts both Gunicorn and the worker via `src/run_services.py`.
If either exits unexpectedly, the supervisor terminates the other and exits so
that the container platform's restart policy can recover the services. They
must share the same persistent SQLite volume. Outside Docker, supervise this
command separately with the same DB/environment as the web process:

```sh
uv run python src/manage.py deliver_teams_notifications
# Or, for a scheduled job / deterministic test:
uv run python src/manage.py deliver_teams_notifications --once
```

Events are written to a durable DB outbox in the mutation transaction. Workers
claim jobs with a lease and do network I/O **outside** DB transactions. Network
errors, HTTP 408/429 and 5xx responses retry with backoff (up to five attempts;
numeric Retry-After is respected for 429). Other HTTP errors stop retrying.
Abandoned jobs become available again after five minutes. Records expire after
30 days; successful/cancelled payloads are cleared immediately.

SQLite `BUSY` / `LOCKED` errors (including extended error codes) retry the individual
database operation after its transaction has rolled back. After SQLite's own
five-second busy timeout, the worker backs off from 250 ms to a maximum of five
seconds between retries, continuing until the lock clears. This applies to
cleanup, claiming, reading the destination, and saving delivery results. Lock
retries do not consume HTTP delivery attempts. In particular, a lock while saving
an accepted delivery retries **only the database update**, not the webhook POST.
Lease-conditional updates prevent overwriting another worker's newer claim.
Other database errors remain fatal rather than being silently retried.

Delivery is **at least once**, not exactly once: a connection loss after Teams
accepts a request, or a worker crash before recording success, can produce a
repeat message. Webhooks do not provide an idempotency guarantee. PMs can inspect
recent delivery status on the settings page. `Sent` means HTTP acceptance, not
confirmation that a Workflow posted to Teams; check the Workflow run history
when accepted requests do not produce cards.

Changing/disabling the destination prevents pending jobs from being sent to a
different channel. Already in-flight requests may still complete. URLs must use
HTTPS on the supported Microsoft webhook hosts (Power Platform, Logic Apps,
Office webhooks); redirects are not followed. HTTP loopback receivers are only
allowed with the explicitly test-only `DJANGO_ENABLE_TEST_RESET` setting.

## Existing installations

Legacy project webhook URLs and event preferences are not migrated or imported.
A PM configures the workspace webhook explicitly on the Teams settings page.
Already-configured workspace settings are left unchanged. Old project fields
remain as unused historical data and are not exposed in project editors.
Migration names are preserved for databases that have already applied them.

Existing activity entries are scrubbed of webhook URL values. New activity
entries record only that the secret changed. Webhook URLs, card payloads, and raw
HTTP response/error bodies are not logged by the delivery worker. The database
still contains webhook credentials and queued card content: protect the DB and
backups, and avoid production SQL debug logging.

## Verification

Playwright uses local HTTP receivers; it never posts to a real Teams channel.

```sh
cd e2e && npx playwright test tests/nano-pm.spec.js --grep 'Teams'
```

The new flows cover workspace settings, authenticated/scoped subscriptions,
UPN mentions, direct and task-driven changes, creation/deletion, project transfer
recipient unions, duplicate/missing UPNs, event filtering, redaction, disconnect,
HTTP 429 retry, and real cross-process SQLite locks both before delivery and while
recording HTTP acceptance (without resending). Pure payload-size, destination
validation, and lock-retry classification checks run via:

```sh
DJANGO_DEBUG=true uv run python src/manage.py test data.tests
```
