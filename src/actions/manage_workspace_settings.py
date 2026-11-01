"""Shared settings/subscription mutations for web forms and MCP adapters."""

import secrets

from django.db import transaction

from actions.activity import change_set, log_activity, snapshot
from actions.gitlab_matching import queue_sync
from data.models import Membership, ProjectSubscription, Workspace, WorkspaceRole


@transaction.atomic
def create_workspace(*, name, actor):
    workspace = Workspace.objects.create(name=name)
    Membership.objects.create(workspace=workspace, user=actor, role=WorkspaceRole.PM)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="workspace.created",
        entity=workspace,
        changes={"name": {"to": workspace.name}},
    )
    return workspace


@transaction.atomic
def update_settings(*, workspace, actor, values, action="workspace.updated"):
    workspace = Workspace.objects.select_for_update().get(pk=workspace.pk)
    before = snapshot(workspace, list(values))
    for key, value in values.items():
        setattr(workspace, key, value)
    workspace.save(update_fields=[*values, "updated_at"])
    log_activity(
        workspace=workspace,
        actor=actor,
        action=action,
        entity=workspace,
        changes=change_set(before, snapshot(workspace, list(values))),
        skip_empty_changes=True,
    )
    return workspace


@transaction.atomic
def update_roadmap(*, workspace, actor, values, rotate=False, action=None):
    workspace = Workspace.objects.select_for_update().get(pk=workspace.pk)
    before = snapshot(
        workspace,
        [
            "public_roadmap_enabled",
            "public_roadmap_title",
            "public_roadmap_description",
        ],
    )
    for key, value in values.items():
        setattr(workspace, key, value)
    if rotate or (
        workspace.public_roadmap_enabled and not workspace.public_roadmap_token
    ):
        while True:
            token = secrets.token_urlsafe(18)
            if not Workspace.objects.filter(public_roadmap_token=token).exists():
                workspace.public_roadmap_token = token
                break
    if rotate:
        workspace.public_roadmap_enabled = True
    workspace.save(
        update_fields=[
            "public_roadmap_enabled",
            "public_roadmap_title",
            "public_roadmap_description",
            "public_roadmap_token",
            "updated_at",
        ]
    )
    changes = change_set(before, snapshot(workspace, list(before)))
    if rotate:
        changes["public_roadmap_token"] = {"to": "regenerated"}
    log_activity(
        workspace=workspace,
        actor=actor,
        action=action
        or (
            "workspace.public_roadmap.regenerated"
            if rotate
            else "workspace.public_roadmap.updated"
        ),
        entity=workspace,
        changes=changes,
        skip_empty_changes=True,
    )
    return workspace


@transaction.atomic
def set_subscription(*, workspace, membership, project, subscribed, actor):
    qs = ProjectSubscription.objects.filter(project=project, membership=membership)
    before = qs.exists()
    if subscribed:
        ProjectSubscription.objects.get_or_create(
            project=project, membership=membership
        )
    else:
        qs.delete()
    if before != subscribed:
        log_activity(
            workspace=workspace,
            actor=actor,
            action="project.subscription.updated",
            entity=project,
            changes={"subscribed": {"from": before, "to": subscribed}},
        )


@transaction.atomic
def request_sync(*, workspace, connection, actor, workflow=None):
    if workflow is not None:
        connection.workflow = workflow
        connection.save(update_fields=["workflow"])
    queue_sync(connection)
    log_activity(
        workspace=workspace,
        actor=actor,
        action="gitlab.workflow.updated"
        if workflow is not None
        else "gitlab.sync.requested",
        entity=workspace,
        changes={"sync": {"to": "queued"}},
    )
    return connection
