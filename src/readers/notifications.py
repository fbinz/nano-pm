"""Only editable reasons for the current workspace and webhook destination."""

import hashlib

from data.models import NotificationBatch, NotificationChange


def pending_move_reason(workspace, milestone_id: int) -> str:
    if not workspace.teams_webhook_url:
        return ""
    changes = NotificationChange.objects.filter(
        milestone_key=milestone_id,
        batch__workspace=workspace, batch__status=NotificationBatch.Status.OPEN,
        batch__destination_hash=hashlib.sha256(workspace.teams_webhook_url.encode()).hexdigest(),
    )
    return changes.values_list("latest_move_reason", flat=True).first() or ""
