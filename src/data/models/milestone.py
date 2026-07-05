from django.db import models


class Milestone(models.Model):
    """A zero-duration marker on the Gantt chart. Belongs to a project."""

    project = models.ForeignKey(
        "data.Project",
        on_delete=models.CASCADE,
        related_name="milestones",
    )
    task = models.OneToOneField(
        "data.Task",
        on_delete=models.CASCADE,
        related_name="milestone",
        null=True,
        blank=True,
    )
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["date", "id"]

    def __str__(self) -> str:
        return self.title
