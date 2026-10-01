from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class ProjectSubscription(models.Model):
    project = models.ForeignKey("data.Project", on_delete=models.CASCADE, related_name="subscriptions")
    membership = models.ForeignKey("data.Membership", on_delete=models.CASCADE, related_name="subscriptions")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "membership"], name="unique_project_subscription"),
        ]


class PublicProjectSubscription(models.Model):
    """Self-declared Teams address, managed by a private browser capability."""

    project = models.ForeignKey("data.Project", on_delete=models.CASCADE, related_name="public_subscriptions")
    browser_key_hash = models.CharField(max_length=64, db_index=True)
    teams_email = models.EmailField(max_length=254)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "browser_key_hash"], name="unique_public_project_subscription"),
        ]


class TeamsDelivery(models.Model):
    """Durable outbox. No webhook credentials or raw HTTP errors are stored here."""

    class Status(models.TextChoices):
        PENDING = "pending", _("Pending")
        SENDING = "sending", _("Sending")
        SENT = "sent", _("Sent")
        FAILED = "failed", _("Failed")
        CANCELLED = "cancelled", _("Cancelled")

    workspace = models.ForeignKey("data.Workspace", on_delete=models.CASCADE, related_name="teams_deliveries")
    destination_hash = models.CharField(max_length=64)
    payload = models.JSONField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveIntegerField(default=0)
    available_at = models.DateTimeField(default=timezone.now)
    locked_until = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["status", "available_at"])]
        ordering = ["created_at", "id"]
