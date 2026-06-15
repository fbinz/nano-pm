"""Full-page renders — project view index and zoom endpoint."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from datastar_py.django import datastar_response

from readers import get_chart_state
from readers.chart_view import (
    build_chart_vm,
    ZOOM_PPD_RANGE,
    ZOOM_DAYS_PER_UNIT,
)

from .helpers import (
    zoom, ppd, collapsed_projects, show_completed,
    is_pm, workspace_context, patch_chart,
)


@login_required
def index(request: HttpRequest) -> HttpResponse:
    request.session["view_mode"] = "project"
    request.session.save()
    state = get_chart_state(request.workspace)
    active_zoom = zoom(request)
    px_per_day = ppd(request, active_zoom)
    vm = build_chart_vm(
        state, active_zoom,
        px_per_day=px_per_day,
        collapsed_project_ids=collapsed_projects(request),
        show_completed=show_completed(request),
        is_pm=is_pm(request),
    )
    days_per_unit = ZOOM_DAYS_PER_UNIT[active_zoom]
    lo, hi = ZOOM_PPD_RANGE[active_zoom]
    return render(
        request,
        "components/screens/gantt/index.html",
        {
            "vm": vm,
            "zoom": active_zoom,
            "user": request.user,
            "is_pm": is_pm(request),
            "ppd_unit": px_per_day * days_per_unit,
            "ppd_unit_min": lo * days_per_unit,
            "ppd_unit_max": hi * days_per_unit,
            "ppd_unit_step": days_per_unit,
            "days_per_unit": days_per_unit,
            **workspace_context(request),
        },
    )


@login_required
@datastar_response
def zoom_set(request: HttpRequest):
    """Slider-driven density change — re-render the chart at the requested
    px/day. Reads ?ppd=… and persists per-zoom in the session via ppd()."""
    active_zoom = zoom(request)
    ppd(request, active_zoom)
    request.session.save()
    yield patch_chart(request, active_zoom=active_zoom)
