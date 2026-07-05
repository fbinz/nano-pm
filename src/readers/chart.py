"""Full chart state loading for one workspace."""

from datetime import date, timedelta
from dataclasses import dataclass, field

from django.db.models import Prefetch

from data.models import Project, Person, Task, Milestone, Dependency


@dataclass
class ChartState:
    """Materialised chart state for one workspace — what the renderer needs."""

    projects: list[Project]
    people: list[Person]
    deps: list[Dependency]
    today: date
    chart_start: date
    chart_end: date

    # Derived view conveniences:
    tasks_by_id: dict[int, Task] = field(default_factory=dict)


def _start_of_month(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    y, m = d.year, d.month + n
    while m > 12:
        m -= 12
        y += 1
    while m < 1:
        m += 12
        y -= 1
    return date(y, m, 1)


def get_chart_state(workspace) -> ChartState:
    """Load everything needed to render the chart for the given workspace."""
    today = date.today()

    projects = list(
        Project.objects.filter(workspace=workspace)
        .order_by("order", "id")
        .prefetch_related(
            Prefetch(
                "tasks",
                queryset=Task.objects.order_by("start", "id").prefetch_related("assignees__teams"),
            ),
            Prefetch(
                "milestones",
                queryset=Milestone.objects.select_related("task").order_by("date", "id"),
            ),
        )
    )
    people = list(Person.objects.filter(workspace=workspace).prefetch_related("teams"))

    deps = list(
        Dependency.objects.filter(predecessor__project__workspace=workspace).select_related(
            "predecessor", "successor"
        )
    )

    earliest = today - timedelta(days=30)
    latest = today + timedelta(days=150)
    for proj in projects:
        for t in proj.tasks.all():
            if t.start < earliest:
                earliest = t.start
            if t.end > latest:
                latest = t.end
        for m in proj.milestones.all():
            if m.date < earliest:
                earliest = m.date
            if m.date > latest:
                latest = m.date
    chart_start = _start_of_month(earliest - timedelta(days=7))
    chart_end = _add_months(_start_of_month(latest), 1) + timedelta(days=14)
    chart_end = _start_of_month(chart_end)

    tasks_by_id = {t.id: t for proj in projects for t in proj.tasks.all()}

    return ChartState(
        projects=projects,
        people=people,
        deps=deps,
        today=today,
        chart_start=chart_start,
        chart_end=chart_end,
        tasks_by_id=tasks_by_id,
    )
