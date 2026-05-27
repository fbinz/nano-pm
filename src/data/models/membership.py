from django.conf import settings
from django.db import models


class WorkspaceRole(models.TextChoices):
    PM = "pm", "PM"
    MEMBER = "member", "Member"


class Membership(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    role = models.CharField(
        max_length=20,
        choices=WorkspaceRole.choices,
        default=WorkspaceRole.MEMBER,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "workspace"], name="unique_membership"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user} @ {self.workspace} ({self.role})"
