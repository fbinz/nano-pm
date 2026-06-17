"""View-model for rendering the Gantt chart.

Pre-computes all pixel geometry so templates can stay dumb (just iterate +
output absolute-positioned divs).
"""

from datetime import date, timedelta
from dataclasses import dataclass, field

from django.utils.translation import gettext as _

from data.models import TaskStatus, status_for_dates
from readers.chart import ChartState


ZOOM_PX_PER_DAY = {"day": 36, "week": 12, "month": 3, "quarter": 1}
DEFAULT_ZOOM = "week"

# Slider range for the per-unit density slider, expressed in px/day (server's
# canonical unit). Defaults from ZOOM_PX_PER_DAY sit inside each range. Picked
# to span ~0.5×–2× the default — enough to noticeably re-pace the chart
# without making bars unrenderably thin or absurdly wide.
ZOOM_PPD_RANGE = {
    "day": (18, 72),
    "week": (6, 24),
    "month": (1, 6),
    "quarter": (1, 3),
}
# Days-per-unit conversion so the slider can present its value in "px per
# whatever the active unit is" (e.g. px/week at week zoom). Month/quarter
# use 30/90 as nominal day counts for that label only — chart geometry is
# always driven by the underlying px/day.
ZOOM_DAYS_PER_UNIT = {"day": 1, "week": 7, "month": 30, "quarter": 90}

MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


@dataclass
class BarVM:
    id: int
    project_id: int
    title: str
    x: float
    w: float
    color: str
    text_color: str          # contrast-paired with `color`
    text_dark: bool          # true ⇒ dark-on-light bar (drop the white text-shadow)
    status: str
    overdue: bool
    is_done: bool
    start_iso: str
    end_iso: str
    assignees: str  # comma-joined first names for the left column


@dataclass
class MilestoneVM:
    id: int
    project_id: int
    title: str
    date_iso: str
    x: float
    color: str
    overdue: bool


@dataclass
class ProjectRowVM:
    id: int
    name: str
    color: str
    order: float
    tasks: list[BarVM]
    milestones: list[MilestoneVM]
    # When True the template skips this project's task rows. Milestones on the
    # project's header row keep rendering — they live on the header line, not
    # the per-task rows.
    collapsed: bool = False
    # True when the project is marked complete (only ever present in row_groups
    # when the show-completed filter is on; rendered dimmed with a badge).
    completed: bool = False
    teams: list[str] = field(default_factory=list)


@dataclass
class AxisTick:
    x: float
    w: float
    label: str
    weekend: bool = False


@dataclass
class DepArrowVM:
    from_id: int
    to_id: int
    d: str  # SVG path


@dataclass
class ChartVM:
    zoom: str
    px_per_day: int
    chart_width: float
    today_x: float
    chart_start_iso: str
    chart_end_iso: str
    axis_majors: list[AxisTick]
    axis_minors: list[AxisTick]
    weekend_tiles: list[AxisTick]
    row_groups: list[ProjectRowVM]
    deps: list[DepArrowVM]
    show_today_line: bool
    all_collapsed: bool
    show_completed: bool = False
    # Layout constants (kept here so the template doesn't have to know)
    left_w: int = 240
    axis_h: int = 48
    row_h: int = 32
    proj_row_h: int = 36
    bar_h: int = 24


def _start_of_week(d: date) -> date:
    return d - timedelta(days=(d.weekday()))  # Mon = 0


def _start_of_quarter(d: date) -> date:
    q = (d.month - 1) // 3
    return date(d.year, q * 3 + 1, 1)


def _text_color_for(bg_hex: str) -> tuple[str, bool]:
    """Return (text_color_hex, is_dark) suitable for legible bar labels on `bg_hex`.

    Uses WCAG relative-luminance and picks dark-on-light for the lighter project
    colors (amber, lime). Threshold tuned so blues, violets, pinks, reds keep
    the conventional white text.
    """
    h = bg_hex.lstrip('#')
    if len(h) != 6:
        return '#ffffff', False
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)

    def lin(c: int) -> float:
        v = c / 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

    L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    # Threshold tuned by hand against the default palette: amber (#f59e0b ≈ 0.44)
    # and lime (#84cc16 ≈ 0.48) get dark text; everything darker keeps white.
    if L > 0.40:
        return '#1a1a1a', True
    return '#ffffff', False


