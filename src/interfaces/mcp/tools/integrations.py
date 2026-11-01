"""Cached GitLab data and safe integration/sharing operations; no credentials."""

from actions.gitlab_matching import save_binding, transfer_issue
from actions.manage_workspace_settings import (
    request_sync,
    set_subscription,
    update_roadmap,
    update_settings,
)
from actions.activity import log_activity
from actions.public_subscriptions import normalize_domains
from data.models import (
    GitLabConnection,
    GitLabIssue,
    GitLabProjectBinding,
    Project,
    ProjectSubscription,
    TeamsDelivery,
)
from readers import mcp as view

from .. import schemas as s
from ..common import (
    date_filter,
    lookup,
    manage_project,
    match,
    page,
    patch,
    project_filter,
    require,
    unique,
)
from ..registry import tool


def get_connection(r, *, enabled=False):
    obj = GitLabConnection.objects.filter(workspace=r.workspace).first()
    require(
        obj is not None and (not enabled or obj.enabled),
        "feature_disabled",
        "GitLab connection is not configured/enabled.",
    )
    return obj


@tool(s.WorkspaceParams, cap="workspace.admin", pm=True)
def get_gitlab_connection(r, p):
    """Read configured/enabled/sync status and workflow; never source credentials or leases."""
    return {
        "item": view.connection(
            GitLabConnection.objects.filter(workspace=r.workspace).first()
        )
    }


@tool(s.GitLabPage)
def list_gitlab_issues(r, p):
    """Read cached issues only; filtering never performs a remote request."""
    qs = (
        GitLabIssue.objects.filter(connection__workspace=r.workspace, retired=False)
        .select_related("connection")
        .order_by("id")
    )
    qs = project_filter(qs, p, r.workspace, "owner_id")
    if p.state:
        qs = qs.filter(state=p.state)
    if p.search:
        qs = qs.filter(title__icontains=p.search)
    return page(r, qs, p, lambda obj: view.issue(obj, False))


@tool(s.ObjectParams)
def get_gitlab_issue(r, p):
    """Read cached issue details, sanitized source URL and execution intervals."""
    return {"item": view.issue(lookup(GitLabIssue, p.id, r.workspace))}


@tool(s.ObjectParams)
def get_project_gitlab_binding(r, p):
    """Read a project's GitLab prefix/collection preference, including an unset binding revision."""
    lookup(Project, p.id, r.workspace)
    obj = GitLabProjectBinding.objects.filter(
        project_id=p.id, connection__workspace=r.workspace
    ).first()
    return {"item": view.binding(obj, p.id)}


@tool(s.BindingUpdate, cap="core.write", mutation=True)
def update_project_gitlab_binding(r, p):
    """Patch prefix/collection preference; reject active prefix conflicts and queue background sync."""
    project = lookup(Project, p.id, r.workspace)
    manage_project(r, project)
    get_connection(r)
    obj = GitLabProjectBinding.objects.filter(
        project=project, connection__workspace=r.workspace
    ).first()
    current = view.binding(obj, project.pk)
    match(p, current)
    values = patch(p, "prefix collect")
    prefix = values.get("prefix", current["prefix"])
    require(bool(prefix), "validation_error", "Provide a prefix for a new binding.")
    obj = save_binding(
        workspace=r.workspace,
        project_id=project.pk,
        prefix=prefix,
        collect=values.get("collect", current["collect"]),
    )
    log_activity(
        workspace=r.workspace,
        actor=r.user,
        action="gitlab.binding.updated",
        entity=project,
        changes={"binding": {"changed": True}},
    )
    return {"item": view.binding(obj, project.pk)}


@tool(s.IssueTransfer, cap="core.write", mutation=True, destructive=True)
def transfer_gitlab_issue(r, p):
    """Change local cached issue ownership only; requires source and destination project management."""
    obj = lookup(GitLabIssue, p.id, r.workspace)
    require(obj.owner_id is not None)
    manage_project(r, obj.owner)
    manage_project(r, lookup(Project, p.project_id, r.workspace))
    match(p, view.issue(obj))
    obj = transfer_issue(
        workspace=r.workspace, issue_id=obj.pk, project_id=p.project_id
    )
    log_activity(
        workspace=r.workspace,
        actor=r.user,
        action="gitlab.issue.transferred",
        entity=obj,
        changes={"owner": {"to": p.project_id}},
    )
    return {"item": view.issue(obj)}


@tool(s.Change, cap="workspace.admin", pm=True, mutation=True)
def request_gitlab_sync(r, p):
    """Queue durable background sync and return status; never wait for remote API polling."""
    obj = get_connection(r, enabled=True)
    match(p, view.connection(obj))
    obj = request_sync(workspace=r.workspace, connection=obj, actor=r.user)
    return {"item": view.connection(obj)}


