import secrets

from django.db import models


class Invitation(models.Model):
    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="invitations",
    )
    token = models.CharField(max_length=64, unique=True, default=secrets.token_urlsafe)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"Invite to {self.workspace} ({self.token[:8]}…)"
