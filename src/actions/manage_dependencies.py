"""Dependency creation (with cycle prevention) and deletion."""

from django.utils.translation import gettext as _

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


def add_dependency(
    *, workspace, predecessor_id: int, successor_id: int
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
    dep = Dependency.objects.create(
        predecessor_id=predecessor_id, successor_id=successor_id
    )
    cascaded = cascade_workspace(workspace)
    return dep, cascaded, None


def delete_dependency(
    *, workspace, predecessor_id: int, successor_id: int
) -> bool:
    deleted, _ = Dependency.objects.filter(
        predecessor_id=predecessor_id,
        successor_id=successor_id,
        predecessor__project__workspace=workspace,
    ).delete()
    return deleted > 0
