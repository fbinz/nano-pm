"""Write operations for tasks (incl. drag/move/resize). Each call runs auto_cascade."""

from datetime import date, timedelta

from django.db import transaction

from data.models import Project, Task, Person, Milestone
from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from actions.auto_cascade import cascade_workspace
from actions.manage_milestones import delete_milestone


TASK_FIELDS = ["title", "description", "start", "end"]


def _min_end(start: date) -> date:
    """Tasks use an exclusive end date; enforce at least a one-day span."""
    return start + timedelta(days=1)


def _workspace_owns_project(workspace, project_id: int) -> Project | None:
    try:
        return Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None


def _task_values(task: Task) -> dict:
    values = snapshot(task, TASK_FIELDS)
    values["project"] = task.project.name
    values["assignees"] = list(task.assignees.order_by("name", "id").values_list("name", flat=True))
    milestone = getattr(task, "milestone", None)
    values["milestone"] = milestone.title if milestone else ""
    return values


def _set_task_milestone(task: Task, milestone_id: int | None) -> None:
    """Connect a task to an existing milestone; never create or delete one."""
    if milestone_id is None:
        return

    current = Milestone.objects.filter(task=task).first()
    if milestone_id == 0:
        if current is not None:
            current.task = None
            current.save(update_fields=["task", "updated_at"])
        return

    selected = (
        Milestone.objects.filter(
            id=milestone_id,
            project__workspace=task.project.workspace,
        )
        .select_related("project")
        .first()
    )
    if selected is None:
        return
    if selected.task_id not in (None, task.id):
        return
    if selected.task_id is None and selected.project_id != task.project_id:
        return

    if current is not None and current.id != selected.id:
        current.task = None
        current.save(update_fields=["task", "updated_at"])
    selected.task = task
    # Date/project are synchronized after cascading, with notification capture.
    selected.save(update_fields=["task", "updated_at"])


@transaction.atomic
def create_task(
    *,
    workspace,
    project_id: int,
    title: str,
    start: date,
    end: date,
    actor=None,
) -> tuple[Task | None, set[int]]:
    proj = _workspace_owns_project(workspace, project_id)
    if proj is None:
        return None, set()
    if end <= start:
        end = _min_end(start)
    t = Task.objects.create(
        project=proj,
        title=title.strip() or "New task",
        start=start,
        end=end,
    )
    log_activity(
        workspace=workspace,
        actor=actor,
        action="task.created",
        entity=t,
        changes=created_changes(_task_values(t)),
    )
    cascaded = cascade_workspace(workspace, actor=actor)
    return t, cascaded


@transaction.atomic
def update_task(
    *,
    workspace,
    task_id: int,
    title: str | None = None,
    description: str | None = None,
    start: date | None = None,
    end: date | None = None,
    project_id: int | None = None,
    assignee_ids: list[int] | None = None,
    milestone_id: int | None = None,
    actor=None,
) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").prefetch_related("assignees").get(
            id=task_id, project__workspace=workspace
        )
    except Task.DoesNotExist:
        return None, set()
    before = _task_values(t)
    if title is not None:
        t.title = title.strip() or t.title
    if description is not None:
        t.description = description
    if start is not None:
        t.start = start
    if end is not None:
        t.end = max(end, _min_end(t.start))
    if t.end <= t.start:
        t.end = _min_end(t.start)
    if project_id is not None:
        new_proj = _workspace_owns_project(workspace, project_id)
        if new_proj is not None:
            t.project = new_proj
    t.save()
    _set_task_milestone(t, milestone_id)
    if assignee_ids is not None:
        valid_ids = list(
            Person.objects.filter(id__in=assignee_ids, workspace=workspace).values_list(
                "id", flat=True
            )
        )
        t.assignees.set(valid_ids)
    t = Task.objects.select_related("project").prefetch_related("assignees").get(id=t.id)
    changes = change_set(before, _task_values(t))
    log_activity(
        workspace=workspace,
        actor=actor,
        action="task.updated",
        entity=t,
        changes=changes,
        skip_empty_changes=True,
    )
    cascaded = cascade_workspace(workspace, actor=actor)
    return t, cascaded


