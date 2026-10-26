"""Microsoft Teams milestone notifications."""

import json
from datetime import date
from types import SimpleNamespace
from html import escape

from django.db import transaction
from django.utils import timezone

from actions.activity import change_set, created_changes, deleted_changes
from actions.notifications import record_change
from actions.teams_delivery import destination_hash, retry_sqlite_contention
from actions.public_subscriptions import public_email_allowed
from data.models import (
    Membership, Milestone, NotificationBatch, Project, PublicProjectSubscription, TeamsDelivery,
)
from data.models.project import TEAMS_NOTIFY_EVENT_KEYS

MILESTONE_CREATED = "milestone.created"
MILESTONE_MOVED = "milestone.moved"
MILESTONE_UPDATED = "milestone.updated"
MILESTONE_PROJECT_CHANGED = "milestone.project_changed"
MILESTONE_DELETED = "milestone.deleted"

GERMAN_MONTHS = [
    "Jan.", "Feb.", "März", "Apr.", "Mai", "Juni",
    "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez.",
]


def normalize_notify_events(events: object) -> list[str]:
    """Return only supported Teams notification event keys, preserving order."""
    if not isinstance(events, (list, tuple, set)):
        return []
    valid = []
    for event in events:
        if event in TEAMS_NOTIFY_EVENT_KEYS and event not in valid:
            valid.append(event)
    return valid


def event_slug(event: str) -> str:
    return event.replace(".", "-").replace("_", "-")


def _actor_label(actor) -> str:
    if actor is None or not getattr(actor, "is_authenticated", False):
        return ""
    return actor.get_full_name().strip() or actor.get_username()


def _parse_date(value: object) -> date | None:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def _format_german_date(value: object) -> str | None:
    parsed = _parse_date(value)
    if parsed is None:
        return None
    return f"{parsed.day}. {GERMAN_MONTHS[parsed.month - 1]} {parsed.year}"


def _format_value(value: object) -> str:
    if isinstance(value, date):
        return _format_german_date(value) or value.isoformat()
    if value is None or value == "":
        return "—"
    text = str(value)
    return text if len(text) <= 250 else text[:249] + "…"


def _format_field_value(field: str, value: object) -> str:
    if field == "date":
        return _format_german_date(value) or _format_value(value)
    return _format_value(value)


def _event_label(event_names: set[str]) -> str:
    if MILESTONE_CREATED in event_names:
        return "Meilenstein erstellt"
    if MILESTONE_DELETED in event_names:
        return "Meilenstein gelöscht"
    if MILESTONE_MOVED in event_names:
        return "Termin verschoben"
    if MILESTONE_PROJECT_CHANGED in event_names:
        return "Projekt geändert"
    return "Meilenstein aktualisiert"


def _field_label(field: str) -> str:
    labels = {
        "date": "Datum",
        "description": "Beschreibung",
        "project": "Projekt",
        "task": "Aufgabe",
        "title": "Titel",
    }
    return labels.get(field, field.replace("_", " ").title())


def _format_date_delta(before: object, after: object) -> str | None:
    before_date = _parse_date(before)
    after_date = _parse_date(after)
    if before_date is None or after_date is None:
        return None
    delta_days = (after_date - before_date).days
    if delta_days == 0:
        return None
    abs_days = abs(delta_days)
    if abs_days % 7 == 0:
        weeks = abs_days // 7
        amount = "1 Woche" if weeks == 1 else f"{weeks} Wochen"
    else:
        amount = "1 Tag" if abs_days == 1 else f"{abs_days} Tage"
    direction = "später" if delta_days > 0 else "früher"
    return f"{amount} {direction}"


