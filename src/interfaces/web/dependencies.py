"""Dependency endpoints — add and delete."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)

from actions.manage_dependencies import add_dependency, delete_dependency

from .helpers import patch_chart, request_data
from .tasks import render_task_popover


@require_http_methods(["POST"])
@login_required
@datastar_response
def dep_add(request: HttpRequest):
    data = request_data(request)
    pred = int(data.get("predecessor", 0) or 0)
    succ = int(data.get("successor", 0) or 0)
    _, _, err = add_dependency(
        workspace=request.workspace, predecessor_id=pred, successor_id=succ
    )
    if err:
        yield SSE.patch_elements(
            f'<div id="toast-slot"><div class="toast error">{err}</div></div>'
        )
        return
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def dep_delete(request: HttpRequest, predecessor_id: int, successor_id: int):
    delete_dependency(
        workspace=request.workspace,
        predecessor_id=predecessor_id,
        successor_id=successor_id,
    )
    yield patch_chart(request)
    task_raw = request.GET.get("task", "")
    if task_raw.isdigit():
        fragment = render_task_popover(request, int(task_raw))
        if fragment is not None:
            yield SSE.patch_elements(fragment)
