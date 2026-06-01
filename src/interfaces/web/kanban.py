"""Kanban view — board page, the unified drag endpoint, and the GET/POST dispatcher for /tasks/."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from datastar_py.django import datastar_response

from actions.manage_tasks import move_task_on_board
from data.models import TaskStatus
from readers import get_chart_state
from readers.chart_view import build_kanban_vm

from .helpers import is_pm, patch_chart, request_data, workspace_context


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
            "is_pm": is_pm(request),
            **workspace_context(request),
        },
    )


def to_int(raw: str | None) -> int | None:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


@login_required
@datastar_response
def task_board_move(request: HttpRequest, task_id: int):
    """Persist a single kanban drag — both column moves and same-column
    reorders. `status` is the target column; `before_id`/`after_id` are the
    cards now directly above/below the dropped card (empty at a column edge)."""
    if request.method != "POST":
        return HttpResponse(status=405)
    data = request_data(request)
    status = data.get("status", "")
    if status not in {c.value for c in TaskStatus}:
        return
    move_task_on_board(
        workspace=request.workspace,
        task_id=task_id,
        status=status,
        before_id=to_int(data.get("before_id")),
        after_id=to_int(data.get("after_id")),
    )
    yield patch_chart(request)
