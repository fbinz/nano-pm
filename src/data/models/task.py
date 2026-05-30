from django.db import models
from django.utils.translation import gettext_lazy as _


class TaskStatus(models.TextChoices):
    PLANNED = "planned", _("Planned")
    IN_PROGRESS = "in-progress", _("In progress")
    BLOCKED = "blocked", _("Blocked")
    DONE = "done", _("Done")


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
    status = models.CharField(
        max_length=20,
        choices=TaskStatus.choices,
        default=TaskStatus.PLANNED,
    )
    assignees = models.ManyToManyField("data.Person", related_name="tasks", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["start", "id"]

    def __str__(self) -> str:
        return self.title
