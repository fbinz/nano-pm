"""Full chart state loading for one workspace."""

from datetime import date, datetime, time, timedelta
from dataclasses import dataclass, field

from django.db.models import Max, Min, Prefetch
from django.utils import timezone

from data.models import Project, Person, Task, Milestone, Dependency, GitLabIssue


@dataclass
class ChartState:
    """Materialised chart state for one workspace — what the renderer needs."""

    projects: list[Project]
    people: list[Person]
    deps: list[Dependency]
    today: date
    today_fraction: float
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


def get_chart_state(workspace, *, project_id: int | None = None) -> ChartState:
    """Load a full chart, or one project with workspace-wide date bounds.

    Project-only renders do not need people or dependency rows: an unconnected
    task insertion leaves the existing arrows intact (the client reroutes them).
    """
    now = timezone.localtime()
    today = now.date()
    current_tz = timezone.get_current_timezone()
    day_start = datetime.combine(today, time.min, tzinfo=current_tz)
    next_day_start = datetime.combine(today + timedelta(days=1), time.min, tzinfo=current_tz)
    day_length = (next_day_start - day_start).total_seconds() or 86400
    today_fraction = max(0.0, min(1.0, (now - day_start).total_seconds() / day_length))

    project_query = Project.objects.filter(workspace=workspace)
    if project_id is not None:
        project_query = project_query.filter(pk=project_id)
    projects = list(
        project_query.order_by("order", "id")
        .prefetch_related(
            "responsible_people__teams",
            Prefetch("gitlab_issues", queryset=GitLabIssue.objects.filter(
                connection__workspace=workspace, retired=False,
            ).select_related("connection")),
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
    people = (
        list(Person.objects.filter(workspace=workspace).prefetch_related("teams"))
        if project_id is None else []
    )

    deps = (
        list(Dependency.objects.filter(predecessor__project__workspace=workspace).select_related(
            "predecessor", "successor"
        )) if project_id is None else []
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
    if project_id is not None:
        # Aggregate instead of materialising unrelated tasks/milestones. Include
        # hidden/completed projects, exactly as the full-chart reader does.
        task_bounds = Task.objects.filter(project__workspace=workspace).aggregate(
            start=Min("start"), end=Max("end"),
        )
        milestone_bounds = Milestone.objects.filter(project__workspace=workspace).aggregate(
            start=Min("date"), end=Max("date"),
        )
        earliest = min(earliest, task_bounds["start"] or earliest, milestone_bounds["start"] or earliest)
        latest = max(latest, task_bounds["end"] or latest, milestone_bounds["end"] or latest)
    chart_start = _start_of_month(earliest - timedelta(days=7))
    chart_end = _add_months(_start_of_month(latest), 1) + timedelta(days=14)
    chart_end = _start_of_month(chart_end)

    tasks_by_id = {t.id: t for proj in projects for t in proj.tasks.all()}

    return ChartState(
        projects=projects,
        people=people,
        deps=deps,
        today=today,
        today_fraction=today_fraction,
        chart_start=chart_start,
        chart_end=chart_end,
        tasks_by_id=tasks_by_id,
    )
