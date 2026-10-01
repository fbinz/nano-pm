"""Microsoft Teams milestone notifications."""

import json
from datetime import date
from html import escape

from actions.teams_delivery import destination_hash
from actions.public_subscriptions import public_email_allowed
from data.models import Membership, Milestone, Project, PublicProjectSubscription, TeamsDelivery
from data.models.project import TEAMS_NOTIFY_EVENT_KEYS

MILESTONE_CREATED = "milestone.created"
MILESTONE_MOVED = "milestone.moved"
MILESTONE_UPDATED = "milestone.updated"
MILESTONE_PROJECT_CHANGED = "milestone.project_changed"
MILESTONE_DELETED = "milestone.deleted"

GERMAN_MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
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


def project_wants_event(project: Project, event_names: set[str]) -> bool:
    if not project.workspace.teams_webhook_url:
        return False
    enabled = set(normalize_notify_events(project.workspace.teams_notify_events))
    return bool(enabled & event_names)


def _actor_label(actor) -> str:
    if actor is None or not getattr(actor, "is_authenticated", False):
        return ""
    return actor.get_username()


def _parse_date(value: object) -> date | None:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def _format_german_date(value: object, *, with_article: bool = False) -> str | None:
    parsed = _parse_date(value)
    if parsed is None:
        return None
    prefix = "den " if with_article else ""
    return f"{prefix}{parsed.day}. {GERMAN_MONTHS[parsed.month - 1]} {parsed.year}"


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


def _card_title(milestone_title: str, event_names: set[str]) -> str:
    if MILESTONE_CREATED in event_names:
        action = "erstellt"
    elif MILESTONE_DELETED in event_names:
        action = "gelöscht"
    elif MILESTONE_PROJECT_CHANGED in event_names or MILESTONE_MOVED in event_names:
        action = "verschoben"
    else:
        action = "aktualisiert"
    return f"Meilenstein {milestone_title[:200]} {action}"


def _actor_subject(actor) -> str:
    label = _actor_label(actor)
    return label or "Jemand"


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
        amount = "eine Woche" if weeks == 1 else f"{weeks} Wochen"
    else:
        amount = "einen Tag" if abs_days == 1 else f"{abs_days} Tage"
    direction = "nach hinten" if delta_days > 0 else "nach vorne"
    target = _format_german_date(after_date, with_article=True)
    return f"um {amount} {direction} auf {target}"


def _sentence_for_change(
    field: str,
    delta: object,
    actor_label: str,
    *,
    milestone_description: str = "",
) -> str | None:
    if not isinstance(delta, dict):
        return None
    before = _format_field_value(field, delta.get("from"))
    after = _format_field_value(field, delta.get("to"))
    if field == "date" and "from" in delta and "to" in delta:
        shift = _format_date_delta(delta.get("from"), delta.get("to"))
        if shift is not None:
            return f"{actor_label} hat das Datum {shift} verschoben."
        return f"{actor_label} hat das Datum von {before} nach {after} verschoben."
    if field == "project" and "from" in delta and "to" in delta:
        return f"{actor_label} hat den Meilenstein von {before} nach {after} verschoben."
    if field == "title" and "from" in delta and "to" in delta:
        return f"{actor_label} hat den Titel von „{before}“ in „{after}“ geändert."
    if field == "description" and delta.get("changed"):
        description = milestone_description.strip()
        if description:
            return f"{actor_label} hat die Beschreibung geändert:\n\n{description}"
        return f"{actor_label} hat die Beschreibung geändert."
    if "from" in delta and "to" in delta:
        return f"{actor_label} hat {field.replace('_', ' ')} von {before} in {after} geändert."
    if "to" in delta:
        value = _format_field_value(field, delta.get("to"))
        return f"{actor_label} hat {field.replace('_', ' ')} auf {value} gesetzt."
    if "deleted" in delta:
        return f"{actor_label} hat {field.replace('_', ' ')} gelöscht."
    return None


