"""Write operations for tasks (incl. drag/move/resize). Each call runs auto_cascade."""

from datetime import date, timedelta

from data.models import Project, Task, Person, Milestone
from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from actions.auto_cascade import cascade_workspace


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


def _find_free_milestone_for_title(task: Task, title: str) -> Milestone | None:
    return (
        Milestone.objects.filter(
            task__isnull=True,
            project_id=task.project_id,
            title=title,
        )
        .order_by("date", "id")
        .first()
    )


def _set_task_milestone(task: Task, title: str | None) -> None:
    if title is None:
        return
    title = title.strip()
    milestone = getattr(task, "milestone", None)
    if title:
        if milestone is not None and milestone.title == title:
            milestone.project = task.project
            milestone.date = task.end
            milestone.save(update_fields=["project", "date", "updated_at"])
            return
        existing = _find_free_milestone_for_title(task, title)
        if existing is not None:
            if milestone is not None:
                milestone.delete()
            existing.project = task.project
            existing.task = task
            existing.date = task.end
            existing.save(update_fields=["project", "task", "date", "updated_at"])
        elif milestone is None:
            Milestone.objects.create(
                project=task.project,
                task=task,
                title=title,
                date=task.end,
            )
        else:
            milestone.project = task.project
            milestone.title = title
            milestone.date = task.end
            milestone.save(update_fields=["project", "title", "date", "updated_at"])
    elif milestone is not None:
        milestone.delete()


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
    cascaded = cascade_workspace(workspace)
    _sync_linked_milestones(workspace)
    return t, cascaded


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
    milestone_title: str | None = None,
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
    _set_task_milestone(t, milestone_title)
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
    cascaded = cascade_workspace(workspace)
    _sync_linked_milestones(workspace)
    return t, cascaded


def delete_task(*, workspace, task_id: int, actor=None) -> bool:
    task = Task.objects.filter(id=task_id, project__workspace=workspace).select_related("project").prefetch_related("assignees").first()
    if task is None:
        return False
    values = _task_values(task)
    label = task.title
    entity_id = task.id
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
    cascaded = cascade_workspace(workspace)
    _sync_linked_milestones(workspace)
    return t, cascaded


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
    cascaded = cascade_workspace(workspace)
    _sync_linked_milestones(workspace)
    return tasks, cascaded


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
    cascaded = cascade_workspace(workspace)
    _sync_linked_milestones(workspace)
    return t, cascaded


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
    cascaded = cascade_workspace(workspace)
    _sync_linked_milestones(workspace)
    return t, cascaded
