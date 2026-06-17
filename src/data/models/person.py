from django.conf import settings
from django.db import models


class Person(models.Model):
    """A team member who can be assigned to tasks."""

    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="people",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="person_profiles",
    )
    name = models.CharField(max_length=100)
    teams = models.ManyToManyField("data.Team", related_name="people", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]

    def __str__(self) -> str:
        return self.name
