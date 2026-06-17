from django.db import models
from django.db.models import UniqueConstraint
from django.db.models.functions import Lower


class Team(models.Model):
    """A named group of people within a workspace."""

    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="teams",
    )
    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]
        constraints = [
            UniqueConstraint(
                Lower("name"),
                "workspace",
                name="unique_team_name_per_workspace_ci",
            ),
        ]

    def __str__(self) -> str:
        return self.name
