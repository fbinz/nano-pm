"""Project endpoints — CRUD, popover, collapse."""

from functools import wraps
from inspect import iscoroutinefunction

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from actions.manage_projects import (
    create_project, update_project, delete_project, move_project,
    move_project_to_workspace, set_project_completed,
)
from data.models import Membership, WorkspaceRole
from data.models.project import PROJECT_COLORS
from readers import get_project

from .helpers import (
    collapsed_projects, set_collapsed_projects,
    show_completed, set_show_completed, patch_chart,
    is_pm,
)


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


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_create(request: HttpRequest):
    position = request.GET.get("position", "end")
    if position not in ("start", "end"):
        position = "end"
    create_project(workspace=request.workspace, position=position)
    yield patch_chart(request)


@login_required
@datastar_response
def project_popover(request: HttpRequest, project_id: int):
    proj = get_project(request.workspace, project_id)
    if proj is None:
        return
    destination_workspaces = [
        m.workspace for m in Membership.objects.filter(
            user=request.user,
            role=WorkspaceRole.PM,
        ).exclude(
            workspace=request.workspace,
        ).select_related("workspace").order_by("workspace__name")
    ]
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/project-popover",
            project=proj,
            colors=PROJECT_COLORS,
            destination_workspaces=destination_workspaces,
            is_pm=is_pm(request),
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_update(request: HttpRequest, project_id: int):
    update_project(
        workspace=request.workspace,
        project_id=project_id,
        name=request.POST.get("name") or None,
        description=request.POST.get("description") if "description" in request.POST else None,
        color=request.POST.get("color") or None,
    )
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_move(request: HttpRequest, project_id: int):
    direction = int(request.GET.get("dir", "0") or 0)
    move_project(workspace=request.workspace, project_id=project_id, direction=direction)
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_move_workspace(request: HttpRequest, project_id: int):
    try:
        target_workspace_id = int(request.POST.get("workspace_id", "0") or 0)
    except ValueError:
        target_workspace_id = 0
    moved = move_project_to_workspace(
        user=request.user,
        workspace=request.workspace,
        project_id=project_id,
        target_workspace_id=target_workspace_id,
    )
    if moved is None:
        return
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_toggle_completed(request: HttpRequest, project_id: int):
    proj = get_project(request.workspace, project_id)
    if proj is None:
        return
    set_project_completed(
        workspace=request.workspace, project_id=project_id,
        completed=not proj.is_completed,
    )
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def toggle_show_completed(request: HttpRequest):
    set_show_completed(request, not show_completed(request))
    request.session.save()
    yield patch_chart(request)
    yield SSE.patch_elements(render_component(
        request, "screens/gantt/show-completed-toggle",
        show_completed=show_completed(request),
    ))


@require_http_methods(["POST"])
@login_required
@pm_required
@datastar_response
def project_delete(request: HttpRequest, project_id: int):
    delete_project(workspace=request.workspace, project_id=project_id)
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
def project_toggle_collapse(request: HttpRequest, project_id: int):
    """Persist the collapsed/expanded state to the session (fire-and-forget)."""
    if get_project(request.workspace, project_id) is None:
        return HttpResponse(status=404)
    collapsed = collapsed_projects(request)
    collapsed.symmetric_difference_update({project_id})
    set_collapsed_projects(request, collapsed)
    request.session.save()
    return HttpResponse(status=204)


@require_http_methods(["POST"])
@login_required
def set_all_collapsed(request: HttpRequest):
    """Persist the full collapsed set (fire-and-forget from collapse-all / expand-all)."""
    raw = request.POST.get("ids", "")
    ids = {int(x) for x in raw.split(",") if x.strip().isdigit()}
    set_collapsed_projects(request, ids)
    request.session.save()
    return HttpResponse(status=204)
