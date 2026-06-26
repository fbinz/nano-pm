"""Activity log helpers.

Domain actions call these helpers after a successful mutation.  Values are kept
small, serialisable, and safe to render back to workspace members.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.db.models import Model

from data.models import ActivityEvent


LONG_TEXT_FIELDS = {
    "body",
    "description",
    "public_roadmap_description",
}

LONG_TEXT_CHANGE = {"changed": True}


def _is_long_text_field(field: str) -> bool:
    return field in LONG_TEXT_FIELDS


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Model):
        return str(value)
    if isinstance(value, (list, tuple, set)):
        return [_json_value(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _json_value(v) for k, v in value.items()}
    return value


def snapshot(obj: Model, fields: list[str]) -> dict[str, Any]:
    return {field: _json_value(getattr(obj, field)) for field in fields}


def change_set(before: dict[str, Any], after: dict[str, Any]) -> dict[str, dict[str, Any]]:
    changes = {}
    for field, old in before.items():
        new = after.get(field)
        if old != new:
            changes[field] = LONG_TEXT_CHANGE if _is_long_text_field(field) else {"from": old, "to": new}
    return changes


def created_changes(values: dict[str, Any]) -> dict[str, dict[str, Any]]:
    changes = {}
    for field, value in values.items():
        if _is_long_text_field(field):
            if value:
                changes[field] = LONG_TEXT_CHANGE
        else:
            changes[field] = {"to": _json_value(value)}
    return changes


def deleted_changes(values: dict[str, Any]) -> dict[str, dict[str, Any]]:
    changes = {}
    for field, value in values.items():
        if _is_long_text_field(field):
            if value:
                changes[field] = LONG_TEXT_CHANGE
        else:
            changes[field] = {"deleted": _json_value(value)}
    return changes


def redact_long_text_changes(changes: dict[str, Any]) -> dict[str, Any]:
    """Remove potentially long/sensitive text values before they reach JSONField."""
    redacted = {}
    for field, change in (changes or {}).items():
        if _is_long_text_field(field):
            redacted[field] = LONG_TEXT_CHANGE
        elif isinstance(change, dict):
            redacted[field] = redact_long_text_changes(change)
        else:
            redacted[field] = change
    return redacted


def labels_for(qs, field: str = "name") -> list[str]:
    return [str(getattr(obj, field, obj)) for obj in qs]


def log_activity(
    *,
    workspace,
    actor=None,
    action: str,
    entity: Model | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
    entity_label: str = "",
    changes: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    skip_empty_changes: bool = False,
) -> None:
    """Create an ActivityEvent when the surrounding transaction commits."""

    clean_changes = _json_value(redact_long_text_changes(changes or {}))
    if skip_empty_changes and not clean_changes:
        return

    if entity is not None:
        entity_type = entity_type or entity.__class__.__name__.lower()
        entity_id = entity_id if entity_id is not None else getattr(entity, "id", None)
        entity_label = entity_label or str(entity)
    if not entity_type:
        raise ValueError("entity_type is required when entity is not supplied")

    actor_id = getattr(actor, "id", None)
    workspace_id = getattr(workspace, "id", workspace)
    clean_metadata = _json_value(metadata or {})

    def create_event() -> None:
        ActivityEvent.objects.create(
            workspace_id=workspace_id,
            actor_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_label=(entity_label or "")[:255],
            changes=clean_changes,
            metadata=clean_metadata,
        )

    transaction.on_commit(create_event)