def _detail_for_change(
    field: str,
    delta: object,
    *,
    milestone_description: str = "",
) -> str | None:
    if not isinstance(delta, dict) or field == "require_move_reason":
        return None
    before = _format_field_value(field, delta.get("from"))
    after = _format_field_value(field, delta.get("to"))
    if field == "date" and "from" in delta and "to" in delta:
        shift = _format_date_delta(delta.get("from"), delta.get("to"))
        return f"Jetzt **{after}**" + (f" — {shift}" if shift else "")
    if field == "title" and "from" in delta and "to" in delta:
        # The new title is already the milestone heading.
        return f"Bisheriger Titel: {before}"
    if field == "description" and delta.get("changed"):
        description = milestone_description.strip()
        return f"Beschreibung geändert:\n\n{description}" if description else "Beschreibung entfernt"
    label = _field_label(field)
    if "from" in delta and "to" in delta:
        return f"{label}: {before} → {after}"
    if "to" in delta:
        return f"{label}: {after}"
    if "deleted" in delta:
        return f"{label}: {_format_field_value(field, delta['deleted'])}"
    return None


def _message_text(
    *,
    event_names: set[str],
    changes: dict | None = None,
    milestone_description: str = "",
) -> str:
    changes = changes or {}
    if {MILESTONE_CREATED, MILESTONE_DELETED} & event_names:
        # The event label and heading already describe creation/deletion.
        delta = changes.get("date", {})
        if isinstance(delta, dict):
            value = delta.get("to", delta.get("deleted"))
            if value:
                return f"Termin: **{_format_field_value('date', value)}**"
        return ""

    details = []
    # Keep the date prominent even when a long description changes with it.
    for field in sorted(changes, key=lambda field: field != "date"):
        detail = _detail_for_change(
            field, changes[field], milestone_description=milestone_description,
        )
        if detail is not None:
            details.append(detail)
    return "\n\n".join(details)


def _teams_payload(
    *,
    project: Project,
    milestone_title: str,
    event_names: set[str],
    changes: dict | None = None,
    actor=None,
    milestone_description: str = "",
    move_reason: str = "",
    actor_label: str | None = None,
) -> dict:
    """Build an Adaptive Card payload for a Teams incoming webhook."""
    event_label = _event_label(event_names)
    title = f"{project.name[:200]} · {event_label} · {milestone_title[:200]}"
    body = _message_text(
        event_names=event_names,
        changes=changes,
        milestone_description=milestone_description,
    )
    card_body = [
        {
            "type": "TextBlock",
            "text": project.name[:200],
            "weight": "Bolder",
            "size": "Medium",
            "wrap": True,
        },
        {
            "type": "TextBlock",
            "text": event_label,
            "size": "Small",
            "isSubtle": True,
            "spacing": "None",
            "wrap": True,
        },
        {
            "type": "TextBlock",
            "text": milestone_title[:200],
            "weight": "Bolder",
            "spacing": "Medium",
            "wrap": True,
        },
    ]
    if body:
        card_body.append({
            "type": "TextBlock",
            "text": body if len(body) <= 2000 else body[:1999] + "…",
            "spacing": "Small",
            "wrap": True,
        })
    if MILESTONE_MOVED in event_names and move_reason.strip():
        card_body.append({
            "type": "TextBlock",
            "text": f"**Grund:** {move_reason.strip()[:500]}",
            "spacing": "Medium",
            "wrap": True,
        })
    actor_label = _actor_label(actor) if actor_label is None else actor_label
    if actor_label:
        card_body.append({
            "type": "TextBlock",
            "id": "notification-footer",
            "text": actor_label,
            "size": "Small",
            "isSubtle": True,
            "spacing": "Medium",
            "wrap": True,
        })
    return {
        "type": "message",
        "summary": title,
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "contentUrl": None,
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": card_body,
                },
            }
        ],
    }


def _subscribers(project: Project, related_project_ids: tuple[int, ...]) -> list[str]:
    upns = Membership.objects.filter(
        workspace_id=project.workspace_id,
        user__is_active=True,
        subscriptions__project_id__in={project.id, *related_project_ids},
        subscriptions__project__workspace_id=project.workspace_id,
    ).exclude(teams_upn="").values_list("teams_upn", flat=True)
    recipients = {upn.lower() for upn in upns}
    workspace = project.workspace
    if workspace.public_roadmap_enabled:
        public_addresses = PublicProjectSubscription.objects.filter(
            project_id__in={project.id, *related_project_ids}, project__workspace_id=workspace.id,
        ).values_list("teams_email", flat=True)
        recipients.update(
            address.lower() for address in public_addresses
            if public_email_allowed(address, workspace.teams_public_subscriber_domains)
        )
    return sorted(recipients)


