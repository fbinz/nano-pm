"""Write operations for tasks (incl. drag/move/resize). Each call runs auto_cascade."""

from datetime import date, timedelta

from data.models import Project, Task, TaskStatus, TaskOrder, Person
from actions.auto_cascade import cascade_workspace
from actions.lexorank import rank_between


def _workspace_owns_project(workspace, project_id: int) -> Project | None:
    try:
        return Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None


def create_task(
    *,
    workspace,
    project_id: int,
    title: str,
    start: date,
    end: date,
    status: str = TaskStatus.PLANNED,
) -> tuple[Task | None, set[int]]:
    proj = _workspace_owns_project(workspace, project_id)
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
    cascaded = cascade_workspace(workspace)
    return t, cascaded


def update_task(
    *,
    workspace,
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
            id=task_id, project__workspace=workspace
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
        new_proj = _workspace_owns_project(workspace, project_id)
        if new_proj is not None:
            t.project = new_proj
    t.save()
    if assignee_ids is not None:
        valid_ids = list(
            Person.objects.filter(id__in=assignee_ids, workspace=workspace).values_list(
                "id", flat=True
            )
        )
        t.assignees.set(valid_ids)
    cascaded = cascade_workspace(workspace)
    return t, cascaded


def _column_task_ids(
    workspace, dimension: str, group_key: str, ranks: dict[int, str]
) -> list[int]:
    """Task ids currently in one board column, in display order — ranked cards
    first (by rank), then not-yet-ranked cards (by start, id). Mirrors the sort
    in readers.chart_view.build_kanban_vm so a seed matches what the user sees.
    Only the "status" grouping exists today."""
    if dimension != "status":
        return []
    tasks = Task.objects.filter(project__workspace=workspace, status=group_key)
    return [
        t.id
        for t in sorted(
            tasks,
            key=lambda t: (t.id not in ranks, ranks.get(t.id, ""), t.start.isoformat(), t.id),
        )
    ]


def _ensure_column_ranks(workspace, dimension: str, group_key: str) -> dict[int, str]:
    """Return {task_id: rank} for a column, seeding ranks for the whole column
    the first time it's touched (or whenever a card in it still lacks one). A
    card reaches a column unranked when freshly created; seeding (re)spreads
    evenly-gapped ranks in current display order so neighbour lookups during a
    drop are always well-defined."""
    ranks = {
        o.task_id: o.rank
        for o in TaskOrder.objects.filter(
            dimension=dimension, group_key=group_key, task__project__workspace=workspace
        )
    }
    ordered = _column_task_ids(workspace, dimension, group_key, ranks)
    if all(tid in ranks for tid in ordered):
        return ranks
    prev = ""
    for tid in ordered:
        prev = rank_between(prev, "")
        TaskOrder.objects.update_or_create(
            task_id=tid,
            dimension=dimension,
            group_key=group_key,
            defaults={"rank": prev},
        )
        ranks[tid] = prev
    return ranks


def reorder_task(
    *,
    workspace,
    task_id: int,
    dimension: str,
    group_key: str,
    before_id: int | None,
    after_id: int | None,
) -> Task | None:
    """Persist a new position for `task_id` within (`dimension`, `group_key`),
    dropped between `before_id` (the card above) and `after_id` (the card
    below). Writes one TaskOrder row with a fractional rank between the two
    neighbours — no other card is touched, apart from a one-off column seed."""
    try:
        task = Task.objects.get(id=task_id, project__workspace=workspace)
    except Task.DoesNotExist:
        return None
    ranks = _ensure_column_ranks(workspace, dimension, group_key)
    lo = ranks.get(before_id, "") if before_id else ""
    hi = ranks.get(after_id, "") if after_id else ""
    if lo and hi and lo >= hi:
        # Neighbours not in the expected order (stale client) — append after the
        # upper one rather than emit an invalid rank.
        hi = ""
    new_rank = rank_between(lo, hi)
    TaskOrder.objects.update_or_create(
        task=task,
        dimension=dimension,
        group_key=group_key,
        defaults={"rank": new_rank},
    )
    return task


def move_task_on_board(
    *,
    workspace,
    task_id: int,
    status: str,
    before_id: int | None,
    after_id: int | None,
) -> Task | None:
    """Apply a single kanban drag: place `task_id` in the `status` column,
    between `before_id` and `after_id`. Both a same-column reorder and a
    cross-column move go through here — status is updated first (only when it
    actually changes, to skip a needless cascade) so the column membership the
    rank is computed against is already correct."""
    task = Task.objects.filter(id=task_id, project__workspace=workspace).first()
    if task is None:
        return None
    if task.status != status:
        update_task(workspace=workspace, task_id=task_id, status=status)
    return reorder_task(
        workspace=workspace,
        task_id=task_id,
        dimension="status",
        group_key=status,
        before_id=before_id,
        after_id=after_id,
    )


def delete_task(*, workspace, task_id: int) -> bool:
    deleted, _ = Task.objects.filter(id=task_id, project__workspace=workspace).delete()
    return deleted > 0


def move_task(*, workspace, task_id: int, new_start: date) -> tuple[Task | None, set[int]]:
    """Slide a task by setting a new start date; preserves duration."""
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__workspace=workspace
        )
    except Task.DoesNotExist:
        return None, set()
    duration = t.end - t.start
    t.start = new_start
    t.end = new_start + duration
    t.save(update_fields=["start", "end"])
    cascaded = cascade_workspace(workspace)
    return t, cascaded


def move_many_tasks(
    *, workspace, task_ids: list[int], delta_days: int
) -> tuple[list[Task], set[int]]:
    """Shift every task in `task_ids` by `delta_days` (preserves duration);
    runs auto_cascade once at the end so successor pushes happen as a batch."""
    delta = timedelta(days=delta_days)
    tasks = list(
        Task.objects.filter(id__in=task_ids, project__workspace=workspace)
    )
    for t in tasks:
        t.start = t.start + delta
        t.end = t.end + delta
    if tasks:
        Task.objects.bulk_update(tasks, ["start", "end"])
    cascaded = cascade_workspace(workspace)
    return tasks, cascaded


def resize_end(*, workspace, task_id: int, new_end: date) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__workspace=workspace
        )
    except Task.DoesNotExist:
        return None, set()
    t.end = max(new_end, t.start)
    t.save(update_fields=["end"])
    cascaded = cascade_workspace(workspace)
    return t, cascaded


def resize_start(*, workspace, task_id: int, new_start: date) -> tuple[Task | None, set[int]]:
    try:
        t = Task.objects.select_related("project").get(
            id=task_id, project__workspace=workspace
        )
    except Task.DoesNotExist:
        return None, set()
    t.start = min(new_start, t.end)
    t.save(update_fields=["start"])
    cascaded = cascade_workspace(workspace)
    return t, cascaded
