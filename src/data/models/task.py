from datetime import date

from django.db import models
from django.utils.translation import gettext_lazy as _


class TaskStatus(models.TextChoices):
    PLANNED = "planned", _("Planned")
    IN_PROGRESS = "in-progress", _("In progress")
    DONE = "done", _("Done")


def status_for_dates(start: date, end: date, today: date) -> TaskStatus:
    """Derive task status solely from its date range."""
    if end < today:
        return TaskStatus.DONE
    if start > today:
        return TaskStatus.PLANNED
    return TaskStatus.IN_PROGRESS


class Task(models.Model):
    """A task on a Gantt chart. Belongs to a project; spans [start, end] inclusive."""

    project = models.ForeignKey(
        "data.Project",
        on_delete=models.CASCADE,
        related_name="tasks",
    )
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    start = models.DateField()
    end = models.DateField()
    assignees = models.ManyToManyField("data.Person", related_name="tasks", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["start", "id"]

    def __str__(self) -> str:
        return self.title
