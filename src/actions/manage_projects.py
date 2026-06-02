"""Write operations for projects."""

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from data.models import Dependency, Membership, Person, Project, WorkspaceRole
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


def move_project_to_workspace(
    *,
    user,
    workspace,
    project_id: int,
    target_workspace_id: int,
) -> Project | None:
    """Move a project and its children to another workspace.

    Only PMs in both source and target workspaces may move projects. Tasks and
    milestones follow the project. Dependencies wholly inside the moved project
    are preserved; dependencies crossing the project boundary are removed so no
    cross-workspace dependency remains. Task assignees are remapped by linked
    user where possible and otherwise cleared.
    """
    source_pm = Membership.objects.filter(
        user=user, workspace=workspace, role=WorkspaceRole.PM
    ).exists()
    target_membership = Membership.objects.filter(
        user=user, workspace_id=target_workspace_id, role=WorkspaceRole.PM
    ).select_related("workspace").first()
    if not source_pm or target_membership is None or target_membership.workspace_id == workspace.id:
        return None

    with transaction.atomic():
        try:
            proj = Project.objects.select_for_update().get(id=project_id, workspace=workspace)
        except Project.DoesNotExist:
            return None

        task_ids = set(proj.tasks.values_list("id", flat=True))
        assignees_by_task = {
            task.id: list(task.assignees.filter(user__isnull=False).values_list("user_id", flat=True))
            for task in proj.tasks.prefetch_related("assignees")
        }
        target_people_by_user = {
            p.user_id: p
            for p in Person.objects.filter(
                workspace_id=target_workspace_id,
                user_id__in={uid for uids in assignees_by_task.values() for uid in uids},
            )
        }

        if task_ids:
            Dependency.objects.filter(
                Q(predecessor_id__in=task_ids) | Q(successor_id__in=task_ids)
            ).exclude(
                predecessor_id__in=task_ids,
                successor_id__in=task_ids,
            ).delete()

        last_order = (
            Project.objects.filter(workspace_id=target_workspace_id)
            .order_by("-order")
            .values_list("order", flat=True)
            .first()
        )
        proj.workspace = target_membership.workspace
        proj.order = (last_order or 0) + 1.0
        proj.save(update_fields=["workspace", "order", "updated_at"])

        for task in proj.tasks.all():
            remapped = [target_people_by_user[uid] for uid in assignees_by_task.get(task.id, []) if uid in target_people_by_user]
            task.assignees.set(remapped)

        return proj


def delete_project(*, workspace, project_id: int) -> bool:
    deleted, _ = Project.objects.filter(id=project_id, workspace=workspace).delete()
    return deleted > 0
