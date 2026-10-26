"""Transactional, editable project summaries. No network I/O lives here."""

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from data.models import NotificationBatch, NotificationChange


@transaction.atomic
def record_change(*, project, milestone_id, before, after, events, actor_label, reason, recipients, destination_hash):
    now = timezone.now()
    # A transfer carries its existing baseline into the destination project's
    # batch, but never across workspace/destination boundaries.
    change = NotificationChange.objects.select_for_update().filter(
        milestone_key=milestone_id, batch__workspace=project.workspace,
        batch__destination_hash=destination_hash, batch__status=NotificationBatch.Status.OPEN,
    ).first()
    if not events and change is None:
        return
    batch, _ = NotificationBatch.objects.select_for_update().get_or_create(
        workspace=project.workspace, project_key=project.id, destination_hash=destination_hash,
        status=NotificationBatch.Status.OPEN,
        defaults={"project_name": project.name, "send_after": now + timedelta(minutes=15)},
    )
    previous_batch = change.batch if change is not None else None
    if change is None:
        change = NotificationChange(batch=batch, milestone_key=milestone_id, before=before)
    change.batch = batch
    change.after = after
    change.events = sorted(set(change.events or []) | set(events))
    change.recipients = sorted(set(change.recipients or []) | set(recipients))
    change.contributors = sorted(set(change.contributors or []) | ({actor_label} if actor_label else set()))
    if before is not None and after is not None and before["date"] != after["date"]:
        change.latest_move_reason = reason.strip()[:500]
        change.latest_move_actor = actor_label[:300]
        change.latest_move_at = now
    if change.before is None or after is None or change.before["date"] == after["date"]:
        change.latest_move_reason = ""
        change.latest_move_actor = ""
        change.latest_move_at = None
    change.save()
    if previous_batch is not None and previous_batch.id != batch.id and not previous_batch.changes.exists():
        previous_batch.status = NotificationBatch.Status.CANCELLED
        previous_batch.materialized_at = now
        previous_batch.save(update_fields=["status", "materialized_at"])
    batch.project_name = project.name
    batch.last_changed_at = now
    batch.send_after = now + timedelta(minutes=15)
    batch.save(update_fields=["project_name", "last_changed_at", "send_after"])
