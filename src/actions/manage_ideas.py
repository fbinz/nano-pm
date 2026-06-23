"""Write operations for ideas."""

from datetime import date

from data.models import Idea, IdeaStatus
from actions.manage_projects import create_project
from actions.manage_tasks import create_task


def create_idea(*, workspace, creator, title: str) -> Idea:
    return Idea.objects.create(
        workspace=workspace,
        creator=creator,
        title=title.strip() or "Untitled idea",
    )


def update_idea(
    *,
    workspace,
    idea_id: int,
    title: str | None = None,
    body: str | None = None,
    status: str | None = None,
    tags: str | None = None,
) -> Idea | None:
    try:
        idea = Idea.objects.get(id=idea_id, workspace=workspace)
    except Idea.DoesNotExist:
        return None
    if title is not None:
        idea.title = title.strip() or idea.title
    if body is not None:
        idea.body = body
    if status in IdeaStatus.values:
        idea.status = status
    if tags is not None:
        idea.tags = tags.strip()
    idea.save()
    return idea


def set_idea_status(*, workspace, idea_id: int, status: str) -> Idea | None:
    return update_idea(workspace=workspace, idea_id=idea_id, status=status)


def delete_idea(*, workspace, idea_id: int) -> bool:
    deleted, _ = Idea.objects.filter(id=idea_id, workspace=workspace).delete()
    return deleted > 0


def convert_idea_to_project(*, workspace, idea_id: int, name: str | None = None) -> Idea | None:
    try:
        idea = Idea.objects.get(id=idea_id, workspace=workspace)
    except Idea.DoesNotExist:
        return None
    project = create_project(workspace=workspace, name=(name or idea.title).strip() or idea.title)
    project.description = idea.body
    project.save(update_fields=["description", "updated_at"])
    idea.status = IdeaStatus.CONVERTED
    idea.converted_project = project
    idea.save(update_fields=["status", "converted_project", "updated_at"])
    return idea


def create_task_from_idea(
    *,
    workspace,
    idea_id: int,
    project_id: int,
    title: str,
    start: date,
    end: date,
) -> Idea | None:
    try:
        idea = Idea.objects.get(id=idea_id, workspace=workspace)
    except Idea.DoesNotExist:
        return None
    task, _ = create_task(
        workspace=workspace,
        project_id=project_id,
        title=title.strip() or idea.title,
        start=start,
        end=end,
    )
    if task is None:
        return idea
    task.description = idea.body
    task.save(update_fields=["description", "updated_at"])
    idea.status = IdeaStatus.CONVERTED
    idea.converted_task = task
    idea.save(update_fields=["status", "converted_task", "updated_at"])
    return idea
