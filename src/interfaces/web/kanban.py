"""Kanban view — board page, status change endpoint, and the GET/POST dispatcher for /tasks/."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from datastar_py.django import datastar_response

from actions.manage_tasks import update_task
from data.models import TaskStatus
from readers import get_chart_state
from readers.chart_view import build_kanban_vm

from ._helpers import _is_pm, _patch_chart, _workspace_context


@login_required
def kanban_index(request: HttpRequest) -> HttpResponse:
    request.session["view_mode"] = "kanban"
    request.session.save()
    state = get_chart_state(request.workspace)
    vm = build_kanban_vm(state)
    return render(
        request,
        "components/screens/kanban/index.html",
        {
            "vm": vm,
            "user": request.user,
            "is_pm": _is_pm(request),
            **_workspace_context(request),
        },
    )


@login_required
@datastar_response
def task_set_status(request: HttpRequest, task_id: int):
    if request.method != "POST":
        return HttpResponse(status=405)
    new_status = request.POST.get("status", "")
    if new_status not in {c.value for c in TaskStatus}:
        return
    update_task(workspace=request.workspace, task_id=task_id, status=new_status)
    yield _patch_chart(request)
