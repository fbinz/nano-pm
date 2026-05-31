"""Write operations for projects."""

from django.utils import timezone

from data.models import Project
from data.models.project import PROJECT_COLORS


def create_project(
    *,
    workspace,
    name: str = "New project",
    color: str | None = None,
    position: str = "end",
) -> Project:
    orders = list(
        Project.objects.filter(workspace=workspace)
        .order_by("order").values_list("order", flat=True)
    )
    if not orders:
        next_order = 1.0
    elif position == "start":
        next_order = orders[0] - 1.0
    else:
        next_order = orders[-1] + 1.0
    if color is None:
        color = PROJECT_COLORS[len(orders) % len(PROJECT_COLORS)]
    return Project.objects.create(workspace=workspace, name=name, color=color, order=next_order)


def update_project(
    *,
    workspace,
    project_id: int,
    name: str | None = None,
    color: str | None = None,
) -> Project | None:
    try:
        proj = Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None
    if name is not None:
        proj.name = name
    if color is not None:
        proj.color = color
    proj.save()
    return proj


def move_project(*, workspace, project_id: int, direction: int) -> Project | None:
    """Swap order with the immediate neighbour (direction = -1 up, +1 down)."""
    try:
        proj = Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None
    qs = Project.objects.filter(workspace=workspace).order_by("order", "id")
    ordered = list(qs)
    idx = next((i for i, p in enumerate(ordered) if p.id == proj.id), -1)
    nidx = idx + direction
    if idx < 0 or nidx < 0 or nidx >= len(ordered):
        return proj
    a, b = ordered[idx], ordered[nidx]
    a.order, b.order = b.order, a.order
    Project.objects.bulk_update([a, b], fields=["order"])
    return proj


def set_project_completed(*, workspace, project_id: int, completed: bool) -> Project | None:
    """Mark a project complete (stamp `completed_at`) or reopen it (clear it)."""
    try:
        proj = Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None
    proj.completed_at = timezone.now() if completed else None
    proj.save(update_fields=["completed_at", "updated_at"])
    return proj


def delete_project(*, workspace, project_id: int) -> bool:
    deleted, _ = Project.objects.filter(id=project_id, workspace=workspace).delete()
    return deleted > 0