def _add_months(d: date, n: int) -> date:
    y, m = d.year, d.month + n
    while m > 12:
        m -= 12
        y += 1
    while m < 1:
        m += 12
        y -= 1
    return date(y, m, 1)


@dataclass
class _GridContext:
    zoom: str
    ppd: int
    chart_width: float
    today_x: float
    show_today: bool
    axis_majors: list[AxisTick]
    axis_minors: list[AxisTick]
    weekend_tiles: list[AxisTick]

    def x_of(self, d: date, chart_start: date) -> float:
        return (d - chart_start).days * self.ppd


def _build_grid_context(state: ChartState, zoom: str, ppd: int) -> _GridContext:
    if zoom not in ZOOM_PX_PER_DAY:
        zoom = DEFAULT_ZOOM

    def x_of(d: date) -> float:
        return (d - state.chart_start).days * ppd

    chart_width = (state.chart_end - state.chart_start).days * ppd
    today_x = x_of(state.today)
    show_today = 0 <= today_x <= chart_width

    axis_majors: list[AxisTick] = []
    axis_minors: list[AxisTick] = []

    if zoom in ("day", "week"):
        d = state.chart_start.replace(day=1)
        while d <= state.chart_end:
            nxt = _add_months(d, 1)
            x1 = max(0, x_of(d))
            x2 = min(chart_width, x_of(nxt))
            axis_majors.append(AxisTick(
                x=x1, w=x2 - x1,
                label=f"{MONTH_NAMES[d.month - 1]} {d.year}",
            ))
            d = nxt
    elif zoom == "month":
        d = _start_of_quarter(state.chart_start)
        while d <= state.chart_end:
            nxt = _add_months(d, 3)
            x1, x2 = x_of(d), x_of(nxt)
            q = (d.month - 1) // 3 + 1
            axis_majors.append(AxisTick(x=x1, w=x2 - x1, label=f"Q{q} {d.year}"))
            d = nxt
    else:  # quarter
        d = date(state.chart_start.year, 1, 1)
        while d <= state.chart_end:
            nxt = date(d.year + 1, 1, 1)
            axis_majors.append(AxisTick(x=x_of(d), w=x_of(nxt) - x_of(d), label=str(d.year)))
            d = nxt

    if zoom == "day":
        d = state.chart_start
        while d < state.chart_end:
            label = f"{['M','T','W','T','F','S','S'][d.weekday()]} {d.day}"
            axis_minors.append(AxisTick(
                x=x_of(d), w=ppd, label=label,
                weekend=d.weekday() >= 5,
            ))
            d += timedelta(days=1)
    elif zoom == "week":
        d = _start_of_week(state.chart_start)
        while d < state.chart_end:
            nxt = d + timedelta(days=7)
            axis_minors.append(AxisTick(
                x=x_of(d), w=ppd * 7,
                label=f"{MONTH_NAMES[d.month - 1]} {d.day}",
            ))
            d = nxt
    elif zoom == "month":
        d = state.chart_start.replace(day=1)
        while d < state.chart_end:
            nxt = _add_months(d, 1)
            axis_minors.append(AxisTick(
                x=x_of(d), w=x_of(nxt) - x_of(d),
                label=MONTH_NAMES[d.month - 1],
            ))
            d = nxt
    else:  # quarter
        d = _start_of_quarter(state.chart_start)
        while d < state.chart_end:
            nxt = _add_months(d, 3)
            q = (d.month - 1) // 3 + 1
            axis_minors.append(AxisTick(x=x_of(d), w=x_of(nxt) - x_of(d), label=f"Q{q}"))
            d = nxt

    weekend_tiles: list[AxisTick] = []
    if zoom in ("day", "week"):
        d = _start_of_week(state.chart_start)
        while d < state.chart_end:
            for off in (5, 6):
                wd = d + timedelta(days=off)
                if state.chart_start <= wd < state.chart_end:
                    weekend_tiles.append(AxisTick(x=x_of(wd), w=ppd, label=""))
            d += timedelta(days=7)

    return _GridContext(
        zoom=zoom, ppd=ppd, chart_width=chart_width, today_x=today_x,
        show_today=show_today, axis_majors=axis_majors, axis_minors=axis_minors,
        weekend_tiles=weekend_tiles,
    )


def _person_matches_team_filter(person, team_ids: set[int]) -> bool:
    return any(team.id in team_ids for team in person.teams.all())


