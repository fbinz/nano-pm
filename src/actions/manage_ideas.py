"""Write operations for ideas."""

from datetime import date

from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from data.models import Idea, IdeaStatus
from actions.manage_projects import create_project
from actions.manage_tasks import create_task


IDEA_FIELDS = ["title", "body", "status", "tags"]


def _idea_values(idea: Idea) -> dict:
    values = snapshot(idea, IDEA_FIELDS)
    if idea.converted_project_id:
        values["converted_project"] = idea.converted_project.name
    if idea.converted_task_id:
        values["converted_task"] = idea.converted_task.title
    return values


def create_idea(*, workspace, creator, title: str, actor=None) -> Idea:
    idea = Idea.objects.create(
        workspace=workspace,
        creator=creator,
        title=title.strip() or "Untitled idea",
    )
    log_activity(
        workspace=workspace,
        actor=actor or creator,
        action="idea.created",
        entity=idea,
        changes=created_changes(_idea_values(idea)),
    )
    return idea


def update_idea(
    *,
    workspace,
    idea_id: int,
    title: str | None = None,
    body: str | None = None,
    status: str | None = None,
    tags: str | None = None,
    actor=None,
) -> Idea | None:
    try:
        idea = Idea.objects.select_related("converted_project", "converted_task").get(
            id=idea_id, workspace=workspace
        )
    except Idea.DoesNotExist:
        return None
    before = _idea_values(idea)
    if title is not None:
        idea.title = title.strip() or idea.title
    if body is not None:
        idea.body = body
    if status in IdeaStatus.values:
        idea.status = status
    if tags is not None:
        idea.tags = tags.strip()
    idea.save()
    idea = Idea.objects.select_related("converted_project", "converted_task").get(id=idea.id)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="idea.updated",
        entity=idea,
        changes=change_set(before, _idea_values(idea)),
        skip_empty_changes=True,
    )
    return idea


def set_idea_status(*, workspace, idea_id: int, status: str, actor=None) -> Idea | None:
    return update_idea(workspace=workspace, idea_id=idea_id, status=status, actor=actor)


def delete_idea(*, workspace, idea_id: int, actor=None) -> bool:
    idea = Idea.objects.filter(id=idea_id, workspace=workspace).select_related(
        "converted_project", "converted_task"
    ).first()
    if idea is None:
        return False
    values = _idea_values(idea)
    label = idea.title
    entity_id = idea.id
    idea.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="idea.deleted",
        entity_type="idea",
        entity_id=entity_id,
        entity_label=label,
        changes=deleted_changes(values),
    )
    return True


def convert_idea_to_project(
    *, workspace, idea_id: int, name: str | None = None, actor=None
) -> Idea | None:
    try:
        idea = Idea.objects.get(id=idea_id, workspace=workspace)
    except Idea.DoesNotExist:
        return None
    before = _idea_values(idea)
    project = create_project(
        workspace=workspace,
        name=(name or idea.title).strip() or idea.title,
        actor=actor,
    )
    project.description = idea.body
    project.save(update_fields=["description", "updated_at"])
    idea.status = IdeaStatus.CONVERTED
    idea.converted_project = project
    idea.save(update_fields=["status", "converted_project", "updated_at"])
    idea = Idea.objects.select_related("converted_project", "converted_task").get(id=idea.id)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="idea.converted",
        entity=idea,
        changes=change_set(before, _idea_values(idea)),
        metadata={"converted_project_id": project.id},
    )
    return idea


def create_task_from_idea(
    *,
    workspace,
    idea_id: int,
    project_id: int,
    title: str,
    start: date,
    end: date,
    actor=None,
) -> Idea | None:
    try:
        idea = Idea.objects.get(id=idea_id, workspace=workspace)
    except Idea.DoesNotExist:
        return None
    before = _idea_values(idea)
    task, _ = create_task(
        workspace=workspace,
        project_id=project_id,
        title=title.strip() or idea.title,
        start=start,
        end=end,
        actor=actor,
    )
    if task is None:
        return idea
    task.description = idea.body
    task.save(update_fields=["description", "updated_at"])
    idea.status = IdeaStatus.CONVERTED
    idea.converted_task = task
    idea.save(update_fields=["status", "converted_task", "updated_at"])
    idea = Idea.objects.select_related("converted_project", "converted_task").get(id=idea.id)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="idea.converted",
        entity=idea,
        changes=change_set(before, _idea_values(idea)),
        metadata={"converted_task_id": task.id},
    )
    return idea
