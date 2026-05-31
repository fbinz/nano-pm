"""Full-page renders — project view index and zoom endpoint."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from datastar_py.django import datastar_response

from readers import get_chart_state
from readers.chart_view import (
    build_chart_vm,
    ZOOM_PX_PER_DAY,
    ZOOM_PPD_RANGE,
    ZOOM_DAYS_PER_UNIT,
)

from ._helpers import (
    _zoom, _ppd, _collapsed_projects, _show_completed,
    _is_pm, _workspace_context, _patch_chart,
)


@login_required
def index(request: HttpRequest) -> HttpResponse:
    request.session["view_mode"] = "project"
    request.session.save()
    state = get_chart_state(request.workspace)
    zoom = _zoom(request)
    ppd = _ppd(request, zoom)
    vm = build_chart_vm(
        state, zoom,
        px_per_day=ppd,
        collapsed_project_ids=_collapsed_projects(request),
        show_completed=_show_completed(request),
        is_pm=_is_pm(request),
    )
    days_per_unit = ZOOM_DAYS_PER_UNIT[zoom]
    lo, hi = ZOOM_PPD_RANGE[zoom]
    return render(
        request,
        "components/screens/gantt/index.html",
        {
            "vm": vm,
            "zoom": zoom,
            "user": request.user,
            "is_pm": _is_pm(request),
            "ppd_unit": ppd * days_per_unit,
            "ppd_unit_min": lo * days_per_unit,
            "ppd_unit_max": hi * days_per_unit,
            "ppd_unit_step": days_per_unit,
            "days_per_unit": days_per_unit,
            **_workspace_context(request),
        },
    )


@login_required
@datastar_response
def zoom_set(request: HttpRequest):
    """Slider-driven density change — re-render the chart at the requested
    px/day. Reads ?ppd=… and persists per-zoom in the session via _ppd()."""
    zoom = _zoom(request)
    _ppd(request, zoom)
    request.session.save()
    yield _patch_chart(request, zoom=zoom)