def _task_matches_team_filter(task, team_ids: set[int]) -> bool:
    return any(
        _person_matches_team_filter(person, team_ids)
        for person in task.assignees.all()
    )


def build_chart_vm(
    state: ChartState,
    zoom: str = DEFAULT_ZOOM,
    px_per_day: int | None = None,
    collapsed_project_ids: set[int] | None = None,
    show_completed: bool = False,
    is_pm: bool = False,
    team_filter: set[int] | None = None,
) -> ChartVM:
    if zoom not in ZOOM_PX_PER_DAY:
        zoom = DEFAULT_ZOOM
    ppd = px_per_day if px_per_day is not None else ZOOM_PX_PER_DAY[zoom]
    collapsed_ids = collapsed_project_ids or set()
    team_ids = team_filter or set()
    g = _build_grid_context(state, zoom, ppd)

    def x_of(d: date) -> float:
        return (d - state.chart_start).days * ppd

    # Row groups, with bars and milestones
    row_groups: list[ProjectRowVM] = []
    for proj in state.projects:
        # Completed projects are hidden unless the show-completed filter is on.
        if proj.is_completed and not show_completed:
            continue
        bars: list[BarVM] = []
        text_color, text_dark = _text_color_for(proj.color)
        for t in proj.tasks.all():
            if team_ids and not _task_matches_team_filter(t, team_ids):
                continue
            x = x_of(t.start)
            xe = x_of(t.end + timedelta(days=1))
            assignees = ", ".join(p.name.split(" ")[0] for p in t.assignees.all())
            status = status_for_dates(t.start, t.end, state.today)
            bars.append(BarVM(
                id=t.id,
                project_id=proj.id,
                title=t.title,
                x=x, w=max(2.0, xe - x),
                color=proj.color,
                text_color=text_color,
                text_dark=text_dark,
                status=status,
                overdue=False,
                is_done=(status == TaskStatus.DONE),
                start_iso=t.start.isoformat(),
                end_iso=t.end.isoformat(),
                assignees=assignees,
            ))
        miles: list[MilestoneVM] = []
        for m in proj.milestones.all():
            miles.append(MilestoneVM(
                id=m.id,
                project_id=proj.id,
                title=m.title,
                date_iso=m.date.isoformat(),
                x=x_of(m.date),
                color=proj.color,
                overdue=(m.date < state.today),
            ))
        if team_ids and not bars:
            continue
        row_groups.append(ProjectRowVM(
            id=proj.id, name=proj.name, color=proj.color, order=proj.order,
            tasks=bars, milestones=miles,
            collapsed=(proj.id in collapsed_ids),
            completed=proj.is_completed,
        ))

    # Dep arrows — orthogonal route through a small stub between rows.
    deps: list[DepArrowVM] = []
    bar_lookup: dict[int, tuple[BarVM, int]] = {}  # task_id → (BarVM, project_index)
    bar_y_centers: dict[int, float] = {}

    # Compute y-centers in the chart-area coordinate system (excluding axis).
    # Each project row group: 1 project header (proj_row_h) + N task rows (row_h each).
    # Collapsed projects contribute their header row but no task rows.
    # Project view always shows an "Add Project" spacer row above the first
    # project (chart.html); shift everything below it down by one row_h so dep
    # arrows still terminate on the correct bars.
    y = 32.0
    for rg_idx, rg in enumerate(row_groups):
        # project header row first
        y += 36  # proj_row_h
        if rg.collapsed:
            continue
        for bar in rg.tasks:
            bar_y_centers[bar.id] = y + 16  # ~half of row_h
            bar_lookup[bar.id] = (bar, rg_idx)
            y += 32  # row_h
    for dep in state.deps:
        a = bar_lookup.get(dep.predecessor_id)
        b = bar_lookup.get(dep.successor_id)
        if not a or not b:
            # Endpoint(s) inside a collapsed project — skip the arrow entirely.
            continue
        a_bar, _ = a
        b_bar, _ = b
        ax2 = a_bar.x + a_bar.w
        ay = bar_y_centers[a_bar.id]
        bx1 = b_bar.x
        by = bar_y_centers[b_bar.id]
        stub = 8
        if ax2 + stub <= bx1:
            d = f"M {ax2} {ay} L {ax2 + stub} {ay} L {ax2 + stub} {by} L {bx1} {by}"
        else:
            dy = 14 if by > ay else -14
            d = (
                f"M {ax2} {ay} L {ax2 + stub} {ay} L {ax2 + stub} {ay + dy} "
                f"L {bx1 - stub} {ay + dy} L {bx1 - stub} {by} L {bx1} {by}"
            )
        deps.append(DepArrowVM(
            from_id=dep.predecessor_id, to_id=dep.successor_id, d=d,
        ))

    return ChartVM(
        zoom=zoom,
        px_per_day=ppd,
        chart_width=g.chart_width,
        today_x=g.today_x,
        chart_start_iso=state.chart_start.isoformat(),
        chart_end_iso=state.chart_end.isoformat(),
        axis_majors=g.axis_majors,
        axis_minors=g.axis_minors,
        weekend_tiles=g.weekend_tiles,
        row_groups=row_groups,
        deps=deps,
        show_today_line=g.show_today,
        all_collapsed=bool(row_groups) and all(rg.collapsed for rg in row_groups),
        show_completed=show_completed,
    )