@tool(s.WorkflowUpdate, cap="workspace.admin", pm=True, mutation=True)
def update_gitlab_workflow(r, p):
    """Set cached issue workflow label mapping and queue background recomputation."""
    obj = get_connection(r)
    match(p, view.connection(obj))
    mapping = {
        "in-progress": p.in_progress_labels,
        "done": p.done_labels,
        "not-started": p.not_started_labels,
        "fallback": p.fallback,
    }
    for key in ("in-progress", "done", "not-started"):
        mapping[key] = list(
            dict.fromkeys(label.strip() for label in mapping[key] if label.strip())
        )
    obj = request_sync(
        workspace=r.workspace, connection=obj, actor=r.user, workflow=mapping
    )
    return {"item": view.connection(obj)}


@tool(s.WorkspaceParams, cap="workspace.admin", pm=True)
def get_notification_settings(r, p):
    """Read event preferences, subscriber domains and a configured boolean, never webhook URLs."""
    return {"item": view.notification_settings(r.workspace)}


@tool(s.NotificationUpdate, cap="workspace.admin", pm=True, mutation=True)
def update_notification_settings(r, p):
    """Patch workspace notification event preferences and public subscriber domains; no webhook administration."""
    match(p, view.notification_settings(r.workspace))
    values = patch(p, "events subscriber_domains")
    updates = {}
    if "events" in values:
        updates["teams_notify_events"] = unique(values["events"])
    if "subscriber_domains" in values:
        updates["teams_public_subscriber_domains"] = normalize_domains(
            ",".join(values["subscriber_domains"])
        )
    obj = update_settings(workspace=r.workspace, actor=r.user, values=updates)
    return {"item": view.notification_settings(obj)}


@tool(s.DeliveryPage, cap="workspace.admin", pm=True)
def list_notification_deliveries(r, p):
    """List safe outbox statuses/timestamps, never raw payloads, addresses or error bodies."""
    qs = TeamsDelivery.objects.filter(workspace=r.workspace).order_by("-id")
    if p.status:
        qs = qs.filter(status=p.status)
    return page(r, date_filter(qs, p, "created_at__date"), p, view.delivery)


@tool(s.Page)
def list_my_project_subscriptions(r, p):
    """List only your followed workspace projects, not other members' subscriptions."""
    qs = (
        ProjectSubscription.objects.filter(
            membership=r.membership, project__workspace=r.workspace
        )
        .select_related("project")
        .order_by("id")
    )
    return page(
        r,
        qs,
        p,
        lambda obj: {
            "project_id": obj.project_id,
            "subscribed": True,
            "revision": view.project(obj.project)["revision"],
        },
    )


@tool(s.SubscriptionChange, cap="core.write", mutation=True)
def set_my_project_subscription(r, p):
    """Set your own subscription explicitly; requires enabled roadmap and an active project."""
    require(
        r.workspace.public_roadmap_enabled,
        "feature_disabled",
        "Public roadmap is disabled.",
    )
    obj = lookup(Project, p.id, r.workspace)
    require(not obj.is_completed, "validation_error", "Project is completed.")
    match(p, view.project(obj))
    set_subscription(
        workspace=r.workspace,
        membership=r.membership,
        project=obj,
        subscribed=p.subscribed,
        actor=r.user,
    )
    return {
        "project_id": p.id,
        "subscribed": p.subscribed,
        "revision": view.project(obj)["revision"],
    }


@tool(s.WorkspaceParams, cap="workspace.admin", pm=True)
def get_public_roadmap_settings(r, p):
    """Read roadmap enabled/title/description without its capability URL/token."""
    return {"item": view.roadmap_settings(r.workspace)}


@tool(s.RoadmapUpdate, cap="workspace.admin", pm=True, mutation=True, destructive=True)
def update_public_roadmap_settings(r, p):
    """Publish/unpublish the roadmap or patch its title/description. Enabling publishes current roadmap data."""
    match(p, view.roadmap_settings(r.workspace))
    values = patch(p, "enabled title description")
    mapped = {
        "enabled": "public_roadmap_enabled",
        "title": "public_roadmap_title",
        "description": "public_roadmap_description",
    }
    obj = update_roadmap(
        workspace=r.workspace,
        actor=r.user,
        values={mapped[k]: v for k, v in values.items()},
    )
    return {"item": view.roadmap_settings(obj)}


@tool(s.WorkspaceParams, cap="workspace.admin", pm=True, extra_caps=("sharing.links",))
def get_public_roadmap_link(r, p):
    """Explicitly reveal the enabled roadmap's sensitive capability URL; never include it in ordinary reads."""
    require(
        r.workspace.public_roadmap_enabled,
        "feature_disabled",
        "Public roadmap is disabled.",
    )
    return {
        "link_reference": {
            "kind": "roadmap",
            "id": r.workspace.pk,
            "version": view.fingerprint(r.workspace.public_roadmap_token),
        }
    }


@tool(
    s.Change,
    cap="workspace.admin",
    pm=True,
    extra_caps=("sharing.links",),
    mutation=True,
    destructive=True,
)
def rotate_public_roadmap_link(r, p):
    """Invalidate the previous public roadmap URL and enable the new one; requires explicit user approval."""
    match(p, view.roadmap_settings(r.workspace))
    obj = update_roadmap(workspace=r.workspace, actor=r.user, values={}, rotate=True)
    return {
        "link_reference": {
            "kind": "roadmap",
            "id": obj.pk,
            "version": view.fingerprint(obj.public_roadmap_token),
        }
    }
