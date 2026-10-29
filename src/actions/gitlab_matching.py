"""Durable ownership: prefixes discover issues but never reassign them."""

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils.translation import gettext_lazy as _

from data.models import GitLabConnection, GitLabIssue, GitLabIssueEvent, GitLabProjectBinding, Project


def normalize_prefix(value):
    return value.strip().casefold()


def title_prefix(title):
    prefix, colon, _title = title.partition(":")
    return normalize_prefix(prefix) if colon else ""


def queue_sync(connection):
    connection.revision += 1
    connection.needs_backfill = True
    connection.next_run = None
    connection.last_error = ""
    connection.failure_count = 0
    connection.save(update_fields=["revision", "needs_backfill", "next_run", "last_error", "failure_count"])


def claim_prefix(binding, completed):
    binding.active_prefix = binding.normalized_prefix if binding.collect and not completed else None
    if binding.active_prefix and GitLabProjectBinding.objects.filter(
        connection=binding.connection, active_prefix=binding.active_prefix,
    ).exclude(pk=binding.pk).exists():
        raise ValidationError(_("Another active project already collects this GitLab prefix."))


@transaction.atomic
def save_binding(*, workspace, project_id, prefix, collect):
    project = Project.objects.select_for_update().get(pk=project_id, workspace=workspace)
    connection = GitLabConnection.objects.get(workspace=workspace)
    prefix = prefix.strip()
    if not prefix or ":" in prefix:
        raise ValidationError(_("Enter a project prefix without a colon."))
    binding, _created = GitLabProjectBinding.objects.get_or_create(
        project=project, defaults={
            "connection": connection, "prefix": prefix, "normalized_prefix": normalize_prefix(prefix),
        },
    )
    binding.prefix = prefix
    binding.normalized_prefix = normalize_prefix(prefix)
    binding.collect = collect
    claim_prefix(binding, project.is_completed)
    try:
        with transaction.atomic():
            binding.save()
    except IntegrityError:
        raise ValidationError(_("Another active project already collects this GitLab prefix.")) from None
    queue_sync(connection)
    return binding


def reopen_conflict(project):
    binding = GitLabProjectBinding.objects.filter(project=project).first()
    if not binding or not project.is_completed:
        return False
    try:
        claim_prefix(binding, False)
    except ValidationError:
        return True
    return False


def sync_completion(project, completed):
    binding = GitLabProjectBinding.objects.filter(project=project).first()
    if binding:
        claim_prefix(binding, completed)
        binding.save(update_fields=["active_prefix"])
        queue_sync(binding.connection)


def retire_project(project):
    GitLabIssueEvent.objects.filter(issue__owner=project).delete()
    GitLabIssue.objects.filter(owner=project).update(
        owner=None, retired=True, title="", web_url="", labels=[], intervals=[],
        source_created_at=None, source_updated_at=None, source_closed_at=None,
        state="unclassified", source_state="", last_refresh=None,
    )
    binding = GitLabProjectBinding.objects.filter(project=project).first()
    if binding:
        connection = binding.connection
        binding.delete()
        queue_sync(connection)


def assign_unowned(connection, project_ids):
    # Called inside the sync transaction; SQLite's BEGIN IMMEDIATE serializes
    # collection with settings/completion and another sync process.
    bindings = {
        binding.active_prefix: binding
        for binding in connection.bindings.filter(
            active_prefix__isnull=False, project__completed_at__isnull=True,
            project__workspace_id=connection.workspace_id,
        ).select_related("project")
    }
    for issue in connection.issues.filter(owner=None, retired=False, gitlab_project_id__in=project_ids):
        binding = bindings.get(title_prefix(issue.title))
        if binding:
            GitLabIssue.objects.filter(pk=issue.pk, owner=None, retired=False).update(owner=binding.project)


@transaction.atomic
def transfer_issue(*, workspace, issue_id, project_id):
    issue = GitLabIssue.objects.select_related("connection").get(
        pk=issue_id, connection__workspace=workspace, retired=False,
    )
    project = Project.objects.get(pk=project_id, workspace=workspace)
    issue.owner = project
    issue.save(update_fields=["owner"])
    queue_sync(issue.connection)
    return issue
