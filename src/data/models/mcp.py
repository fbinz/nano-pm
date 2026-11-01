"""Workspace/capability grants shared by bearer tokens and OAuth code families."""

from django.db import models
from django.utils import timezone


MCP_CAPABILITIES = (
    "core.read",
    "core.write",
    "workspace.admin",
    "workload.self",
    "workload.manage",
    "sharing.links",
    "workspace.create",
)


class MCPAccessPolicy(models.Model):
    token = models.OneToOneField(
        "django_mcpz_bearer_tokens.Token",
        on_delete=models.CASCADE,
        related_name="nano_policy",
        null=True,
        blank=True,
    )
    oauth_code = models.OneToOneField(
        "django_mcpz_oauth.AuthorizationCode",
        on_delete=models.CASCADE,
        related_name="nano_policy",
        null=True,
        blank=True,
    )
    revoked_at = models.DateTimeField(null=True, blank=True)
    workspaces = models.ManyToManyField("data.Workspace", blank=True)
    capabilities = models.JSONField(default=list)
    rate_window = models.DateTimeField(default=timezone.now)
    rate_count = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(token__isnull=False, oauth_code__isnull=True)
                    | models.Q(token__isnull=True, oauth_code__isnull=False)
                ),
                name="mcp_policy_one_credential",
            ),
        ]


class MCPMutationReceipt(models.Model):
    policy = models.ForeignKey(MCPAccessPolicy, on_delete=models.CASCADE)
    tool = models.CharField(max_length=128)
    # Zero denotes the global workspace-creation operation. Not a FK: receipts
    # survive changes to their original target and replay deletions safely.
    workspace_key = models.PositiveBigIntegerField(default=0)
    operation_id = models.UUIDField()
    arguments_hash = models.CharField(max_length=64)
    result = models.JSONField(default=dict)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["policy", "tool", "workspace_key", "operation_id"],
                name="unique_mcp_operation",
            ),
        ]
