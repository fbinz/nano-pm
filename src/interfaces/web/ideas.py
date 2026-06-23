"""Ideas pages and promotion actions."""

from datetime import date, timedelta

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.translation import gettext as _
from django.views.decorators.http import require_http_methods

from actions.manage_ideas import (
    convert_idea_to_project,
    create_idea,
    create_task_from_idea,
    delete_idea,
    set_idea_status,
    update_idea,
)
from data.models import Idea, IdeaStatus, Project

from .helpers import is_pm, parse_iso, workspace_context


def _idea_queryset(request: HttpRequest):
    return Idea.objects.filter(workspace=request.workspace).select_related(
        "creator", "converted_project", "converted_task"
    )


def _idea_or_404(request: HttpRequest, idea_id: int) -> Idea:
    return get_object_or_404(_idea_queryset(request), id=idea_id)


def _projects(request: HttpRequest):
    return Project.objects.filter(workspace=request.workspace).order_by("order", "id")


def has_idea_perm(request: HttpRequest, action: str) -> bool:
    """Workspace PMs are idea admins; other users use Django model perms."""
    if is_pm(request):
        return True
    return request.user.has_perm(f"data.{action}_idea")


def forbidden() -> HttpResponse:
    return HttpResponse(status=403)


@login_required
def ideas_page(request: HttpRequest) -> HttpResponse:
    if not has_idea_perm(request, "view"):
        return forbidden()
    ideas = list(_idea_queryset(request))
    groups = [
        {
            "value": status.value,
            "label": status.label,
            "ideas": [idea for idea in ideas if idea.status == status.value],
        }
        for status in IdeaStatus
    ]
    return render(request, "components/screens/ideas/index.html", {
        "groups": groups,
        "statuses": IdeaStatus,
        "can_add": has_idea_perm(request, "add"),
        "user": request.user,
        "is_pm": is_pm(request),
        **workspace_context(request),
    })


@require_http_methods(["POST"])
@login_required
def idea_create(request: HttpRequest) -> HttpResponse:
    if not has_idea_perm(request, "add"):
        return forbidden()
    idea = create_idea(
        workspace=request.workspace,
        creator=request.user,
        title=request.POST.get("title", ""),
    )
    return redirect("idea_detail", idea_id=idea.id)


@login_required
def idea_detail(request: HttpRequest, idea_id: int) -> HttpResponse:
    if not has_idea_perm(request, "view"):
        return forbidden()
    idea = _idea_or_404(request, idea_id)
    today = date.today()
    return render(request, "components/screens/ideas/detail.html", {
        "idea": idea,
        "statuses": IdeaStatus,
        "projects": _projects(request),
        "default_start": today.isoformat(),
        "default_end": (today + timedelta(days=7)).isoformat(),
        "can_edit": has_idea_perm(request, "change"),
        "can_delete": has_idea_perm(request, "delete"),
        "user": request.user,
        "is_pm": is_pm(request),
        **workspace_context(request),
    })


@require_http_methods(["POST"])
@login_required
def idea_update(request: HttpRequest, idea_id: int) -> HttpResponse:
    if not has_idea_perm(request, "change"):
        return forbidden()
    _idea_or_404(request, idea_id)
    update_idea(
        workspace=request.workspace,
        idea_id=idea_id,
        title=request.POST.get("title", ""),
        body=request.POST.get("body", ""),
        status=request.POST.get("status", ""),
        tags=request.POST.get("tags", ""),
    )
    messages.success(request, _("Idea saved."))
    return redirect("idea_detail", idea_id=idea_id)


@require_http_methods(["POST"])
@login_required
def idea_status(request: HttpRequest, idea_id: int, status: str) -> HttpResponse:
    if not has_idea_perm(request, "change"):
        return forbidden()
    _idea_or_404(request, idea_id)
    if status in IdeaStatus.values:
        set_idea_status(workspace=request.workspace, idea_id=idea_id, status=status)
    return redirect("idea_detail", idea_id=idea_id)


@require_http_methods(["POST"])
@login_required
def idea_convert_project(request: HttpRequest, idea_id: int) -> HttpResponse:
    if not has_idea_perm(request, "change"):
        return forbidden()
    _idea_or_404(request, idea_id)
    idea = convert_idea_to_project(
        workspace=request.workspace,
        idea_id=idea_id,
        name=request.POST.get("name", ""),
    )
    if idea is not None:
        messages.success(request, _("Idea converted to a project."))
    return redirect("idea_detail", idea_id=idea_id)


@require_http_methods(["POST"])
@login_required
def idea_create_task(request: HttpRequest, idea_id: int) -> HttpResponse:
    if not has_idea_perm(request, "change"):
        return forbidden()
    _idea_or_404(request, idea_id)
    project_id_raw = request.POST.get("project_id", "")
    project_id = int(project_id_raw) if project_id_raw.isdigit() else 0
    start = parse_iso(request.POST.get("start", ""))
    end = parse_iso(request.POST.get("end", ""))
    if project_id and start is not None and end is not None:
        idea = create_task_from_idea(
            workspace=request.workspace,
            idea_id=idea_id,
            project_id=project_id,
            title=request.POST.get("title", ""),
            start=start,
            end=end,
        )
        if idea is not None and idea.converted_task_id:
            messages.success(request, _("Idea converted to a task."))
    return redirect("idea_detail", idea_id=idea_id)


@require_http_methods(["POST"])
@login_required
def idea_delete(request: HttpRequest, idea_id: int) -> HttpResponse:
    if not has_idea_perm(request, "delete"):
        return forbidden()
    _idea_or_404(request, idea_id)
    delete_idea(workspace=request.workspace, idea_id=idea_id)
    messages.success(request, _("Idea deleted."))
    return redirect("ideas_page")
