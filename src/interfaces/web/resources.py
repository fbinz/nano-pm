"""Resource view — page render, person collapse, status filter."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from data.models import TaskStatus
from readers import get_chart_state
from readers.chart_view import (
    build_resource_vm,
    ZOOM_PPD_RANGE,
    ZOOM_DAYS_PER_UNIT,
)

from .helpers import (
    zoom, ppd,
    collapsed_people, set_collapsed_people,
    status_filter, set_status_filter,
    is_pm, workspace_context, patch_chart, sidebar_width,
)


@login_required
def resource_index(request: HttpRequest) -> HttpResponse:
    request.session["view_mode"] = "resource"
    request.session.save()
    state = get_chart_state(request.workspace)
    active_zoom = zoom(request)
    px_per_day = ppd(request, active_zoom)
    sf = status_filter(request)
    vm = build_resource_vm(
        state, active_zoom, px_per_day=px_per_day,
        collapsed_person_ids=collapsed_people(request),
        status_filter=sf,
    )
    status_choices = [(c.value, c.label) for c in TaskStatus]
    days_per_unit = ZOOM_DAYS_PER_UNIT[active_zoom]
    lo, hi = ZOOM_PPD_RANGE[active_zoom]
    return render(
        request,
        "components/screens/gantt/resource_index.html",
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
            "status_choices": status_choices,
            "status_filter": sf,
            "sidebar_width": sidebar_width(request),
            **workspace_context(request),
        },
    )


@require_http_methods(["POST"])
@login_required
def person_toggle_collapse(request: HttpRequest, person_id: int):
    collapsed = collapsed_people(request)
    collapsed.symmetric_difference_update({person_id})
    set_collapsed_people(request, collapsed)
    request.session.save()
    return HttpResponse(status=204)


@require_http_methods(["POST"])
@login_required
def set_all_people_collapsed(request: HttpRequest):
    raw = request.POST.get("ids", "")
    ids = {int(x) for x in raw.split(",") if x.strip().lstrip("-").isdigit()}
    set_collapsed_people(request, ids)
    request.session.save()
    return HttpResponse(status=204)


@login_required
@datastar_response
def toggle_status_filter(request: HttpRequest):
    status = request.GET.get("status", "")
    valid = {c.value for c in TaskStatus}
    if status not in valid:
        return HttpResponse(status=400)
    sf = status_filter(request)
    sf.symmetric_difference_update({status})
    set_status_filter(request, sf)
    request.session.save()
    yield SSE.patch_elements(render_component(
        request, "screens/gantt/status-filter",
        status_choices=[(c.value, c.label) for c in TaskStatus],
        status_filter=sf,
    ))
    yield patch_chart(request)
