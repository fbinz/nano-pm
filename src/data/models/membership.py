from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _


class WorkspaceRole(models.TextChoices):
    PM = "pm", _("PM")
    MEMBER = "member", _("Member")


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
    workload_participation = models.CharField(
        max_length=10,
        choices=[
            ("inherit", _("Inherit")),
            ("included", _("Included")),
            ("exempt", _("Exempt")),
        ],
        default="inherit",
    )
    workload_snoozed_until = models.DateTimeField(null=True, blank=True)
    # Self-declared Microsoft sign-in address, scoped to this workspace/tenant.
    teams_upn = models.EmailField(max_length=254, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "workspace"], name="unique_membership"
            ),
        ]

    @property
    def can_report_workload(self) -> bool:
        if not self.workspace.workload_enabled:
            return False
        if self.workload_participation != "inherit":
            return self.workload_participation == "included"
        if self.role == WorkspaceRole.PM:
            return self.workspace.workload_pms_included
        return self.workspace.workload_members_included

    def __str__(self) -> str:
        return f"{self.user} @ {self.workspace} ({self.role})"
