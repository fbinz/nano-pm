"""Keep task-linked milestones in sync, including history and notifications."""

from actions.activity import log_activity
from actions.teams_notifications import milestone_event_names_from_changes, queue_milestone_notification
from data.models import Milestone


def sync_linked_milestones(workspace, *, actor=None, exclude_notifications=()):
    milestones = Milestone.objects.filter(task__project__workspace=workspace).select_related(
        "project__workspace", "task__project__workspace",
    )
    for milestone in milestones:
        task = milestone.task
        previous_project_id = milestone.project_id
        changes = {}
        if milestone.project_id != task.project_id:
            changes["project"] = {"from": milestone.project.name, "to": task.project.name}
        if milestone.date != task.end:
            changes["date"] = {"from": milestone.date.isoformat(), "to": task.end.isoformat()}
        if not changes:
            continue
        milestone.project = task.project
        milestone.date = task.end
        milestone.save(update_fields=["project", "date", "updated_at"])
        # Direct milestone edits log their final changes (and any move reason)
        # themselves. Task-driven changes need their own milestone history entry.
        if milestone.id not in exclude_notifications:
            log_activity(
                workspace=workspace, actor=actor,
                action="milestone.moved" if "date" in changes else "milestone.updated",
                entity=milestone, changes=changes,
            )
        if milestone.id not in exclude_notifications and not milestone.is_placeholder:
            queue_milestone_notification(
                project=milestone.project, milestone=milestone,
                event_names=milestone_event_names_from_changes(changes),
                changes=changes, actor=actor, related_project_ids=(previous_project_id,),
            )
