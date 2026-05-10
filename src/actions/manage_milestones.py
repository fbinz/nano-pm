"""Write operations for milestones."""

from datetime import date

from data.models import Milestone, Project


def create_milestone(
    *, owner, project_id: int, title: str, on: date
) -> Milestone | None:
    try:
        proj = Project.objects.get(id=project_id, owner=owner)
    except Project.DoesNotExist:
        return None
    return Milestone.objects.create(
        project=proj, title=title.strip() or "Milestone", date=on
    )


def update_milestone(
    *,
    owner,
    milestone_id: int,
    title: str | None = None,
    description: str | None = None,
    on: date | None = None,
    project_id: int | None = None,
) -> Milestone | None:
    try:
        m = Milestone.objects.select_related("project").get(
            id=milestone_id, project__owner=owner
        )
    except Milestone.DoesNotExist:
        return None
    if title is not None:
        m.title = title.strip() or m.title
    if description is not None:
        m.description = description
    if on is not None:
        m.date = on
    if project_id is not None:
        try:
            new_proj = Project.objects.get(id=project_id, owner=owner)
            m.project = new_proj
        except Project.DoesNotExist:
            pass
    m.save()
    return m


def delete_milestone(*, owner, milestone_id: int) -> bool:
    deleted, _ = Milestone.objects.filter(
        id=milestone_id, project__owner=owner
    ).delete()
    return deleted > 0
