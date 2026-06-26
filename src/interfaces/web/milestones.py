"""Milestone endpoints — CRUD, move, popover."""

from datetime import date

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from actions.manage_milestones import (
    create_milestone, update_milestone, delete_milestone,
)
from readers import get_chart_state, get_project, get_milestone

from .helpers import parse_iso, patch_chart, request_data


@login_required
@datastar_response
def milestone_popover(request: HttpRequest, milestone_id: int):
    m = get_milestone(request.workspace, milestone_id)
    if m is None:
        return
    state = get_chart_state(request.workspace)
    m.project_id = m.project.id
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/milestone-popover",
            m=m, projects=state.projects,
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_update_view(request: HttpRequest, milestone_id: int):
    project_id_raw = request.POST.get("project_id", "")
    description = request.POST.get("description") if "description" in request.POST else None
    update_milestone(
        workspace=request.workspace,
        milestone_id=milestone_id,
        title=request.POST.get("title") or None,
        description=description,
        on=parse_iso(request.POST.get("date", "")),
        project_id=int(project_id_raw) if project_id_raw.isdigit() else None,
        actor=request.user,
    )
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_delete_view(request: HttpRequest, milestone_id: int):
    delete_milestone(workspace=request.workspace, milestone_id=milestone_id, actor=request.user)
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_move(request: HttpRequest, milestone_id: int):
    data = request_data(request)
    new_date = parse_iso(data.get("date", ""))
    if new_date is None:
        return
    update_milestone(workspace=request.workspace, milestone_id=milestone_id, on=new_date, actor=request.user)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_create(request: HttpRequest, project_id: int):
    """Create a milestone with placeholder title and open its editor."""
    proj = get_project(request.workspace, project_id)
    if proj is None:
        return
    data = request_data(request)
    on = parse_iso(data.get("date", "")) or date.today()
    m = create_milestone(
        workspace=request.workspace, project_id=project_id,
        title="New milestone", on=on,
        actor=request.user,
    )
    if m is None:
        return
    state = get_chart_state(request.workspace)
    yield patch_chart(request)
    m.project_id = m.project.id
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/milestone-popover",
            m=m, projects=state.projects,
        )
    )
