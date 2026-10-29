"""Leased polling with network I/O outside transactions and durable ownership."""

from datetime import UTC, timedelta
from uuid import uuid4

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from actions.gitlab_matching import assign_unowned, title_prefix
from actions.gitlab_workflow import reduce_history
from actions.teams_delivery import retry_sqlite_contention
from data.models import GitLabConnection, GitLabIssue, GitLabIssueEvent
from interfaces.gitlab.client import Client, GitLabError, issue_url


def source_date(value):
    if not value:
        return None
    result = parse_datetime(value)
    if result is None or timezone.is_naive(result):
        raise GitLabError("invalid-response")
    return result.astimezone(UTC)


@retry_sqlite_contention
@transaction.atomic
def claim(connection_id, force=False):
    now = timezone.now()
    connection = GitLabConnection.objects.filter(pk=connection_id, enabled=True).filter(
        Q(lease_until=None) | Q(lease_until__lte=now),
    ).first()
    if not connection or (not force and connection.next_run and connection.next_run > now):
        return None
    if connection.last_error in ("authentication-failed", "credential-unavailable", "access-denied"):
        return None
    connection.lease_token = str(uuid4())
    connection.lease_until = now + timedelta(minutes=10)
    connection.save(update_fields=["lease_token", "lease_until"])
    return connection


@retry_sqlite_contention
def heartbeat(snapshot):
    updated = GitLabConnection.objects.filter(
        pk=snapshot.pk, revision=snapshot.revision, lease_token=snapshot.lease_token, enabled=True,
    ).update(lease_until=timezone.now() + timedelta(minutes=10))
    if not updated:
        raise GitLabError("configuration-changed")


@retry_sqlite_contention
def finish(snapshot, error):
    query = GitLabConnection.objects.filter(pk=snapshot.pk, lease_token=snapshot.lease_token)
    if error:
        # A changed configuration has already queued a fresh run.
        query.filter(revision=snapshot.revision).update(
            last_error=error.code, failure_count=F("failure_count") + 1,
            next_run=timezone.now() + timedelta(seconds=max(
                min(3600, 30 * 2 ** min(snapshot.failure_count, 7)), error.retry_after,
            )),
        )
    query.update(lease_token="", lease_until=None)


def collect(snapshot):
    client = Client(snapshot, heartbeat=lambda: heartbeat(snapshot))
    project_ids = set(snapshot.project_ids)
    for group in snapshot.group_ids:
        project_ids.update(int(item["id"]) for item in client.pages(
            f"/groups/{group}/projects", include_subgroups="true", with_shared="false",
        ))
    issues = {}
    unavailable = set()
    checkpoints = dict(snapshot.checkpoints)
    started = timezone.now()
    for project_id in sorted(project_ids):
        query = {"state": "all", "order_by": "updated_at", "sort": "asc"}
        checkpoint = checkpoints.get(str(project_id))
        if checkpoint and not snapshot.needs_backfill:
            query["updated_after"] = (source_date(checkpoint) - timedelta(minutes=5)).isoformat()
        for data in client.pages(f"/projects/{project_id}/issues", **query):
            if int(data["project_id"]) != project_id:
                raise GitLabError("invalid-response")
            issues[(project_id, int(data["iid"]))] = data
        checkpoints[str(project_id)] = started.isoformat()

    # Ownership survives prefix changes, removal from the discovery scope and
    # completion; still refresh those issues directly.
    for issue in snapshot.issues.filter(owner__isnull=False):
        key = (issue.gitlab_project_id, issue.iid)
        if key in issues:
            continue
        try:
            data, _next = client.get(f"/projects/{key[0]}/issues/{key[1]}")
            if not isinstance(data, dict) or (int(data["project_id"]), int(data["iid"])) != key:
                raise GitLabError("invalid-response")
            issues[key] = data
        except GitLabError as error:
            if error.code in ("not-found", "access-denied"):
                unavailable.add(issue.pk)
            else:
                raise
    # Retrieve history only for owned or about-to-be-owned issues. Network work
    # is complete before the persistence transaction; event upserts are retryable.
    active = set(snapshot.bindings.exclude(active_prefix=None).values_list("active_prefix", flat=True))
    owned = set(snapshot.issues.filter(owner__isnull=False).values_list("gitlab_project_id", "iid"))
    histories = {}
    for key, source in issues.items():
        if key not in owned and title_prefix(source["title"]) not in active:
            continue
        history = []
        try:
            for kind, endpoint in (("label", "resource_label_events"), ("state", "resource_state_events")):
                for event in client.pages(f"/projects/{key[0]}/issues/{key[1]}/{endpoint}"):
                    at = source_date(event["created_at"])
                    if at is None or int(event["id"]) <= 0:
                        raise GitLabError("invalid-response")
                    snapshot_time = source_date(source.get("updated_at"))
                    if snapshot_time and at > snapshot_time:
                        # History can advance while metadata is being fetched.
                        # Wait for the matching snapshot before interpreting it.
                        continue
                    if kind == "label":
                        label = event.get("label") or {}
                        if not label or event.get("action") not in ("add", "remove"):
                            continue
                        data = {"action": event["action"], "label": label["name"]}
                    else:
                        if event.get("state") not in ("closed", "reopened", "opened"):
                            continue
                        data = {"state": event["state"]}
                    history.append({"at": at, "kind": kind, "id": int(event["id"]), "data": data})
        except GitLabError as error:
            if error.code not in ("not-found", "access-denied"):
                raise
            # Metadata can still be refreshed; keep cached events when history
            # temporarily becomes inaccessible.
        histories[key] = history
    return issues, unavailable, checkpoints, histories, project_ids


