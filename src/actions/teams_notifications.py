"""Microsoft Teams milestone notifications."""

import json
import logging
from datetime import date
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.db import transaction

from data.models import Milestone, Project
from data.models.project import TEAMS_NOTIFY_EVENT_KEYS

logger = logging.getLogger(__name__)

MILESTONE_CREATED = "milestone.created"
MILESTONE_MOVED = "milestone.moved"
MILESTONE_UPDATED = "milestone.updated"
MILESTONE_PROJECT_CHANGED = "milestone.project_changed"
MILESTONE_DELETED = "milestone.deleted"

DEFAULT_TIMEOUT_SECONDS = 3.0
GERMAN_MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
]


def _timeout() -> float:
    value = getattr(settings, "TEAMS_WEBHOOK_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
    try:
        return max(0.1, float(value))
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS


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
    if not project.teams_webhook_url:
        return False
    enabled = set(normalize_notify_events(project.teams_notify_events))
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
    return str(value)


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
    return f"Meilenstein {milestone_title} {action}"


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
            "text": f"Projekt: {project.name}",
            "isSubtle": True,
            "spacing": "None",
            "wrap": True,
        },
        {
            "type": "TextBlock",
            "text": body,
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


def _post_teams_message(webhook_url: str, payload: dict) -> tuple[int, str]:
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=_timeout()) as response:  # noqa: S310 - user-configured webhook URL
        response_body = response.read().decode("utf-8", errors="replace")
        return response.status, response_body


def queue_project_notification(
    *,
    project: Project,
    milestone_title: str,
    event_names: set[str],
    changes: dict | None = None,
    actor=None,
    milestone_id: int | None = None,
    milestone_description: str = "",
) -> None:
    """Send a Teams notification after the current transaction commits.

    Notification failures are logged and never abort the user action.
    """
    event_names = set(normalize_notify_events(event_names))
    event_list = sorted(event_names)
    log_context = {
        "project_id": project.id,
        "milestone_id": milestone_id,
        "milestone_title": milestone_title,
        "events": event_list,
        "actor": _actor_label(actor),
    }
    if not event_names:
        logger.debug("Skipping Teams milestone notification with no supported events: %s", log_context)
        return
    if not project.teams_webhook_url:
        logger.debug("Skipping Teams milestone notification with no webhook: %s", log_context)
        return
    if not project_wants_event(project, event_names):
        logger.debug("Skipping Teams milestone notification for disabled events: %s", log_context)
        return

    webhook_url = project.teams_webhook_url
    payload = _teams_payload(
        project=project,
        milestone_title=milestone_title,
        event_names=event_names,
        changes=changes,
        actor=actor,
        milestone_description=milestone_description,
    )
    logger.info("Queueing Teams milestone notification: %s", log_context)
    logger.debug("Teams milestone notification payload: %s", payload)

    def send() -> None:
        try:
            status, response_body = _post_teams_message(webhook_url, payload)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            logger.warning(
                "Failed to send Teams milestone notification: %s error=%s",
                log_context,
                exc,
            )
            return
        logger.info(
            "Sent Teams milestone notification: %s status=%s response=%r",
            log_context,
            status,
            response_body[:500],
        )

    transaction.on_commit(send)


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
) -> None:
    queue_project_notification(
        project=project,
        milestone_title=milestone.title,
        event_names=event_names,
        changes=changes,
        actor=actor,
        milestone_id=milestone.id,
        milestone_description=milestone.description,
    )
