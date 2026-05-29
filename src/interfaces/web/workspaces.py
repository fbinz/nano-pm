"""Workspace switching and creation."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect
from django.views.decorators.http import require_http_methods

from data.models import Membership, Workspace, WorkspaceRole


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
    request.session["active_workspace_id"] = ws.id
    request.session.save()
    return redirect("/")
