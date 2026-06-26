"""Dependency creation (with cycle prevention) and deletion."""

from django.utils.translation import gettext as _

from actions.activity import created_changes, deleted_changes, log_activity
from data.models import Dependency, Task
from actions.auto_cascade import cascade_workspace


def _would_cycle(workspace, predecessor_id: int, successor_id: int) -> bool:
    """True if predecessor -> successor would create a cycle in the DAG."""
    if predecessor_id == successor_id:
        return True
    edges = list(
        Dependency.objects.filter(predecessor__project__workspace=workspace).values_list(
            "predecessor_id", "successor_id"
        )
    )
    succ_of: dict[int, list[int]] = {}
    for p, s in edges:
        succ_of.setdefault(p, []).append(s)
    seen, stack = set(), [successor_id]
    while stack:
        n = stack.pop()
        if n == predecessor_id:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack.extend(succ_of.get(n, []))
    return False


def _dependency_values(dep: Dependency) -> dict:
    return {
        "predecessor": dep.predecessor.title,
        "successor": dep.successor.title,
    }


def _dependency_label(dep: Dependency) -> str:
    return f"{dep.predecessor.title} → {dep.successor.title}"


def add_dependency(
    *, workspace, predecessor_id: int, successor_id: int, actor=None
) -> tuple[Dependency | None, set[int], str | None]:
    """Add an FS dependency. Returns (dep, cascaded_task_ids, error_message)."""
    if predecessor_id == successor_id:
        return None, set(), _("A task cannot depend on itself.")
    pred_ok = Task.objects.filter(id=predecessor_id, project__workspace=workspace).exists()
    succ_ok = Task.objects.filter(id=successor_id, project__workspace=workspace).exists()
    if not (pred_ok and succ_ok):
        return None, set(), _("Task not found.")
    if Dependency.objects.filter(
        predecessor_id=predecessor_id, successor_id=successor_id
    ).exists():
        return None, set(), _("That dependency already exists.")
    if _would_cycle(workspace, predecessor_id, successor_id):
        return None, set(), _("That dependency would create a cycle.")
    dep = Dependency.objects.select_related("predecessor", "successor").create(
        predecessor_id=predecessor_id, successor_id=successor_id
    )
    dep = Dependency.objects.select_related("predecessor", "successor").get(id=dep.id)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="dependency.created",
        entity=dep,
        entity_type="dependency",
        entity_label=_dependency_label(dep),
        changes=created_changes(_dependency_values(dep)),
    )
    cascaded = cascade_workspace(workspace)
    return dep, cascaded, None


def delete_dependency(
    *, workspace, predecessor_id: int, successor_id: int, actor=None
) -> bool:
    dep = Dependency.objects.filter(
        predecessor_id=predecessor_id,
        successor_id=successor_id,
        predecessor__project__workspace=workspace,
    ).select_related("predecessor", "successor").first()
    if dep is None:
        return False
    values = _dependency_values(dep)
    label = _dependency_label(dep)
    entity_id = dep.id
    dep.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="dependency.deleted",
        entity_type="dependency",
        entity_id=entity_id,
        entity_label=label,
        changes=deleted_changes(values),
    )
    return True
