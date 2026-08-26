"""Shared helpers for the Gantt chart views."""

from datetime import date
from functools import wraps
from inspect import iscoroutinefunction

from django.http import HttpRequest, HttpResponse

from datastar_py.django import ServerSentEventGenerator as SSE, read_signals
from django_cotton import render_component

from data.models import Membership, Person, TaskStatus, Team, WorkspaceRole
from readers import get_chart_state
from readers.chart_view import (
    build_chart_vm,
    build_resource_vm,
    DEFAULT_ZOOM,
    ZOOM_PX_PER_DAY,
    ZOOM_PPD_RANGE,
)


VALID_ZOOMS = set(ZOOM_PX_PER_DAY)
SIDEBAR_WIDTH_SESSION_KEY = "sidebar_width"
SIDEBAR_WIDTH_DEFAULT = 240
SIDEBAR_WIDTH_MIN = 140
SIDEBAR_WIDTH_MAX = 600


def clamp_sidebar_width(value: object) -> int | None:
    try:
        px = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return max(SIDEBAR_WIDTH_MIN, min(SIDEBAR_WIDTH_MAX, px))


def sidebar_width(request: HttpRequest) -> int:
    stored = clamp_sidebar_width(request.session.get(SIDEBAR_WIDTH_SESSION_KEY))
    return stored if stored is not None else SIDEBAR_WIDTH_DEFAULT


def set_sidebar_width(request: HttpRequest, value: object) -> int | None:
    px = clamp_sidebar_width(value)
    if px is None:
        return None
    request.session[SIDEBAR_WIDTH_SESSION_KEY] = px
    return px


def zoom(request: HttpRequest) -> str:
    z = request.GET.get("zoom")
    if z in VALID_ZOOMS:
        request.session["zoom"] = z
        return z
    sz = request.session.get("zoom")
    if sz in VALID_ZOOMS:
        return sz
    return DEFAULT_ZOOM


def ppd(request: HttpRequest, zoom: str) -> int:
    """Resolve px/day for `zoom`. ?ppd= wins (and is persisted per-zoom);
    falls back to a per-zoom session value, else the zoom's default."""
    lo, hi = ZOOM_PPD_RANGE[zoom]
    raw = request.GET.get("ppd")
    if raw is not None:
        try:
            v = int(round(float(raw)))
        except ValueError:
            v = None
        if v is not None:
            v = max(lo, min(hi, v))
            request.session[f"ppd_{zoom}"] = v
            return v
    sv = request.session.get(f"ppd_{zoom}")
    if isinstance(sv, int) and lo <= sv <= hi:
        return sv
    return ZOOM_PX_PER_DAY[zoom]


def collapsed_projects(request: HttpRequest) -> set[int]:
    """Read the per-session set of collapsed project IDs (UI-only state; no DB)."""
    raw = request.session.get("collapsed_projects", [])
    return {int(x) for x in raw if isinstance(x, (int, str)) and str(x).lstrip("-").isdigit()}


def set_collapsed_projects(request: HttpRequest, ids: set[int]) -> None:
    """Persist the collapsed project ID set into the session as a sorted list."""
    request.session["collapsed_projects"] = sorted(ids)


def show_completed(request: HttpRequest) -> bool:
    """Whether completed projects are revealed on the chart (default: hidden)."""
    return bool(request.session.get("show_completed", False))


def set_show_completed(request: HttpRequest, value: bool) -> None:
    request.session["show_completed"] = bool(value)


def collapsed_people(request: HttpRequest) -> set[int]:
    raw = request.session.get("collapsed_people", [])
    return {int(x) for x in raw if isinstance(x, (int, str)) and str(x).lstrip("-").isdigit()}


def set_collapsed_people(request: HttpRequest, ids: set[int]) -> None:
    request.session["collapsed_people"] = sorted(ids)


DEFAULT_STATUS_FILTER = {TaskStatus.PLANNED, TaskStatus.IN_PROGRESS}


