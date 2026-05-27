from django.db import models


PROJECT_COLORS = [
    "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899",
    "#06b6d4", "#ef4444", "#84cc16", "#f97316", "#0ea5e9",
]


class Project(models.Model):
    """A project within a workspace. Groups tasks and milestones."""

    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="projects",
    )
    name = models.CharField(max_length=200)
    color = models.CharField(max_length=9, default=PROJECT_COLORS[0])
    # Float ordering keeps re-order cheap (insert between any two by averaging).
    order = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self) -> str:
        return self.name
