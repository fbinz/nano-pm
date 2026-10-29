"""Workspace-local GitLab cache. Source data never changes the planning models."""

from django.db import models
from django.utils.translation import gettext_lazy as _


def default_workflow():
    return {
        "in-progress": ["In Development"], "done": ["Next Deployment"],
        "not-started": [], "fallback": "unclassified",
    }


class GitLabConnection(models.Model):
    workspace = models.OneToOneField("data.Workspace", on_delete=models.CASCADE, related_name="gitlab_connection")
    instance_url = models.URLField(max_length=2048)
    token_ciphertext = models.TextField(blank=True)
    project_ids = models.JSONField(default=list)
    group_ids = models.JSONField(default=list)
    workflow = models.JSONField(default=default_workflow)
    enabled = models.BooleanField(default=True)
    revision = models.PositiveIntegerField(default=1)
    checkpoints = models.JSONField(default=dict)
    needs_backfill = models.BooleanField(default=True)
    next_run = models.DateTimeField(null=True, blank=True)
    last_success = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=100, blank=True)
    failure_count = models.PositiveIntegerField(default=0)
    lease_token = models.CharField(max_length=36, blank=True)
    lease_until = models.DateTimeField(null=True, blank=True)

    @property
    def is_stale(self):
        from datetime import timedelta
        from django.utils import timezone
        return bool(self.last_error or not self.last_success or timezone.now() - self.last_success > timedelta(minutes=15))

    @property
    def sync_status(self):
        from django.utils import timezone
        if not self.enabled:
            return _("Disconnected")
        if self.lease_until and self.lease_until > timezone.now():
            return _("Running")
        if self.last_error:
            return self.last_error
        if self.next_run is None or self.next_run <= timezone.now():
            return _("Queued")
        return _("Up to date")


class GitLabProjectBinding(models.Model):
    project = models.OneToOneField("data.Project", on_delete=models.CASCADE, related_name="gitlab_binding")
    connection = models.ForeignKey(GitLabConnection, on_delete=models.CASCADE, related_name="bindings")
    prefix = models.CharField(max_length=200)
    normalized_prefix = models.CharField(max_length=400)
    collect = models.BooleanField(default=True)
    # NULL releases the database-enforced claim without losing the saved preference.
    active_prefix = models.CharField(max_length=400, null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["connection", "active_prefix"], name="unique_gitlab_collector"),
        ]


class GitLabIssue(models.Model):
    class State(models.TextChoices):
        UNCLASSIFIED = "unclassified", _("Unclassified")
        NOT_STARTED = "not-started", _("Not started")
        IN_PROGRESS = "in-progress", _("In progress")
        DONE = "done", _("Done")

    connection = models.ForeignKey(GitLabConnection, on_delete=models.CASCADE, related_name="issues")
    gitlab_project_id = models.PositiveBigIntegerField()
    iid = models.PositiveBigIntegerField()
    title = models.TextField()
    web_url = models.URLField(max_length=2048, blank=True)
    labels = models.JSONField(default=list)
    source_state = models.CharField(max_length=20, default="opened")
    source_created_at = models.DateTimeField(null=True)
    source_updated_at = models.DateTimeField(null=True)
    source_closed_at = models.DateTimeField(null=True)
    owner = models.ForeignKey("data.Project", on_delete=models.SET_NULL, null=True, related_name="gitlab_issues")
    # Retired issues cannot be auto-collected after deleting/moving their owner.
    retired = models.BooleanField(default=False)
    state = models.CharField(max_length=20, choices=State.choices, default=State.UNCLASSIFIED)
    intervals = models.JSONField(default=list)
    mapping_revision = models.PositiveIntegerField(default=0)
    last_refresh = models.DateTimeField(null=True)
    unavailable = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["connection", "gitlab_project_id", "iid"], name="unique_gitlab_issue"),
        ]
        ordering = ["gitlab_project_id", "iid"]

    @property
    def reference(self):
        return f"{self.gitlab_project_id}#{self.iid}"

    @property
    def prefix_changed(self):
        from actions.gitlab_matching import title_prefix
        binding = getattr(self.owner, "gitlab_binding", None) if self.owner_id else None
        return binding is not None and title_prefix(self.title) != binding.normalized_prefix


class GitLabIssueEvent(models.Model):
    issue = models.ForeignKey(GitLabIssue, on_delete=models.CASCADE, related_name="events")
    kind = models.CharField(max_length=10)
    source_id = models.PositiveBigIntegerField()
    timestamp = models.DateTimeField()
    data = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["issue", "kind", "source_id"], name="unique_gitlab_event"),
        ]
        ordering = ["timestamp", "kind", "source_id"]