def status_filter(request: HttpRequest) -> set[str]:
    raw = request.session.get("status_filter")
    if raw is None:
        return set(DEFAULT_STATUS_FILTER)
    valid = {c.value for c in TaskStatus}
    return {s for s in raw if s in valid}


def set_status_filter(request: HttpRequest, statuses: set[str]) -> None:
    request.session["status_filter"] = sorted(statuses)


def team_choices(request: HttpRequest):
    return Team.objects.filter(workspace=request.workspace).order_by("name", "id")


def team_filter(request: HttpRequest) -> set[int]:
    raw = request.session.get("team_filter", [])
    ids = {int(x) for x in raw if isinstance(x, (int, str)) and str(x).isdigit()}
    if not ids:
        return set()
    valid = set(Team.objects.filter(workspace=request.workspace, id__in=ids).values_list("id", flat=True))
    return ids & valid


def set_team_filter(request: HttpRequest, team_ids: set[int]) -> None:
    request.session["team_filter"] = sorted(team_ids)


def view_mode(request: HttpRequest) -> str:
    mode = request.session.get("view_mode", "project")
    return mode if mode in {"project", "resource"} else "project"


def is_pm(request: HttpRequest) -> bool:
    m = getattr(request, "membership", None)
    return m is not None and m.role == WorkspaceRole.PM


def pm_required(view_func):
    if iscoroutinefunction(view_func):
        @wraps(view_func)
        async def async_wrapper(request: HttpRequest, *args, **kwargs):
            if not is_pm(request):
                return HttpResponse(status=403)
            return await view_func(request, *args, **kwargs)

        return async_wrapper

    @wraps(view_func)
    def wrapper(request: HttpRequest, *args, **kwargs):
        if not is_pm(request):
            return HttpResponse(status=403)
        return view_func(request, *args, **kwargs)

    return wrapper


def workspace_context(request: HttpRequest) -> dict:
    workspaces = list(
        Membership.objects.filter(user=request.user)
        .select_related("workspace")
        .order_by("workspace__name")
    )
    return {
        "workspace": request.workspace,
        "workspaces": [m.workspace for m in workspaces],
        "has_multiple_workspaces": len(workspaces) > 1,
        "can_view_ideas": is_pm(request) or request.user.has_perm("data.view_idea"),
    }


def is_assigned(request: HttpRequest, task) -> bool:
    person = Person.objects.filter(
        workspace=request.workspace, user=request.user
    ).first()
    if person is None:
        return False
    return task.assignees.filter(id=person.id).exists()


def patch_chart(request: HttpRequest, active_zoom: str | None = None):
    """Yield an SSE patch that replaces the chart fragment with a fresh render."""
    state = get_chart_state(request.workspace)
    mode = view_mode(request)
    resolved_zoom = active_zoom or zoom(request)
    px_per_day = ppd(request, resolved_zoom)
    if mode == "resource":
        vm = build_resource_vm(state, resolved_zoom, px_per_day=px_per_day,
                               collapsed_person_ids=collapsed_people(request),
                               status_filter=status_filter(request),
                               team_filter=team_filter(request))
        template = "screens/gantt/chart_resource"
    else:
        vm = build_chart_vm(state, resolved_zoom, px_per_day=px_per_day,
                            collapsed_project_ids=collapsed_projects(request),
                            show_completed=show_completed(request),
                            is_pm=is_pm(request),
                            team_filter=team_filter(request))
        template = "screens/gantt/chart"
    return SSE.patch_elements(
        render_component(request, template, vm=vm, is_pm=is_pm(request))
    )


def request_data(request: HttpRequest) -> dict:
    """Return command payload data from Datastar JSON, falling back to form POST.

    Gesture commits use Datastar's `payload` option, which arrives as JSON and
    is exposed by `read_signals()`. A POST fallback keeps ordinary form-encoded
    callers/tests working.
    """
    signals = read_signals(request) or {}
    if signals:
        return signals
    return request.POST


def parse_iso(s: str) -> date | None:
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None