@retry_sqlite_contention
@transaction.atomic
def persist(snapshot, data):
    current = GitLabConnection.objects.get(pk=snapshot.pk)
    if current.lease_token != snapshot.lease_token or current.revision != snapshot.revision or not current.enabled:
        return
    issues, unavailable, checkpoints, histories, project_ids = data
    now = timezone.now()
    retired = set(current.issues.filter(retired=True).values_list("gitlab_project_id", "iid"))
    for (project_id, iid), source in issues.items():
        if (project_id, iid) in retired:
            continue
        if project_id <= 0 or iid <= 0 or not isinstance(source["title"], str) or source["state"] not in ("opened", "closed"):
            raise GitLabError("invalid-response")
        labels = source.get("labels", [])
        if not isinstance(labels, list) or any(not isinstance(label, str) for label in labels):
            raise GitLabError("invalid-response")
        # Never turn arbitrary API content into an external/unsafe link.
        GitLabIssue.objects.update_or_create(
            connection=current, gitlab_project_id=project_id, iid=iid,
            defaults={
                "title": source["title"], "labels": labels,
                "web_url": issue_url(current.instance_url, source),
                "source_state": source["state"], "source_created_at": source_date(source.get("created_at")),
                "source_updated_at": source_date(source.get("updated_at")),
                "source_closed_at": source_date(source.get("closed_at")),
                "last_refresh": now, "unavailable": False,
            },
        )
    current.issues.filter(pk__in=unavailable).update(unavailable=True)
    assign_unowned(current, project_ids)
    for issue in current.issues.filter(owner__isnull=False).select_related("owner__gitlab_binding"):
        if issue.owner.workspace_id != current.workspace_id:
            continue
        key = (issue.gitlab_project_id, issue.iid)
        for event in histories.get(key, []):
            GitLabIssueEvent.objects.update_or_create(
                issue=issue, kind=event["kind"], source_id=event["id"],
                defaults={"timestamp": event["at"], "data": event["data"]},
            )
        binding = getattr(issue.owner, "gitlab_binding", None)
        mapping = binding.workflow if binding and binding.workflow else current.workflow
        # Read after the upserts rather than the prefetch cache.
        events = [{
            "at": event.timestamp.isoformat(), "kind": event.kind,
            "id": event.source_id, "data": event.data,
        } for event in GitLabIssueEvent.objects.filter(issue=issue)
            if not issue.source_updated_at or event.timestamp <= issue.source_updated_at]
        issue.state, issue.intervals = reduce_history(
            issue.labels, issue.source_state, events, mapping,
            issue.source_closed_at.isoformat() if issue.source_closed_at else None,
        )
        issue.mapping_revision = current.revision
        issue.save(update_fields=["state", "intervals", "mapping_revision"])
    current.checkpoints = checkpoints
    current.needs_backfill = False
    current.last_success = now
    current.last_error = ""
    current.failure_count = 0
    current.next_run = now + timedelta(minutes=5)
    current.save(update_fields=["checkpoints", "needs_backfill", "last_success", "last_error", "failure_count", "next_run"])


def sync_connection(connection_id, force=False):
    snapshot = claim(connection_id, force)
    if snapshot is None:
        return False
    error = None
    try:
        data = collect(snapshot)
        persist(snapshot, data)
    except GitLabError as exc:
        error = exc
    except (KeyError, TypeError, ValueError, OverflowError):
        error = GitLabError("invalid-response")
    finally:
        finish(snapshot, error)
    return error is None
