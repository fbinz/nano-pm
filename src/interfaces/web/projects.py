"""Project endpoints — CRUD, popover, collapse."""

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
    set_project_completed,
)
from data.models.project import PROJECT_COLORS
from readers import get_project

from ._helpers import (
    _collapsed_projects, _set_collapsed_projects,
    _show_completed, _set_show_completed, _patch_chart,
)


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_create(request: HttpRequest):
    position = request.GET.get("position", "end")
    if position not in ("start", "end"):
        position = "end"
    create_project(workspace=request.workspace, position=position)
    yield _patch_chart(request)


@login_required
@datastar_response
def project_popover(request: HttpRequest, project_id: int):
    proj = get_project(request.workspace, project_id)
    if proj is None:
        return
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/project-popover",
            project=proj,
            colors=PROJECT_COLORS,
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
        color=request.POST.get("color") or None,
    )
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_move(request: HttpRequest, project_id: int):
    direction = int(request.GET.get("dir", "0") or 0)
    move_project(workspace=request.workspace, project_id=project_id, direction=direction)
    yield _patch_chart(request)
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
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def toggle_show_completed(request: HttpRequest):
    _set_show_completed(request, not _show_completed(request))
    request.session.save()
    yield _patch_chart(request)
    yield SSE.patch_elements(render_component(
        request, "screens/gantt/show-completed-toggle",
        show_completed=_show_completed(request),
    ))


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_delete(request: HttpRequest, project_id: int):
    delete_project(workspace=request.workspace, project_id=project_id)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
def project_toggle_collapse(request: HttpRequest, project_id: int):
    """Persist the collapsed/expanded state to the session (fire-and-forget)."""
    if get_project(request.workspace, project_id) is None:
        return HttpResponse(status=404)
    collapsed = _collapsed_projects(request)
    collapsed.symmetric_difference_update({project_id})
    _set_collapsed_projects(request, collapsed)
    request.session.save()
    return HttpResponse(status=204)


@require_http_methods(["POST"])
@login_required
def set_all_collapsed(request: HttpRequest):
    """Persist the full collapsed set (fire-and-forget from collapse-all / expand-all)."""
    raw = request.POST.get("ids", "")
    ids = {int(x) for x in raw.split(",") if x.strip().isdigit()}
    _set_collapsed_projects(request, ids)
    request.session.save()
    return HttpResponse(status=204)
