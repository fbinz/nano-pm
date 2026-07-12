"""Write operations for milestones."""

from datetime import date, timedelta

from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from actions.teams_notifications import (
    MILESTONE_CREATED,
    MILESTONE_DELETED,
    milestone_event_names_from_changes,
    queue_milestone_notification,
    queue_project_notification,
)
from data.models import Milestone, Project
from actions.auto_cascade import cascade_workspace


MILESTONE_FIELDS = ["title", "description", "date"]
DEFAULT_MILESTONE_TITLE = "New milestone"


def _is_default_created_milestone(milestone: Milestone) -> bool:
    return milestone.title == DEFAULT_MILESTONE_TITLE and not milestone.description.strip()


def _milestone_values(milestone: Milestone) -> dict:
    values = snapshot(milestone, MILESTONE_FIELDS)
    values["project"] = milestone.project.name
    if milestone.task_id:
        values["task"] = milestone.task.title
    return values


def _sync_linked_milestones(workspace) -> None:
    milestones = Milestone.objects.filter(
        task__project__workspace=workspace
    ).select_related("task", "task__project")
    for milestone in milestones:
        task = milestone.task
        changed = []
        if milestone.project_id != task.project_id:
            milestone.project = task.project
            changed.append("project")
        if milestone.date != task.end:
            milestone.date = task.end
            changed.append("date")
        if changed:
            changed.append("updated_at")
            milestone.save(update_fields=changed)


def create_milestone(
    *, workspace, project_id: int, title: str, on: date, actor=None
) -> Milestone | None:
    try:
        proj = Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None
    milestone = Milestone.objects.create(
        project=proj, title=title.strip() or "Milestone", date=on
    )
    changes = created_changes(_milestone_values(milestone))
    log_activity(
        workspace=workspace,
        actor=actor,
        action="milestone.created",
        entity=milestone,
        changes=changes,
    )
    if not _is_default_created_milestone(milestone):
        queue_milestone_notification(
            project=proj,
            milestone=milestone,
            event_names={MILESTONE_CREATED},
            changes=changes,
            actor=actor,
        )
    return milestone


def update_milestone(
    *,
    workspace,
    milestone_id: int,
    title: str | None = None,
    description: str | None = None,
    on: date | None = None,
    project_id: int | None = None,
    actor=None,
) -> Milestone | None:
    try:
        m = Milestone.objects.select_related("project", "task").get(
            id=milestone_id, project__workspace=workspace
        )
    except Milestone.DoesNotExist:
        return None
    before_project = m.project
    before = _milestone_values(m)
    if m.task_id:
        task = m.task
        if title is not None:
            m.title = title.strip() or m.title
        if description is not None:
            m.description = description.strip()
        if on is not None:
            task.end = max(on, task.start + timedelta(days=1))
            task.save(update_fields=["end"])
        m.project = task.project
        m.date = task.end
        m.save(update_fields=["project", "title", "description", "date", "updated_at"])
        if on is not None:
            cascade_workspace(workspace)
            _sync_linked_milestones(workspace)
    else:
        if title is not None:
            m.title = title.strip() or m.title
        if description is not None:
            m.description = description
        if on is not None:
            m.date = on
        if project_id is not None:
            try:
                new_proj = Project.objects.get(id=project_id, workspace=workspace)
                m.project = new_proj
            except Project.DoesNotExist:
                pass
        m.save()
    m = Milestone.objects.select_related("project", "task").get(id=m.id)
    after = _milestone_values(m)
    changes = change_set(before, after)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="milestone.updated" if on is None else "milestone.moved",
        entity=m,
        changes=changes,
        skip_empty_changes=True,
    )
    event_names = milestone_event_names_from_changes(changes)
    if event_names:
        if before_project.id != m.project_id:
            queue_project_notification(
                project=before_project,
                milestone_title=m.title,
                event_names=event_names,
                changes=changes,
                actor=actor,
                milestone_id=m.id,
            )
        queue_milestone_notification(
            project=m.project,
            milestone=m,
            event_names=event_names,
            changes=changes,
            actor=actor,
        )
    return m


def delete_milestone(*, workspace, milestone_id: int, actor=None) -> bool:
    milestone = Milestone.objects.filter(
        id=milestone_id, project__workspace=workspace
    ).select_related("project").first()
    if milestone is None:
        return False
    values = _milestone_values(milestone)
    changes = deleted_changes(values)
    label = milestone.title
    entity_id = milestone.id
    queue_project_notification(
        project=milestone.project,
        milestone_title=label,
        event_names={MILESTONE_DELETED},
        changes=changes,
        actor=actor,
        milestone_id=entity_id,
    )
    milestone.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="milestone.deleted",
        entity_type="milestone",
        entity_id=entity_id,
        entity_label=label,
        changes=changes,
    )
    return True
