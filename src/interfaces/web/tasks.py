"""Task endpoints — CRUD, move, resize, popover."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from actions.manage_tasks import (
    create_task, update_task, delete_task, move_task, move_many_tasks,
    resize_start, resize_end,
)
from data.models import Dependency
from readers import get_chart_state, get_task

from .helpers import is_pm, is_assigned, parse_iso, patch_chart, request_data


def render_task_popover(request: HttpRequest, task_id: int) -> str | None:
    """Render the task-popover fragment for `task_id`, or None if it's gone."""
    task = get_task(request.workspace, task_id)
    if task is None:
        return None
    state = get_chart_state(request.workspace)
    preds = list(
        Dependency.objects.filter(successor=task)
        .select_related("predecessor")
    )
    succs = list(
        Dependency.objects.filter(predecessor=task)
        .select_related("successor")
    )
    task.assignee_ids = list(task.assignees.values_list("id", flat=True))
    task.project_id = task.project.id
    can_edit = is_pm(request) or not task.assignee_ids or is_assigned(request, task)
    return render_component(
        request, "screens/gantt/task-popover",
        task=task, projects=state.projects, people=state.people,
        preds=preds, succs=succs, can_edit=can_edit,
    )


@login_required
@datastar_response
def task_popover(request: HttpRequest, task_id: int):
    fragment = render_task_popover(request, task_id)
    if fragment is None:
        return
    yield SSE.patch_elements(fragment)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_update(request: HttpRequest, task_id: int):
    title = request.POST.get("title", "").strip() or None
    description = request.POST.get("description") if "description" in request.POST else None
    start = parse_iso(request.POST.get("start", ""))
    end = parse_iso(request.POST.get("end", ""))
    project_id_raw = request.POST.get("project_id")
    project_id = int(project_id_raw) if project_id_raw and project_id_raw.isdigit() else None
    assignee_ids = [int(x) for x in request.POST.getlist("assignee_ids") if x.isdigit()]
    update_task(
        workspace=request.workspace,
        task_id=task_id,
        title=title,
        description=description,
        start=start,
        end=end,
        project_id=project_id,
        assignee_ids=assignee_ids,
        actor=request.user,
    )
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_move(request: HttpRequest, task_id: int):
    data = request_data(request)
    new_start = parse_iso(data.get("start", ""))
    if new_start is None:
        return
    move_task(workspace=request.workspace, task_id=task_id, new_start=new_start, actor=request.user)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_move_many(request: HttpRequest):
    """Bulk-shift a set of tasks by a common day delta."""
    data = request_data(request)
    raw_ids = data.get("task_ids", "")
    task_ids = [int(x) for x in raw_ids.split(",") if x.strip().lstrip("-").isdigit()]
    try:
        delta_days = int(data.get("delta_days", "0"))
    except ValueError:
        delta_days = 0
    if not task_ids or delta_days == 0:
        return
    move_many_tasks(workspace=request.workspace, task_ids=task_ids, delta_days=delta_days, actor=request.user)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_resize_start(request: HttpRequest, task_id: int):
    data = request_data(request)
    new_start = parse_iso(data.get("start", ""))
    if new_start is None:
        return
    resize_start(workspace=request.workspace, task_id=task_id, new_start=new_start, actor=request.user)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_resize_end(request: HttpRequest, task_id: int):
    data = request_data(request)
    new_end = parse_iso(data.get("end", ""))
    if new_end is None:
        return
    resize_end(workspace=request.workspace, task_id=task_id, new_end=new_end, actor=request.user)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_create(request: HttpRequest):
    data = request_data(request)
    project_id = int(data.get("project_id", 0) or 0)
    start = parse_iso(data.get("start", ""))
    end = parse_iso(data.get("end", ""))
    title = data.get("title", "").strip() or "New task"
    if not project_id or start is None or end is None:
        return
    create_task(
        workspace=request.workspace, project_id=project_id, title=title, start=start, end=end,
        actor=request.user,
    )
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_delete_view(request: HttpRequest, task_id: int):
    delete_task(workspace=request.workspace, task_id=task_id, actor=request.user)
    yield patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')
