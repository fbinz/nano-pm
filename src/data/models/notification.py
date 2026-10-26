"""Editable notification aggregates, independent of HTTP delivery attempts."""

from django.db import models
from django.utils import timezone


class NotificationBatch(models.Model):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        MATERIALIZED = "materialized", "Materialized"
        CANCELLED = "cancelled", "Cancelled"

    workspace = models.ForeignKey("data.Workspace", on_delete=models.CASCADE, related_name="notification_batches")
    # Snapshot identities intentionally survive project/milestone deletion.
    project_key = models.PositiveBigIntegerField()
    project_name = models.CharField(max_length=200)
    destination_hash = models.CharField(max_length=64)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    created_at = models.DateTimeField(default=timezone.now)
    last_changed_at = models.DateTimeField(default=timezone.now)
    send_after = models.DateTimeField()
    materialized_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "project_key", "destination_hash"],
                condition=models.Q(status="open"), name="unique_open_notification_batch",
            ),
        ]
        indexes = [models.Index(fields=["status", "send_after"])]


class NotificationChange(models.Model):
    batch = models.ForeignKey(NotificationBatch, on_delete=models.CASCADE, related_name="changes")
    milestone_key = models.PositiveBigIntegerField()
    before = models.JSONField(null=True)
    after = models.JSONField(null=True)
    # Enabled event keys captured when changes occur, like recipient snapshots.
    events = models.JSONField(default=list)
    latest_move_reason = models.CharField(max_length=500, blank=True, default="")
    latest_move_actor = models.CharField(max_length=300, blank=True, default="")
    latest_move_at = models.DateTimeField(null=True, blank=True)
    contributors = models.JSONField(default=list)
    recipients = models.JSONField(default=list)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["batch", "milestone_key"], name="unique_batch_milestone_change"),
        ]
        indexes = [models.Index(fields=["milestone_key"])]
        ordering = ["id"]
