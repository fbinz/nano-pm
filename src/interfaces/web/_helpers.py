"""Shared helpers for the Gantt chart views."""

from datetime import date

from django.http import HttpRequest

from datastar_py.django import ServerSentEventGenerator as SSE
from django_cotton import render_component

from data.models import Membership, Person, TaskStatus, WorkspaceRole
from readers import get_chart_state
from readers.chart_view import (
    build_chart_vm,
    build_kanban_vm,
    build_resource_vm,
    DEFAULT_ZOOM,
    ZOOM_PX_PER_DAY,
    ZOOM_PPD_RANGE,
)


_VALID_ZOOMS = {"day", "week", "month", "quarter"}


def _zoom(request: HttpRequest) -> str:
    z = request.GET.get("zoom")
    if z in _VALID_ZOOMS:
        request.session["zoom"] = z
        return z
    sz = request.session.get("zoom")
    if sz in _VALID_ZOOMS:
        return sz
    return DEFAULT_ZOOM


def _ppd(request: HttpRequest, zoom: str) -> int:
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


def _collapsed_projects(request: HttpRequest) -> set[int]:
    """Read the per-session set of collapsed project IDs (UI-only state; no DB)."""
    raw = request.session.get("collapsed_projects", [])
    return {int(x) for x in raw if isinstance(x, (int, str)) and str(x).lstrip("-").isdigit()}


def _set_collapsed_projects(request: HttpRequest, ids: set[int]) -> None:
    """Persist the collapsed project ID set into the session as a sorted list."""
    request.session["collapsed_projects"] = sorted(ids)


def _collapsed_people(request: HttpRequest) -> set[int]:
    raw = request.session.get("collapsed_people", [])
    return {int(x) for x in raw if isinstance(x, (int, str)) and str(x).lstrip("-").isdigit()}


def _set_collapsed_people(request: HttpRequest, ids: set[int]) -> None:
    request.session["collapsed_people"] = sorted(ids)


_DEFAULT_STATUS_FILTER = {TaskStatus.PLANNED, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED}


def _status_filter(request: HttpRequest) -> set[str]:
    raw = request.session.get("status_filter")
    if raw is None:
        return set(_DEFAULT_STATUS_FILTER)
    valid = {c.value for c in TaskStatus}
    return {s for s in raw if s in valid}


def _set_status_filter(request: HttpRequest, statuses: set[str]) -> None:
    request.session["status_filter"] = sorted(statuses)


def _view_mode(request: HttpRequest) -> str:
    return request.session.get("view_mode", "project")


def _is_pm(request: HttpRequest) -> bool:
    m = getattr(request, "membership", None)
    return m is not None and m.role == WorkspaceRole.PM


def _workspace_context(request: HttpRequest) -> dict:
    workspaces = list(
        Membership.objects.filter(user=request.user)
        .select_related("workspace")
        .order_by("workspace__name")
    )
    return {
        "workspace": request.workspace,
        "workspaces": [m.workspace for m in workspaces],
        "has_multiple_workspaces": len(workspaces) > 1,
    }


def _is_assigned(request: HttpRequest, task) -> bool:
    person = Person.objects.filter(
        workspace=request.workspace, user=request.user
    ).first()
    if person is None:
        return False
    return task.assignees.filter(id=person.id).exists()


def _patch_chart(request: HttpRequest, zoom: str | None = None):
    """Yield an SSE patch that replaces the chart fragment with a fresh render."""
    state = get_chart_state(request.workspace)
    mode = _view_mode(request)
    if mode == "kanban":
        return SSE.patch_elements(render_component(
            request, "screens/kanban/board",
            vm=build_kanban_vm(state), is_pm=_is_pm(request),
        ))
    z = zoom or _zoom(request)
    ppd = _ppd(request, z)
    if mode == "resource":
        vm = build_resource_vm(state, z, px_per_day=ppd,
                               collapsed_person_ids=_collapsed_people(request),
                               status_filter=_status_filter(request))
        template = "screens/gantt/chart_resource"
    else:
        vm = build_chart_vm(state, z, px_per_day=ppd,
                            collapsed_project_ids=_collapsed_projects(request),
                            is_pm=_is_pm(request))
        template = "screens/gantt/chart"
    return SSE.patch_elements(
        render_component(request, template, vm=vm, is_pm=_is_pm(request))
    )


def _parse_iso(s: str) -> date | None:
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None
