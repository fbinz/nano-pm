"""Shared authorization, bounded pagination and strict domain validation."""

from types import SimpleNamespace

import msgspec
from django.core import signing
from django.db.models import Q
from django_mcpz.server import ToolError

from data.models import (
    Dependency,
    GitLabIssue,
    Membership,
    Milestone,
    Project,
    Task,
    WorkspaceRole,
)
from permissions import can_manage_project, can_manage_task, has_idea_perm, is_pm
from readers.mcp import fingerprint


def fail(code, message):
    raise ToolError(msgspec.json.encode({"code": code, "message": message}).decode())


def require(condition, code="forbidden", message="This operation is not permitted."):
    if not condition:
        fail(code, message)


def memberships(request):
    return Membership.objects.filter(
        user=request.user, workspace__in=request.mcp_policy.workspaces.all()
    ).select_related("workspace", "user")


def has_cap(request, cap):
    return cap in request.mcp_policy.capabilities


def scope(request, workspace_id):
    membership = memberships(request).filter(workspace_id=workspace_id).first()
    require(membership is not None, "not_found", "Workspace not found.")
    request.workspace, request.membership = membership.workspace, membership
    return membership.workspace


def visible(request, caps, pm=False, idea_action=None):
    if not any(has_cap(request, c) for c in caps):
        return False
    for membership in memberships(request):
        if pm and membership.role != WorkspaceRole.PM:
            continue
        if idea_action and not has_idea_perm(
            SimpleNamespace(user=request.user, membership=membership), idea_action
        ):
            continue
        return True
    return False


def lookup(model, pk, workspace):
    if model in (Task, Milestone):
        qs = model.objects.select_related("project").filter(
            project__workspace=workspace
        )
    elif model is GitLabIssue:
        qs = model.objects.select_related("connection", "owner").filter(
            connection__workspace=workspace, retired=False
        )
    elif model is Dependency:
        qs = model.objects.filter(
            predecessor__project__workspace=workspace,
            successor__project__workspace=workspace,
        )
    else:
        qs = model.objects.filter(workspace=workspace)
    obj = qs.filter(pk=pk).first()
    require(obj is not None, "not_found", "Object not found.")
    return obj


def unique(ids):
    require(
        len(ids) == len(set(ids)), "validation_error", "Duplicate IDs are not allowed."
    )
    return ids


def related(model, ids, workspace):
    unique(ids)
    for pk in ids:
        lookup(model, pk, workspace)
    return ids


def manage_project(request, project):
    require(can_manage_project(request, project))
    request.mcp_guards.append(("project", project.pk))


def manage_task(request, task):
    require(can_manage_task(request, task))
    request.mcp_guards.append(("task", task.pk))


def replay_guards(request, guards):
    for kind, pk in guards:
        if kind == "workspace_pm":
            membership = memberships(request).filter(workspace_id=pk).first()
            require(membership is not None, "not_found", "Workspace not found.")
            require(membership.role == WorkspaceRole.PM)
            continue
        model = Project if kind == "project" else Task
        qs = model.objects.filter(
            pk=pk,
            **(
                {"workspace": request.workspace}
                if kind == "project"
                else {"project__workspace": request.workspace}
            ),
        )
        obj = qs.first()
        if obj is None:
            require(is_pm(request))
        else:
            (manage_project if kind == "project" else manage_task)(request, obj)


def match(params, data):
    require(
        params.if_match == data["revision"],
        "conflict",
        "State changed. Read the current revision and retry with a new operation ID.",
    )


def patch(params, names):
    values = {
        name: getattr(params, name)
        for name in names.split()
        if getattr(params, name) is not msgspec.UNSET
    }
    require(bool(values), "validation_error", "Provide at least one field to change.")
    for key in ("name", "title", "prefix"):
        if key in values:
            values[key] = values[key].strip()
            require(bool(values[key]), "validation_error", f"{key} must not be blank.")
    return values


def name(value):
    value = value.strip()
    require(bool(value), "validation_error", "Name must not be blank.")
    return value


def dates(start, end):
    require(
        end > start, "validation_error", "End must be after start (exclusive end date)."
    )


def date_filter(qs, params, field):
    if getattr(params, "start", None):
        qs = qs.filter(**{f"{field}__gte": params.start})
    if getattr(params, "end", None):
        qs = qs.filter(**{f"{field}__lt": params.end})
    if getattr(params, "start", None) and getattr(params, "end", None):
        dates(params.start, params.end)
    return qs


def page(request, qs, params, reader, *, revision=None):
    args = msgspec.to_builtins(params)
    args.pop("cursor", None)
    binding = fingerprint([request.mcp_policy.pk, request.mcp_tool, args])
    offset = 0
    if params.cursor:
        try:
            cursor = signing.loads(params.cursor, salt="nano.mcp.page", max_age=3600)
            require(
                cursor["binding"] == binding,
                "validation_error",
                "Cursor does not match this query.",
            )
            offset = cursor["offset"]
            require(
                type(offset) is int and 0 <= offset <= 1000000,
                "validation_error",
                "Invalid cursor.",
            )
        except (signing.BadSignature, KeyError, TypeError, ValueError):
            fail("validation_error", "Invalid or expired cursor.")
    rows = list(qs[offset : offset + params.limit + 1])
    result = {
        "items": [reader(row) for row in rows[: params.limit]],
        "next_cursor": None,
    }
    if len(rows) > params.limit:
        result["next_cursor"] = signing.dumps(
            {"binding": binding, "offset": offset + params.limit},
            salt="nano.mcp.page",
            compress=True,
        )
    if revision is not None:
        result["revision"] = revision
    return result


def project_filter(qs, params, workspace, field="project_id"):
    if getattr(params, "project_id", None) is not None:
        lookup(Project, params.project_id, workspace)
        qs = qs.filter(**{field: params.project_id})
    return qs


def either_task_filter(qs, params, workspace):
    if params.task_id is not None:
        lookup(Task, params.task_id, workspace)
        qs = qs.filter(
            Q(predecessor_id=params.task_id) | Q(successor_id=params.task_id)
        )
    if params.project_id is not None:
        lookup(Project, params.project_id, workspace)
        qs = qs.filter(
            Q(predecessor__project_id=params.project_id)
            | Q(successor__project_id=params.project_id)
        )
    return qs
