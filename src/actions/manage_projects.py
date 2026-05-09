"""Write operations for projects."""

from data.models import Project
from data.models.project import PROJECT_COLORS


def create_project(*, owner, name: str = "New project", color: str | None = None) -> Project:
    existing = list(Project.objects.filter(owner=owner).order_by("-order").values_list("order", flat=True))
    next_order = (existing[0] + 1.0) if existing else 1.0
    if color is None:
        color = PROJECT_COLORS[len(existing) % len(PROJECT_COLORS)]
    return Project.objects.create(owner=owner, name=name, color=color, order=next_order)


def update_project(
    *,
    owner,
    project_id: int,
    name: str | None = None,
    color: str | None = None,
) -> Project | None:
    try:
        proj = Project.objects.get(id=project_id, owner=owner)
    except Project.DoesNotExist:
        return None
    if name is not None:
        proj.name = name
    if color is not None:
        proj.color = color
    proj.save()
    return proj


def move_project(*, owner, project_id: int, direction: int) -> Project | None:
    """Swap order with the immediate neighbour (direction = -1 up, +1 down)."""
    try:
        proj = Project.objects.get(id=project_id, owner=owner)
    except Project.DoesNotExist:
        return None
    qs = Project.objects.filter(owner=owner).order_by("order", "id")
    ordered = list(qs)
    idx = next((i for i, p in enumerate(ordered) if p.id == proj.id), -1)
    nidx = idx + direction
    if idx < 0 or nidx < 0 or nidx >= len(ordered):
        return proj
    a, b = ordered[idx], ordered[nidx]
    a.order, b.order = b.order, a.order
    Project.objects.bulk_update([a, b], fields=["order"])
    return proj


def delete_project(*, owner, project_id: int) -> bool:
    deleted, _ = Project.objects.filter(id=project_id, owner=owner).delete()
    return deleted > 0
