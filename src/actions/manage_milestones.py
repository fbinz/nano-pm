"""Write operations for milestones."""

from datetime import date

from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from data.models import Milestone, Project


MILESTONE_FIELDS = ["title", "description", "date"]


def _milestone_values(milestone: Milestone) -> dict:
    values = snapshot(milestone, MILESTONE_FIELDS)
    values["project"] = milestone.project.name
    return values


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
    log_activity(
        workspace=workspace,
        actor=actor,
        action="milestone.created",
        entity=milestone,
        changes=created_changes(_milestone_values(milestone)),
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
        m = Milestone.objects.select_related("project").get(
            id=milestone_id, project__workspace=workspace
        )
    except Milestone.DoesNotExist:
        return None
    before = _milestone_values(m)
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
    m = Milestone.objects.select_related("project").get(id=m.id)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="milestone.updated" if on is None else "milestone.moved",
        entity=m,
        changes=change_set(before, _milestone_values(m)),
        skip_empty_changes=True,
    )
    return m


def delete_milestone(*, workspace, milestone_id: int, actor=None) -> bool:
    milestone = Milestone.objects.filter(
        id=milestone_id, project__workspace=workspace
    ).select_related("project").first()
    if milestone is None:
        return False
    values = _milestone_values(milestone)
    label = milestone.title
    entity_id = milestone.id
    milestone.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="milestone.deleted",
        entity_type="milestone",
        entity_id=entity_id,
        entity_label=label,
        changes=deleted_changes(values),
    )
    return True