def _with_mentions(payload: dict, upns: list[str]):
    """Split large recipient lists to stay below Teams' 28 KB card limit."""
    # Clone before attaching mentions; no mutable payload is shared by jobs.
    card_payload = json.loads(json.dumps(payload))
    card = card_payload["attachments"][0]["content"]
    entities = []
    if not upns:
        yield card_payload
        return
    if card["body"][-1].get("id") == "notification-footer":
        text = card["body"][-1]
    else:
        text = {
            "type": "TextBlock", "id": "notification-footer", "text": "",
            "size": "Small", "isSubtle": True, "spacing": "Medium", "wrap": True,
        }
        card["body"].append(text)
    prefix = f"{text['text']} · " if text["text"] else ""
    text["text"] = prefix.rstrip()
    card["msteams"] = {"entities": entities}
    for upn in upns:
        mention = f"<at>{escape(upn)}</at>"
        entity = {"type": "mention", "text": mention, "mentioned": {"id": upn, "name": upn}}
        entities.append(entity)
        previous = text["text"]
        text["text"] = f"{previous} {mention}".strip()
        if len(json.dumps(card_payload, ensure_ascii=False).encode()) > 27000 and len(entities) > 1:
            entities.pop()
            text["text"] = previous
            yield json.loads(json.dumps(card_payload))
            entities[:] = [entity]
            text["text"] = prefix + mention
    yield card_payload


def milestone_snapshot(milestone: Milestone) -> dict:
    """Full notification snapshot; unlike the audit log, retain text for diffing."""
    return {
        "title": milestone.title, "description": milestone.description,
        "date": milestone.date.isoformat(), "project": milestone.project.name,
        "project_key": milestone.project_id,
        "task": milestone.task.title if milestone.task_id else "",
    }


def queue_project_notification(
    *, project: Project, milestone_id: int, event_names: set[str],
    before: dict | None, after: dict | None, actor=None, move_reason: str = "",
    related_project_ids: tuple[int, ...] = (),
) -> None:
    """Merge into the editable summary in the mutation's transaction."""
    if not project.workspace.teams_webhook_url:
        return
    enabled = set(normalize_notify_events(project.workspace.teams_notify_events))
    record_change(
        project=project, milestone_id=milestone_id, before=before, after=after,
        events=set(normalize_notify_events(event_names)) & enabled,
        actor_label=_actor_label(actor), reason=move_reason,
        recipients=_subscribers(project, related_project_ids),
        destination_hash=destination_hash(project.workspace.teams_webhook_url),
    )


def milestone_event_names_from_changes(changes: dict) -> set[str]:
    event_names: set[str] = set()
    if "project" in changes:
        event_names.add(MILESTONE_PROJECT_CHANGED)
    if "date" in changes:
        event_names.add(MILESTONE_MOVED)
    if {"title", "description"} & set(changes):
        event_names.add(MILESTONE_UPDATED)
    return event_names


def queue_milestone_notification(
    *,
    project: Project,
    milestone: Milestone,
    event_names: set[str],
    actor=None,
    move_reason: str = "",
    related_project_ids: tuple[int, ...] = (),
    before: dict | None = None,
) -> None:
    queue_project_notification(
        project=project, milestone_id=milestone.id,
        event_names=event_names, before=before, after=milestone_snapshot(milestone),
        actor=actor, move_reason=move_reason, related_project_ids=related_project_ids,
    )


