"""Write operations for projects."""

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from actions.teams_notifications import normalize_notify_events
from data.models import Dependency, Membership, Person, Project, WorkspaceRole
from data.models.project import PROJECT_COLORS


PROJECT_FIELDS = [
    "name", "description", "color", "order", "completed_at",
    "teams_webhook_url", "teams_notify_events",
]


def create_project(
    *,
    workspace,
    name: str = "New project",
    color: str | None = None,
    position: str = "end",
    actor=None,
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
    project = Project.objects.create(workspace=workspace, name=name, color=color, order=next_order)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="project.created",
        entity=project,
        changes=created_changes(snapshot(project, PROJECT_FIELDS)),
    )
    return project


def update_project(
    *,
    workspace,
    project_id: int,
    name: str | None = None,
    description: str | None = None,
    color: str | None = None,
    teams_webhook_url: str | None = None,
    teams_notify_events: list[str] | None = None,
    actor=None,
) -> Project | None:
    try:
        proj = Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None
    update_fields = ["name", "description", "color"]
    if teams_webhook_url is not None:
        update_fields.append("teams_webhook_url")
    if teams_notify_events is not None:
        update_fields.append("teams_notify_events")
    before = snapshot(proj, update_fields)
    if name is not None:
        proj.name = name
    if description is not None:
        proj.description = description
    if color is not None:
        proj.color = color
    if teams_webhook_url is not None:
        proj.teams_webhook_url = teams_webhook_url.strip()
    if teams_notify_events is not None:
        proj.teams_notify_events = normalize_notify_events(teams_notify_events)
    proj.save()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="project.updated",
        entity=proj,
        changes=change_set(before, snapshot(proj, update_fields)),
        skip_empty_changes=True,
    )
    return proj


def move_project(*, workspace, project_id: int, direction: int, actor=None) -> Project | None:
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
    before = {a.id: snapshot(a, ["order"]), b.id: snapshot(b, ["order"])}
    a.order, b.order = b.order, a.order
    Project.objects.bulk_update([a, b], fields=["order"])
    log_activity(
        workspace=workspace,
        actor=actor,
        action="project.moved",
        entity=proj,
        changes={str(p.id): change_set(before[p.id], snapshot(p, ["order"])) for p in (a, b)},
        metadata={"direction": direction, "swapped_with": b.id if a.id == proj.id else a.id},
    )
    return proj


def set_project_completed(
    *, workspace, project_id: int, completed: bool, actor=None
) -> Project | None:
    """Mark a project complete (stamp `completed_at`) or reopen it (clear it)."""
    try:
        proj = Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None
    before = snapshot(proj, ["completed_at"])
    proj.completed_at = timezone.now() if completed else None
    proj.save(update_fields=["completed_at", "updated_at"])
    log_activity(
        workspace=workspace,
        actor=actor,
        action="project.completed" if completed else "project.reopened",
        entity=proj,
        changes=change_set(before, snapshot(proj, ["completed_at"])),
        skip_empty_changes=True,
    )
    return proj


def move_project_to_workspace(
    *,
    user,
    workspace,
    project_id: int,
    target_workspace_id: int,
    actor=None,
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

        source_workspace = workspace
        source_workspace_id = workspace.id
        source_workspace_name = workspace.name
        target_workspace = target_membership.workspace
        label = proj.name
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
        proj.workspace = target_workspace
        proj.order = (last_order or 0) + 1.0
        proj.save(update_fields=["workspace", "order", "updated_at"])

        for task in proj.tasks.all():
            remapped = [
                target_people_by_user[uid]
                for uid in assignees_by_task.get(task.id, [])
                if uid in target_people_by_user
            ]
            task.assignees.set(remapped)

        changes = {
            "workspace": {"from": source_workspace_name, "to": target_workspace.name},
            "order": {"to": proj.order},
        }
        metadata = {"project_id": proj.id, "target_workspace_id": target_workspace_id}
        log_activity(
            workspace=source_workspace,
            actor=actor or user,
            action="project.moved",
            entity_type="project",
            entity_id=proj.id,
            entity_label=label,
            changes=changes,
            metadata=metadata,
        )
        log_activity(
            workspace=target_workspace,
            actor=actor or user,
            action="project.created",
            entity=proj,
            changes={"workspace": {"from": source_workspace_name, "to": target_workspace.name}},
            metadata={"source_workspace_id": source_workspace_id},
        )

        return proj


def delete_project(*, workspace, project_id: int, actor=None) -> bool:
    project = Project.objects.filter(id=project_id, workspace=workspace).first()
    if project is None:
        return False
    values = snapshot(project, PROJECT_FIELDS)
    label = project.name
    entity_id = project.id
    project.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="project.deleted",
        entity_type="project",
        entity_id=entity_id,
        entity_label=label,
        changes=deleted_changes(values),
    )
    return True
