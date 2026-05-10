"""Write operations for tasks (incl. drag/move/resize). Each call runs auto_cascade."""

from datetime import date, timedelta

from data.models import Project, Task, TaskStatus, Person
from actions.auto_cascade import cascade_user


def _user_owns_project(user, project_id: int) -> Project | None:
    try:
        return Project.objects.get(id=project_id, owner=user)
    except Project.DoesNotExist:
        return None


def create_task(
    *,
    owner,
    project_id: int,
    title: str,
    start: date,
    end: date,
    status: str = TaskStatus.PLANNED,
) -> tuple[Task | None, set[int]]:
    proj = _user_owns_project(owner, project_id)
    if proj is None:
        return None, set()
    if end < start:
        end = start
    t = Task.objects.create(
        project=proj,
        title=title.strip() or "New task",
        start=start,
        end=end,
        status=status,
    )
    cascaded = cascade_user(owner)
    return t, cascaded


def update_task(
    *,
    owner,
    task_id: int,
    title: str | None = None,
    description: str | None = None,
    start: date | None = None,
    end: date | None = None,
    status: str | None = None,
    project_id: int | None = None,
    assignee_ids: list[int] | None = None,
) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__owner=owner
        )
    except Task.DoesNotExist:
        return None, set()
    if title is not None:
        t.title = title.strip() or t.title
    if description is not None:
        t.description = description
    if start is not None:
        t.start = start
    if end is not None:
        t.end = max(end, t.start)
    if status is not None and status in dict(TaskStatus.choices):
        t.status = status
    if project_id is not None:
        new_proj = _user_owns_project(owner, project_id)
        if new_proj is not None:
            t.project = new_proj
    t.save()
    if assignee_ids is not None:
        valid_ids = list(
            Person.objects.filter(id__in=assignee_ids, owner=owner).values_list(
                "id", flat=True
            )
        )
        t.assignees.set(valid_ids)
    cascaded = cascade_user(owner)
    return t, cascaded


def delete_task(*, owner, task_id: int) -> bool:
    deleted, _ = Task.objects.filter(id=task_id, project__owner=owner).delete()
    return deleted > 0


def move_task(*, owner, task_id: int, new_start: date) -> tuple[Task | None, set[int]]:
    """Slide a task by setting a new start date; preserves duration."""
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__owner=owner
        )
    except Task.DoesNotExist:
        return None, set()
    duration = t.end - t.start
    t.start = new_start
    t.end = new_start + duration
    t.save(update_fields=["start", "end"])
    cascaded = cascade_user(owner)
    return t, cascaded


def move_many_tasks(
    *, owner, task_ids: list[int], delta_days: int
) -> tuple[list[Task], set[int]]:
    """Shift every owned task in `task_ids` by `delta_days` (preserves duration);
    runs auto_cascade once at the end so successor pushes happen as a batch."""
    delta = timedelta(days=delta_days)
    tasks = list(
        Task.objects.filter(id__in=task_ids, project__owner=owner)
    )
    for t in tasks:
        t.start = t.start + delta
        t.end = t.end + delta
    if tasks:
        Task.objects.bulk_update(tasks, ["start", "end"])
    cascaded = cascade_user(owner)
    return tasks, cascaded


def resize_end(*, owner, task_id: int, new_end: date) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__owner=owner
        )
    except Task.DoesNotExist:
        return None, set()
    t.end = max(new_end, t.start)
    t.save(update_fields=["end"])
    cascaded = cascade_user(owner)
    return t, cascaded


def resize_start(*, owner, task_id: int, new_start: date) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__owner=owner
        )
    except Task.DoesNotExist:
        return None, set()
    t.start = min(new_start, t.end)
    t.save(update_fields=["start"])
    # Pulling start earlier or pushing it later (without crossing end) doesn't
    # violate any FS dep on the predecessor side, so cascade is a cheap no-op.
    cascaded = cascade_user(owner)
    return t, cascaded