def _net_change(change):
    before, after = change.before, change.after
    if before is None and after is None:
        return None
    if before is None:
        events, changes = {MILESTONE_CREATED}, created_changes(after)
    elif after is None:
        events, changes = {MILESTONE_DELETED}, deleted_changes(before)
    else:
        changes = change_set(before, after)
        changes.pop("project_key", None)
        if before["project_key"] != after["project_key"]:
            changes["project"] = {"from": before["project"], "to": after["project"]}
        events = milestone_event_names_from_changes(changes)
    changes.pop("project_key", None)
    if not events.intersection(change.events):
        return None
    return events, changes


def _summary_payloads(batch):
    """Group milestones, splitting content before adding size-bounded mentions."""
    entries = []
    for change in batch.changes.all():
        net = _net_change(change)
        if net is not None:
            events, changes = net
            values = change.after or change.before
            payload = _teams_payload(
                project=SimpleNamespace(name=batch.project_name),
                milestone_title=values["title"], milestone_description=values["description"],
                event_names=events, changes=changes, move_reason=change.latest_move_reason,
                actor_label=" · ".join(change.contributors)[:500],
            )
            entries.append((payload, change))
    if len(entries) == 1:
        payload, change = entries[0]
        yield from _with_mentions(payload, change.recipients)
        return

    payload = None
    recipients = set()
    contributors = set()

    def finish():
        card = payload["attachments"][0]["content"]
        if contributors:
            card["body"].append({
                "type": "TextBlock", "id": "notification-footer",
                "text": " · ".join(sorted(contributors))[:500], "size": "Small",
                "isSubtle": True, "spacing": "Medium", "wrap": True,
            })
        return _with_mentions(payload, sorted(recipients))

    for entry, change in entries:
        body = entry["attachments"][0]["content"]["body"]
        if body[-1].get("id") == "notification-footer":
            body.pop()
        # Reserve room for the footer and mentions under Teams' 28 KB limit.
        if payload is not None and len(json.dumps(payload, ensure_ascii=False).encode()) + len(json.dumps(body, ensure_ascii=False).encode()) > 20000:
            yield from finish()
            payload, recipients, contributors = None, set(), set()
        if payload is None:
            payload = entry
            payload["summary"] = f"{batch.project_name[:200]} · Meilensteine aktualisiert"
        else:
            payload["attachments"][0]["content"]["body"].extend(body[1:])
        recipients.update(change.recipients)
        contributors.update(change.contributors)
    if payload is not None:
        yield from finish()


@retry_sqlite_contention
@transaction.atomic
def materialize_next() -> bool:
    """Freeze one due summary and its HTTP outbox entries atomically.

    SQLite's configured BEGIN IMMEDIATE serializes this with mutation writes;
    row locks provide the same boundary on databases supporting them.
    """
    now = timezone.now()
    batch = NotificationBatch.objects.select_for_update().select_related("workspace").filter(
        status=NotificationBatch.Status.OPEN, send_after__lte=now,
    ).order_by("send_after", "id").first()
    if batch is None:
        return False
    valid_destination = (
        batch.workspace.teams_webhook_url
        and destination_hash(batch.workspace.teams_webhook_url) == batch.destination_hash
    )
    count = 0
    if valid_destination:
        for payload in _summary_payloads(batch):
            TeamsDelivery.objects.create(
                batch=batch, workspace=batch.workspace, destination_hash=batch.destination_hash, payload=payload,
            )
            count += 1
    elif batch.changes.exists():
        # Retain the existing delivery-status visibility for invalid destinations.
        TeamsDelivery.objects.create(
            batch=batch, workspace=batch.workspace, destination_hash=batch.destination_hash,
            payload={}, status=TeamsDelivery.Status.CANCELLED,
        )
    batch.status = NotificationBatch.Status.MATERIALIZED if count else NotificationBatch.Status.CANCELLED
    batch.materialized_at = now
    batch.save(update_fields=["status", "materialized_at"])
    # The frozen payload is now authoritative; do not retain extra descriptions
    # or recipient snapshots after the handoff.
    batch.changes.all().delete()
    return True