def _message_text(
    *,
    event_names: set[str],
    changes: dict | None = None,
    actor=None,
    milestone_description: str = "",
) -> str:
    actor_label = _actor_subject(actor)
    if MILESTONE_CREATED in event_names:
        return f"{actor_label} hat den Meilenstein erstellt."
    if MILESTONE_DELETED in event_names:
        return f"{actor_label} hat den Meilenstein gelöscht."

    sentences = []
    for field, delta in (changes or {}).items():
        sentence = _sentence_for_change(
            field,
            delta,
            actor_label,
            milestone_description=milestone_description,
        )
        if sentence is not None:
            sentences.append(sentence)
    if sentences:
        return "\n\n".join(sentences)
    return f"{actor_label} hat den Meilenstein aktualisiert."


def _card_color() -> str:
    return "Accent"


def _change_facts(changes: dict | None, actor=None) -> list[dict[str, str]]:
    facts = []
    actor_label = _actor_label(actor)
    if actor_label:
        facts.append({"title": "Geändert von", "value": actor_label})
    for field, delta in (changes or {}).items():
        if field == "description":
            continue
        if not isinstance(delta, dict):
            continue
        if "from" in delta and "to" in delta:
            before = _format_field_value(field, delta.get("from"))
            after = _format_field_value(field, delta.get("to"))
            facts.append({
                "title": _field_label(field),
                "value": f"{before} → {after}",
            })
        elif delta.get("changed"):
            facts.append({"title": _field_label(field), "value": "geändert"})
        elif "to" in delta:
            facts.append({"title": _field_label(field), "value": _format_field_value(field, delta.get("to"))})
        elif "deleted" in delta:
            facts.append({"title": _field_label(field), "value": _format_field_value(field, delta.get("deleted"))})
    return facts


def _teams_payload(
    *,
    project: Project,
    milestone_title: str,
    event_names: set[str],
    changes: dict | None = None,
    actor=None,
    milestone_description: str = "",
) -> dict:
    """Build an Adaptive Card payload for a Teams incoming webhook."""
    title = _card_title(milestone_title, event_names)
    body = _message_text(
        event_names=event_names,
        changes=changes,
        actor=actor,
        milestone_description=milestone_description,
    )
    card_body = [
        {
            "type": "TextBlock",
            "text": title,
            "weight": "Bolder",
            "size": "Medium",
            "color": _card_color(),
            "wrap": True,
        },
        {
            "type": "TextBlock",
            "text": f"Projekt: {project.name[:200]}",
            "isSubtle": True,
            "spacing": "None",
            "wrap": True,
        },
        {
            "type": "TextBlock",
            "text": body if len(body) <= 2000 else body[:1999] + "…",
            "spacing": "Medium",
            "wrap": True,
        },
    ]
    facts = _change_facts(changes, actor=actor)
    if facts:
        card_body.append({"type": "FactSet", "facts": facts})
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
    text = {"type": "TextBlock", "text": "", "wrap": True}
    if not upns:
        yield card_payload
        return
    card["body"].append(text)
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
            text["text"] = mention
    yield card_payload


def queue_project_notification(
    *,
    project: Project,
    milestone_title: str,
    event_names: set[str],
    changes: dict | None = None,
    actor=None,
    milestone_id: int | None = None,
    milestone_description: str = "",
    related_project_ids: tuple[int, ...] = (),
) -> None:
    """Persist an outbox entry in the same transaction as the milestone mutation."""
    event_names = set(normalize_notify_events(event_names))
    if not event_names or not project_wants_event(project, event_names):
        return

    webhook_url = project.workspace.teams_webhook_url
    payload = _teams_payload(
        project=project,
        milestone_title=milestone_title,
        event_names=event_names,
        changes=changes,
        actor=actor,
        milestone_description=milestone_description,
    )
    upns = _subscribers(project, related_project_ids)
    for card_payload in _with_mentions(payload, upns):
        TeamsDelivery.objects.create(
            workspace_id=project.workspace_id,
            destination_hash=destination_hash(webhook_url),
            payload=card_payload,
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
    changes: dict | None = None,
    actor=None,
    related_project_ids: tuple[int, ...] = (),
) -> None:
    queue_project_notification(
        project=project,
        milestone_title=milestone.title,
        event_names=event_names,
        changes=changes,
        actor=actor,
        milestone_id=milestone.id,
        milestone_description=milestone.description,
        related_project_ids=related_project_ids,
    )
