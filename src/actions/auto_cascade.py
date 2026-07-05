"""Auto-cascade: forward-only, slack-preserved.

Whenever a task moves later, every transitive successor that would now overlap
its predecessor's exclusive end is shifted forward by exactly the violation,
preserving any slack the user already arranged. Pulling a task earlier or
shrinking it never violates an FS dep, so we don't need to do anything in those
cases.
"""

from data.models import Dependency, Task


def cascade_workspace(workspace) -> set[int]:
    """Apply auto-cascade across every task in ``workspace``.

    Returns the set of task ids whose dates were shifted, so the caller can
    re-render only the affected bars.
    """
    tasks = {t.id: t for t in Task.objects.filter(project__workspace=workspace)}
    deps = list(
        Dependency.objects.filter(predecessor__project__workspace=workspace).values_list(
            "predecessor_id", "successor_id"
        )
    )
    preds: dict[int, list[int]] = {}
    for p, s in deps:
        preds.setdefault(s, []).append(p)

    changed: set[int] = set()
    for _ in range(10_000):
        any_change = False
        for tid, t in tasks.items():
            ps = preds.get(tid)
            if not ps:
                continue
            earliest_start = t.start
            for pid in ps:
                p = tasks.get(pid)
                if p is None:
                    continue
                min_start = p.end
                if min_start > earliest_start:
                    earliest_start = min_start
            if earliest_start > t.start:
                delta = earliest_start - t.start
                t.start = t.start + delta
                t.end = t.end + delta
                changed.add(tid)
                any_change = True
        if not any_change:
            break

    if changed:
        Task.objects.bulk_update(
            [tasks[tid] for tid in changed], fields=["start", "end"]
        )
    return changed
