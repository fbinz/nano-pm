"""Workspace switching, creation, and public roadmap settings."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse, HttpResponseNotAllowed
from django.shortcuts import redirect, render
from django.utils.translation import gettext as _
from django.views.decorators.http import require_http_methods
from django.views.decorators.cache import never_cache

from actions import manage_workspace_settings as settings_actions
from data.models import Membership
from .public_subscriptions import render_public_roadmap

from .helpers import is_pm, pm_required, workspace_context
from .workload import settings_context
from .gitlab import settings_context as gitlab_settings_context


@login_required
@pm_required
@require_http_methods(["GET", "POST"])
def workspace_settings(request: HttpRequest, section: str = "general"):
    if request.method == "POST":
        if section != "general":
            return HttpResponseNotAllowed(["GET"])
        settings_actions.update_settings(
            workspace=request.workspace, actor=request.user,
            values={"prompt_milestone_move_reason": request.POST.get("prompt_milestone_move_reason") == "on"},
        )
        return redirect("workspace_settings")
    return render_workspace_settings(request, section)


def render_workspace_settings(request, section, *, status=200, **extra):
    sections = [
        {"key": "general", "label": _("General"), "url": "workspace_settings"},
        {"key": "workload", "label": _("Workload"), "url": "workspace_settings_workload"},
        {"key": "integrations", "label": _("Integrations"), "url": "workspace_settings_integrations"},
        {"key": "sharing", "label": _("Roadmap"), "url": "workspace_settings_sharing"},
    ]
    context = {
        "user": request.user,
        "is_pm": True,
        **workspace_context(request),
        "settings_section": section,
        "settings_sections": sections,
        "settings_section_label": next(item["label"] for item in sections if item["key"] == section),
    }
    if section == "workload":
        context.update(settings_context(request.workspace))
    elif section == "integrations":
        context.update(gitlab_settings_context(request.workspace))
    return render(
        request,
        "components/screens/workspaces/settings.html",
        {**context, **extra},
        status=status,
    )


@require_http_methods(["POST"])
@login_required
def workspace_switch(request: HttpRequest, workspace_id: int):
    if not Membership.objects.filter(user=request.user, workspace_id=workspace_id).exists():
        return HttpResponse(status=403)
    request.session["active_workspace_id"] = workspace_id
    request.session.save()
    return redirect("/")


@require_http_methods(["POST"])
@login_required
def workspace_create(request: HttpRequest):
    name = request.POST.get("name", "").strip() or "New workspace"
    ws = settings_actions.create_workspace(name=name, actor=request.user)
    request.session["active_workspace_id"] = ws.id
    request.session.save()
    return redirect("/")


@require_http_methods(["POST"])
@login_required
def workspace_rename(request: HttpRequest):
    if not is_pm(request):
        return HttpResponse(status=403)

    name = request.POST.get("name", "").strip()
    if not name:
        return HttpResponse(status=400)

    settings_actions.update_settings(workspace=request.workspace, actor=request.user, values={"name": name[:200]})
    if request.POST.get("next") == "workspace_settings":
        return redirect("workspace_settings")
    return redirect("/")


@require_http_methods(["POST"])
@login_required
def public_roadmap_update(request: HttpRequest):
    if not is_pm(request):
        return HttpResponse(status=403)

    action = request.POST.get("action")
    if action in {"enable", "disable"}:
        values = {"public_roadmap_enabled": action == "enable"}
    elif action == "save":
        values = {
            "public_roadmap_title": request.POST.get("title", "").strip(),
            "public_roadmap_description": request.POST.get("description", "").strip(),
        }
    else:
        return HttpResponse(status=400)
    event_action = {
        "enable": "workspace.public_roadmap.enabled",
        "disable": "workspace.public_roadmap.disabled",
        "save": "workspace.public_roadmap.updated",
    }[action]
    settings_actions.update_roadmap(workspace=request.workspace, actor=request.user, values=values, action=event_action)
    return redirect("workspace_settings_sharing")


@require_http_methods(["POST"])
@login_required
def public_roadmap_regenerate(request: HttpRequest):
    if not is_pm(request):
        return HttpResponse(status=403)

    settings_actions.update_roadmap(workspace=request.workspace, actor=request.user, values={}, rotate=True)
    return redirect("workspace_settings_sharing")


@never_cache
def public_roadmap(request: HttpRequest, token: str):
    return render_public_roadmap(request, token)
