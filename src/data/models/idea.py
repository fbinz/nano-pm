from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _


class IdeaStatus(models.TextChoices):
    INBOX = "inbox", _("Inbox")
    EXPLORING = "exploring", _("Exploring")
    PROMISING = "promising", _("Promising")
    PARKED = "parked", _("Parked")
    REJECTED = "rejected", _("Rejected")
    CONVERTED = "converted", _("Converted")


class Idea(models.Model):
    """A lightweight workspace-scoped sketch before work becomes planned."""

    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="ideas",
    )
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True, default="")
    status = models.CharField(
        max_length=20,
        choices=IdeaStatus.choices,
        default=IdeaStatus.INBOX,
    )
    tags = models.CharField(max_length=500, blank=True, default="")
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ideas_created",
    )
    converted_project = models.ForeignKey(
        "data.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="source_ideas",
    )
    converted_task = models.ForeignKey(
        "data.Task",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="source_ideas",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at", "-id"]

    def __str__(self) -> str:
        return self.title

    @property
    def tag_list(self) -> list[str]:
        return [tag.strip() for tag in self.tags.split(",") if tag.strip()]
