"""Project endpoints — CRUD, popover, collapse."""

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import Http404, HttpRequest, HttpResponse
from django.shortcuts import redirect, render
from django.utils import timezone
from django.utils.translation import gettext as _
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from actions.manage_projects import (
    create_project, update_project, delete_project, move_project, reorder_projects,
    move_project_to_workspace, set_project_completed,
)
from data.models import Membership, Person, WorkspaceRole
from data.models.project import PROJECT_COLORS
from data.models.task import status_for_dates
from readers import get_project

from .detail_forms import ProjectDetailForm
from .helpers import (
    collapsed_projects, set_collapsed_projects,
    show_completed, set_show_completed, patch_chart,
    team_filter, can_manage_project, project_manager_required, request_data,
    request_person, is_pm, workspace_context,
)


@require_http_methods(["GET", "POST"])
@login_required
def project_detail(request: HttpRequest, project_id: int):
    project = get_project(request.workspace, project_id)
    if project is None:
        raise Http404
    can_edit = can_manage_project(request, project)
    if request.method == "POST" and not can_edit:
        return HttpResponse(status=403)
    form = ProjectDetailForm(
        request.POST if request.method == "POST" else None,
        project=project, workspace=request.workspace,
    ) if can_edit else None
    if request.method == "POST" and form.is_valid():
        data = form.cleaned_data
        update_project(
            workspace=request.workspace, project_id=project.id,
            name=data["name"], description=data["description"], color=data["color"],
            responsible_person_ids=[person.id for person in data["responsible_person_ids"]],
            actor=request.user,
        )
        messages.success(request, _("Project saved."))
        return redirect("project_detail", project_id=project.id)
    tasks = list(project.tasks.prefetch_related("assignees"))
    today = timezone.localdate()
    for task in tasks:
        task.status_label = status_for_dates(task.start, task.end, today).label
    return render(request, "components/screens/projects/detail.html", {
        "project": project,
        "form": form, "can_edit": can_edit,
        "edit_label": _("Edit project"), "save_label": _("Save project"),
        "tasks": tasks,
        "milestones": project.milestones.all(),
        "responsible_people": project.responsible_people.all(),
        "is_pm": is_pm(request),
        **workspace_context(request),
    }, status=400 if request.method == "POST" else 200)


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_create(request: HttpRequest):
    position = request.GET.get("position", "end")
    if position not in ("start", "end"):
        position = "end"
    create_project(workspace=request.workspace, position=position, actor=request.user)
    yield patch_chart(request)
    if team_filter(request):
        yield SSE.patch_elements(render_component(
            request, "screens/gantt/project-hidden-toast",
        ))


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
    proj.responsible_person_ids = list(
        proj.responsible_people.values_list("id", flat=True)
    )
    current_person = request_person(request)
    can_manage = can_manage_project(request, proj)
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/project-popover",
            project=proj,
            people=Person.objects.filter(workspace=request.workspace)
                .prefetch_related("teams").order_by("name", "id"),
            colors=PROJECT_COLORS,
            destination_workspaces=destination_workspaces,
            can_manage=can_manage,
            current_person=current_person,
            can_assign_self=(
                current_person is not None
                and not proj.responsible_person_ids
                and not can_manage
            ),
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_update(request: HttpRequest, project_id: int):
    proj = get_project(request.workspace, project_id)
    if proj is None:
        return
    can_manage = can_manage_project(request, proj)
    responsible_person_ids = [
        int(value)
        for value in request.POST.getlist("responsible_person_ids")
        if value.isdigit()
    ]
    current_person = request_person(request)
    can_update_responsible_people = can_manage or (
        current_person is not None
        and not proj.responsible_people.exists()
        and set(responsible_person_ids) == {current_person.id}
    )
    update_project(
        workspace=request.workspace,
        project_id=project_id,
        name=request.POST.get("name") or None,
        description=request.POST.get("description") if "description" in request.POST else None,
        color=request.POST.get("color") or None,
        responsible_person_ids=(
            responsible_person_ids if can_update_responsible_people else None
        ),
        actor=request.user,
    )
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_move(request: HttpRequest, project_id: int):
    direction = int(request.GET.get("dir", "0") or 0)
    move_project(workspace=request.workspace, project_id=project_id, direction=direction, actor=request.user)
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_reorder(request: HttpRequest):
    raw_ids = str(request_data(request).get("project_ids", ""))
    project_ids = [int(value) for value in raw_ids.split(",") if value.strip().isdigit()]
    reorder_projects(workspace=request.workspace, project_ids=project_ids, actor=request.user)
    set_collapsed_projects(
        request,
        set(request.workspace.projects.values_list("id", flat=True)),
    )
    request.session.save()
    yield patch_chart(request)


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
        actor=request.user,
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
        actor=request.user,
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
@project_manager_required
@datastar_response
def project_delete(request: HttpRequest, project_id: int):
    delete_project(workspace=request.workspace, project_id=project_id, actor=request.user)
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
