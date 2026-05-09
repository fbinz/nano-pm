"""Auto-cascade: forward-only, slack-preserved.

Whenever a task moves later, every transitive successor that would now overlap
its predecessor's end+1 is shifted forward by exactly the violation, preserving
any slack the user already arranged. Pulling a task earlier or shrinking it
never violates an FS dep, so we don't need to do anything in those cases.
"""

from datetime import timedelta

from data.models import Dependency, Task


def cascade_user(user) -> set[int]:
    """Apply auto-cascade across every task owned by ``user``.

    Returns the set of task ids whose dates were shifted, so the caller can
    re-render only the affected bars.
    """
    tasks = {t.id: t for t in Task.objects.filter(project__owner=user)}
    deps = list(
        Dependency.objects.filter(predecessor__project__owner=user).values_list(
            "predecessor_id", "successor_id"
        )
    )
    preds: dict[int, list[int]] = {}
    for p, s in deps:
        preds.setdefault(s, []).append(p)

    changed: set[int] = set()
    # Iterate to a fixed point. Each shift is monotonic (we only move tasks
    # later), and in a DAG this terminates. The safety counter guards us from
    # accidental cycles in malformed data.
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
                min_start = p.end + timedelta(days=1)
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