def build_resource_vm(
    state: ChartState,
    zoom: str = DEFAULT_ZOOM,
    px_per_day: int | None = None,
    collapsed_person_ids: set[int] | None = None,
    status_filter: set[str] | None = None,
    team_filter: set[int] | None = None,
) -> ChartVM:
    if zoom not in ZOOM_PX_PER_DAY:
        zoom = DEFAULT_ZOOM
    ppd = px_per_day if px_per_day is not None else ZOOM_PX_PER_DAY[zoom]
    collapsed_ids = collapsed_person_ids or set()
    team_ids = team_filter or set()
    g = _build_grid_context(state, zoom, ppd)

    def x_of(d: date) -> float:
        return (d - state.chart_start).days * ppd

    # Group bars by person (duplicate for multi-assignee tasks)
    person_bars: dict[int | None, list[BarVM]] = {}
    for person in state.people:
        person_bars[person.id] = []
    person_bars[None] = []  # unassigned

    for proj in state.projects:
        text_color, text_dark = _text_color_for(proj.color)
        for t in proj.tasks.all():
            status = status_for_dates(t.start, t.end, state.today)
            if status_filter is not None and status not in status_filter:
                continue
            assignee_list = list(t.assignees.all())
            bar = BarVM(
                id=t.id,
                project_id=proj.id,
                title=t.title,
                x=x_of(t.start), w=max(2.0, x_of(t.end + timedelta(days=1)) - x_of(t.start)),
                color=proj.color,
                text_color=text_color,
                text_dark=text_dark,
                status=status,
                overdue=False,
                is_done=(status == TaskStatus.DONE),
                start_iso=t.start.isoformat(),
                end_iso=t.end.isoformat(),
                assignees=", ".join(p.name.split(" ")[0] for p in assignee_list),
            )
            if not assignee_list:
                person_bars[None].append(bar)
            else:
                for p in assignee_list:
                    person_bars.setdefault(p.id, []).append(bar)

    row_groups: list[ProjectRowVM] = []
    for person in sorted(state.people, key=lambda p: p.name):
        if team_ids and not _person_matches_team_filter(person, team_ids):
            continue
        row_groups.append(ProjectRowVM(
            id=person.id, name=person.name, color="#6b7280", order=len(row_groups),
            tasks=person_bars.get(person.id, []), milestones=[],
            collapsed=(person.id in collapsed_ids),
            teams=[team.name for team in person.teams.all()],
        ))
    # Unassigned group at the end, unless a team filter is active.
    if not team_ids:
        row_groups.append(ProjectRowVM(
            id=0, name=_("Unassigned"), color="#9ca3af", order=len(row_groups),
            tasks=person_bars.get(None, []), milestones=[],
            collapsed=(0 in collapsed_ids),
        ))

    return ChartVM(
        zoom=zoom,
        px_per_day=ppd,
        chart_width=g.chart_width,
        today_x=g.today_x,
        chart_start_iso=state.chart_start.isoformat(),
        chart_end_iso=state.chart_end.isoformat(),
        axis_majors=g.axis_majors,
        axis_minors=g.axis_minors,
        weekend_tiles=g.weekend_tiles,
        row_groups=row_groups,
        deps=[],
        show_today_line=g.show_today,
        all_collapsed=bool(row_groups) and all(rg.collapsed for rg in row_groups),
    )
