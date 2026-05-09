"""Read-side queries for the Gantt chart, all scoped to a single user."""

from datetime import date, timedelta
from dataclasses import dataclass, field

from django.db.models import Prefetch

from data.models import Project, Person, Task, Milestone, Dependency


@dataclass
class ChartState:
    """Materialised chart state for one user — what the renderer needs."""

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


def get_chart_state(user) -> ChartState:
    """Load everything needed to render the chart for the given user."""
    today = date.today()

    projects = list(
        Project.objects.filter(owner=user)
        .order_by("order", "id")
        .prefetch_related(
            Prefetch(
                "tasks",
                queryset=Task.objects.order_by("start", "id").prefetch_related("assignees"),
            ),
            Prefetch(
                "milestones",
                queryset=Milestone.objects.order_by("date", "id"),
            ),
        )
    )
    people = list(Person.objects.filter(owner=user))

    # Restrict deps to those whose endpoints are owned by this user. Both ends
    # share a project owner, so a single owner filter on either side is enough.
    deps = list(
        Dependency.objects.filter(predecessor__project__owner=user).select_related(
            "predecessor", "successor"
        )
    )

    # Compute chart range: earliest of (today - 30d, earliest data - 7d) to
    # latest of (today + 150d, latest data + 14d), rounded to month boundaries.
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


def get_task(user, task_id: int) -> Task | None:
    try:
        return (
            Task.objects.select_related("project")
            .prefetch_related("assignees")
            .get(id=task_id, project__owner=user)
        )
    except Task.DoesNotExist:
        return None


def get_project(user, project_id: int) -> Project | None:
    try:
        return Project.objects.get(id=project_id, owner=user)
    except Project.DoesNotExist:
        return None


def get_milestone(user, milestone_id: int) -> Milestone | None:
    try:
        return Milestone.objects.select_related("project").get(
            id=milestone_id, project__owner=user
        )
    except Milestone.DoesNotExist:
        return None


def get_person(user, person_id: int) -> Person | None:
    try:
        return Person.objects.get(id=person_id, owner=user)
    except Person.DoesNotExist:
        return None