@transaction.atomic
def delete_task(*, workspace, task_id: int, actor=None) -> bool:
    task = Task.objects.filter(id=task_id, project__workspace=workspace).select_related("project").prefetch_related("assignees").first()
    if task is None:
        return False
    values = _task_values(task)
    label = task.title
    entity_id = task.id
    linked = getattr(task, "milestone", None)
    if linked is not None:
        delete_milestone(workspace=workspace, milestone_id=linked.id, actor=actor)
    task.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="task.deleted",
        entity_type="task",
        entity_id=entity_id,
        entity_label=label,
        changes=deleted_changes(values),
    )
    return True


@transaction.atomic
def move_task(*, workspace, task_id: int, new_start: date, actor=None) -> tuple[Task | None, set[int]]:
    """Slide a task by setting a new start date; preserves duration."""
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__workspace=workspace
        )
    except Task.DoesNotExist:
        return None, set()
    before = snapshot(t, ["start", "end"])
    duration = t.end - t.start
    t.start = new_start
    t.end = new_start + duration
    t.save(update_fields=["start", "end"])
    changes = change_set(before, snapshot(t, ["start", "end"]))
    log_activity(
        workspace=workspace,
        actor=actor,
        action="task.moved",
        entity=t,
        changes=changes,
        skip_empty_changes=True,
    )
    cascaded = cascade_workspace(workspace, actor=actor)
    return t, cascaded


@transaction.atomic
def move_many_tasks(
    *, workspace, task_ids: list[int], delta_days: int, actor=None
) -> tuple[list[Task], set[int]]:
    """Shift every task in `task_ids` by `delta_days` (preserves duration);
    runs auto_cascade once at the end so successor pushes happen as a batch."""
    delta = timedelta(days=delta_days)
    tasks = list(
        Task.objects.filter(id__in=task_ids, project__workspace=workspace)
    )
    before = {t.id: snapshot(t, ["start", "end"]) for t in tasks}
    for t in tasks:
        t.start = t.start + delta
        t.end = t.end + delta
    if tasks:
        Task.objects.bulk_update(tasks, ["start", "end"])
        log_activity(
            workspace=workspace,
            actor=actor,
            action="tasks.bulk_moved",
            entity_type="tasks",
            entity_label=f"{len(tasks)} tasks",
            changes={str(t.id): change_set(before[t.id], snapshot(t, ["start", "end"])) for t in tasks},
            metadata={
                "count": len(tasks),
                "delta_days": delta_days,
                "task_ids": [t.id for t in tasks],
                "task_titles": [t.title for t in tasks],
            },
        )
    cascaded = cascade_workspace(workspace, actor=actor)
    return tasks, cascaded


@transaction.atomic
def resize_end(*, workspace, task_id: int, new_end: date, actor=None) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__workspace=workspace
        )
    except Task.DoesNotExist:
        return None, set()
    before = snapshot(t, ["end"])
    t.end = max(new_end, _min_end(t.start))
    t.save(update_fields=["end"])
    log_activity(
        workspace=workspace,
        actor=actor,
        action="task.resized",
        entity=t,
        changes=change_set(before, snapshot(t, ["end"])),
        skip_empty_changes=True,
    )
    cascaded = cascade_workspace(workspace, actor=actor)
    return t, cascaded


@transaction.atomic
def resize_start(*, workspace, task_id: int, new_start: date, actor=None) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__workspace=workspace
        )
    except Task.DoesNotExist:
        return None, set()
    before = snapshot(t, ["start"])
    t.start = min(new_start, t.end - timedelta(days=1))
    t.save(update_fields=["start"])
    log_activity(
        workspace=workspace,
        actor=actor,
        action="task.resized",
        entity=t,
        changes=change_set(before, snapshot(t, ["start"])),
        skip_empty_changes=True,
    )
    cascaded = cascade_workspace(workspace, actor=actor)
    return t, cascaded
