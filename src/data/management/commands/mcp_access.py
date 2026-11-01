"""Operator-only bearer provisioning and OAuth grant administration."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django_mcpz.bearer_tokens.models import Token
from django_mcpz.oauth.cleanup import clear_expired as clear_oauth

from data.models import Membership, MCPAccessPolicy, MCPMutationReceipt
from data.models.mcp import MCP_CAPABILITIES


class Command(BaseCommand):
    help = "Create/configure/revoke MCP client access, or clean expired credentials and receipts."

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="operation", required=True)
        create = sub.add_parser("create")
        create.add_argument("name")
        create.add_argument("--user", required=True)
        create.add_argument("--expires-in-days", type=int, default=30)
        for target in (create, sub.add_parser("configure")):
            if target is not create:
                target.add_argument("token_id", type=int)
            target.add_argument("--workspace", action="append", type=int, default=[])
            target.add_argument(
                "--capability", action="append", choices=MCP_CAPABILITIES, default=[]
            )
        revoke = sub.add_parser("revoke")
        revoke.add_argument("token_id", type=int)
        sub.add_parser("list")
        sub.add_parser("cleanup")
        sub.add_parser("oauth-list")
        oauth_revoke = sub.add_parser("oauth-revoke")
        oauth_revoke.add_argument("policy_id", type=int)

    @transaction.atomic
    def handle(self, *args, **options):
        operation = options["operation"]
        if operation == "oauth-list":
            for policy in (
                MCPAccessPolicy.objects.filter(oauth_code__isnull=False)
                .select_related("oauth_code__user", "oauth_code__client")
                .order_by("pk")
            ):
                self.stdout.write(
                    f"{policy.pk}: {policy.oauth_code.client} user={policy.oauth_code.user.get_username()} revoked={policy.revoked_at is not None} workspaces={list(policy.workspaces.values_list('id', flat=True))} capabilities={policy.capabilities}"
                )
            return
        if operation == "oauth-revoke":
            policy = (
                MCPAccessPolicy.objects.select_for_update()
                .filter(pk=options["policy_id"], oauth_code__isnull=False)
                .first()
            )
            if policy is None:
                raise CommandError("OAuth grant not found.")
            policy.revoked_at = timezone.now()
            policy.save(update_fields=["revoked_at"])
            policy.oauth_code.revoke_family()
            self.stdout.write("Revoked OAuth grant.")
            return
        if operation == "cleanup":
            now = timezone.now()
            receipts = MCPMutationReceipt.objects.filter(
                created_at__lt=now - timedelta(days=7)
            ).delete()[0]
            tokens = Token.objects.filter(
                Q(expires_at__lte=now) | Q(revoked_at__isnull=False)
            ).delete()[0]
            self.stdout.write(
                f"Removed {receipts} expired receipt rows and {tokens} expired/revoked credential rows; OAuth: {clear_oauth()}."
            )
            return
        if operation == "list":
            for token in Token.objects.select_related("user").order_by("pk"):
                policy = MCPAccessPolicy.objects.filter(token=token).first()
                self.stdout.write(
                    f"{token.pk}: {token.name} user={token.user.get_username()} expires={token.expires_at} revoked={token.is_revoked} workspaces={list(policy.workspaces.values_list('id', flat=True)) if policy else []} capabilities={policy.capabilities if policy else []}"
                )
            return
        if operation == "create":
            try:
                user = get_user_model().objects.get(
                    username=options["user"], is_active=True
                )
            except get_user_model().DoesNotExist:
                raise CommandError("Active user not found.") from None
            if not 1 <= options["expires_in_days"] <= 365:
                raise CommandError("Expiry must be between 1 and 365 days.")
            token, value = Token.create(
                name=options["name"],
                user=user,
                expires_at=timezone.now() + timedelta(days=options["expires_in_days"]),
            )
        else:
            token = (
                Token.objects.select_for_update().filter(pk=options["token_id"]).first()
            )
            if token is None:
                raise CommandError("Token not found.")
            if operation == "revoke":
                token.revoke()
                self.stdout.write("Revoked.")
                return
            if token.is_revoked or token.is_expired or token.expires_at is None:
                raise CommandError("Token must be active and expiring.")
        workspace_ids = set(options["workspace"])
        valid_ids = set(
            Membership.objects.filter(
                user=token.user, workspace_id__in=workspace_ids
            ).values_list("workspace_id", flat=True)
        )
        if valid_ids != workspace_ids:
            raise CommandError("Every workspace must be a current user membership.")
        capabilities = sorted(set(options["capability"]))
        if not capabilities or (
            not workspace_ids and capabilities != ["workspace.create"]
        ):
            raise CommandError(
                "Choose capabilities and allowed workspaces (or workspace.create alone)."
            )
        policy, _ = MCPAccessPolicy.objects.update_or_create(
            token=token, defaults={"capabilities": capabilities}
        )
        policy.workspaces.set(workspace_ids)
        if operation == "create":
            # The credential is printed once, only after configuration succeeds.
            self.stdout.write(value)
        else:
            self.stdout.write("Configured.")
