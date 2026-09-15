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
    DEFAULT_MILESTONE_TITLE,
    create_milestone, update_milestone, delete_milestone,
)
from readers import get_chart_state, get_project, get_milestone

from .helpers import is_pm, parse_iso, patch_chart, request_data


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
            m=m, projects=state.projects, is_initial=False, is_pm=is_pm(request),
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_update_view(request: HttpRequest, milestone_id: int):
    data = request_data(request)
    milestone = get_milestone(request.workspace, milestone_id)
    if milestone is None:
        return
    project_id_raw = str(data.get("project_id", ""))
    description = data.get("description") if "description" in data else None
    new_date = parse_iso(data.get("date", ""))
    moving = new_date is not None and new_date != milestone.date
    reason = str(data.get("reason", "")).strip()
    require_move_reason = None
    if is_pm(request) and "require_move_reason" in data:
        require_move_reason = str(data.get("require_move_reason", "")).lower() in {
            "1", "true", "on", "yes",
        }
    if moving and milestone.require_move_reason and len(reason) < 3:
        yield patch_chart(request)
        return
    updated = update_milestone(
        workspace=request.workspace,
        milestone_id=milestone_id,
        title=data.get("title") or None,
        description=description,
        on=new_date,
        project_id=int(project_id_raw) if project_id_raw.isdigit() else None,
        require_move_reason=require_move_reason,
        move_reason=reason if moving else None,
        actor=request.user,
    )
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')
    if moving and updated is not None:
        yield SSE.patch_elements(render_component(
            request, "screens/gantt/milestone-moved-toast", milestone=updated,
        ))


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
    reason = str(data.get("reason", "")).strip()
    milestone = get_milestone(request.workspace, milestone_id)
    if new_date is None or milestone is None:
        yield patch_chart(request)
        return
    if milestone.require_move_reason and len(reason) < 3:
        yield patch_chart(request)
        return
    updated = update_milestone(
        workspace=request.workspace,
        milestone_id=milestone_id,
        on=new_date,
        move_reason=reason,
        actor=request.user,
    )
    yield patch_chart(request)
    if updated is not None:
        yield SSE.patch_elements(render_component(
            request, "screens/gantt/milestone-moved-toast", milestone=updated,
        ))


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
        title=DEFAULT_MILESTONE_TITLE, on=on,
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
            m=m, projects=state.projects, is_initial=True, is_pm=is_pm(request),
        )
    )
