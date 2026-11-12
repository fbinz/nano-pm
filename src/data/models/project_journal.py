"""Internal project discussion, independent of the public roadmap."""

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from .project import ProjectPhase


class JournalKind(models.TextChoices):
    NOTE = "note", _("Note")
    QUESTION = "question", _("Question")
    DECISION = "decision", _("Decision")
    UPDATE = "update", _("Update")
    PHASE = "phase", _("Phase change")


class ProjectJournalEntry(models.Model):
    project = models.ForeignKey("data.Project", on_delete=models.CASCADE, related_name="journal")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE, related_name="replies")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    author_label = models.CharField(max_length=150)
    kind = models.CharField(max_length=20, choices=JournalKind.choices, default=JournalKind.NOTE)
    body = models.TextField(blank=True)
    phase = models.CharField(max_length=20, choices=ProjectPhase.choices)
    previous_phase = models.CharField(max_length=20, choices=ProjectPhase.choices, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["project", "parent", "-created_at"], name="project_journal_timeline")]
