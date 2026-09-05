"""Workspace-scoped activity log readers."""

from data.models import ActivityEvent


def get_activity_events(workspace):
    return (
        ActivityEvent.objects.filter(workspace=workspace)
        .select_related("actor")
        .order_by("-created_at", "-id")
    )
