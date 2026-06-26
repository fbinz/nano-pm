"""Workspace switching, creation, and public roadmap settings."""

import secrets

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods

from actions.activity import change_set, created_changes, log_activity, snapshot
from data.models import Membership, Workspace, WorkspaceRole
from readers.public_roadmap import get_public_roadmap

from .helpers import is_pm


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
    ws = Workspace.objects.create(name=name)
    Membership.objects.create(user=request.user, workspace=ws, role=WorkspaceRole.PM)
    log_activity(
        workspace=ws,
        actor=request.user,
        action="workspace.created",
        entity=ws,
        changes=created_changes(snapshot(ws, ["name"])),
    )
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

    workspace = request.workspace
    before = snapshot(workspace, ["name"])
    workspace.name = name[:200]
    workspace.save(update_fields=["name", "updated_at"])
    log_activity(
        workspace=workspace,
        actor=request.user,
        action="workspace.updated",
        entity=workspace,
        changes=change_set(before, snapshot(workspace, ["name"])),
        skip_empty_changes=True,
    )
    return redirect("/")


def _generate_public_roadmap_token() -> str:
    while True:
        token = secrets.token_urlsafe(18)
        if not Workspace.objects.filter(public_roadmap_token=token).exists():
            return token


def _ensure_public_roadmap_token(workspace: Workspace) -> None:
    if not workspace.public_roadmap_token:
        workspace.public_roadmap_token = _generate_public_roadmap_token()


@require_http_methods(["POST"])
@login_required
def public_roadmap_update(request: HttpRequest):
    if not is_pm(request):
        return HttpResponse(status=403)

    workspace = request.workspace
    before = snapshot(workspace, [
        "public_roadmap_enabled",
        "public_roadmap_title",
        "public_roadmap_description",
    ])
    action = request.POST.get("action")
    if action == "enable":
        _ensure_public_roadmap_token(workspace)
        workspace.public_roadmap_enabled = True
    elif action == "disable":
        workspace.public_roadmap_enabled = False
    elif action == "save":
        workspace.public_roadmap_title = request.POST.get("title", "").strip()
        workspace.public_roadmap_description = request.POST.get("description", "").strip()
    else:
        return HttpResponse(status=400)

    workspace.save(update_fields=[
        "public_roadmap_enabled",
        "public_roadmap_token",
        "public_roadmap_title",
        "public_roadmap_description",
        "updated_at",
    ])
    event_action = {
        "enable": "workspace.public_roadmap.enabled",
        "disable": "workspace.public_roadmap.disabled",
        "save": "workspace.public_roadmap.updated",
    }[action]
    log_activity(
        workspace=workspace,
        actor=request.user,
        action=event_action,
        entity_type="workspace",
        entity_id=workspace.id,
        entity_label=workspace.name,
        changes=change_set(before, snapshot(workspace, [
            "public_roadmap_enabled",
            "public_roadmap_title",
            "public_roadmap_description",
        ])),
        skip_empty_changes=True,
    )
    return redirect("/")


@require_http_methods(["POST"])
@login_required
def public_roadmap_regenerate(request: HttpRequest):
    if not is_pm(request):
        return HttpResponse(status=403)

    workspace = request.workspace
    before = snapshot(workspace, ["public_roadmap_enabled"])
    workspace.public_roadmap_token = _generate_public_roadmap_token()
    workspace.public_roadmap_enabled = True
    workspace.save(update_fields=["public_roadmap_token", "public_roadmap_enabled", "updated_at"])
    changes = change_set(before, snapshot(workspace, ["public_roadmap_enabled"]))
    changes["public_roadmap_token"] = {"to": "regenerated"}
    log_activity(
        workspace=workspace,
        actor=request.user,
        action="workspace.public_roadmap.regenerated",
        entity_type="workspace",
        entity_id=workspace.id,
        entity_label=workspace.name,
        changes=changes,
    )
    return redirect("/")


def public_roadmap(request: HttpRequest, token: str):
    vm = get_public_roadmap(token)
    if vm is None:
        return HttpResponse(status=404)
    return render(request, "public/roadmap.html", {"vm": vm})
