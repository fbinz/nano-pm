"""Workspace-scoped activity log readers."""

from data.models import ActivityEvent


def get_milestone_history(workspace, milestone_id):
    return get_activity_events(workspace).filter(entity_type="milestone", entity_id=milestone_id)


def get_activity_events(workspace):
    return (
        ActivityEvent.objects.filter(workspace=workspace)
        .select_related("actor")
        .order_by("-created_at", "-id")
    )
