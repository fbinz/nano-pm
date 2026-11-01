"""Both OAuth and pasted bearer credentials use the same fail-closed policy."""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from django_mcpz.bearer_tokens.auth import token_auth
from django_mcpz.bearer_tokens.models import Token
from django_mcpz.oauth.auth import oauth_auth
from django_mcpz.oauth.models import AccessToken

from data.models.mcp import MCPAccessPolicy


def policy_for(request):
    """Recheck credential validity and consent inside each tool transaction."""
    now = timezone.now()
    credential = request.mcp_token
    qs = MCPAccessPolicy.objects.select_for_update().filter(revoked_at__isnull=True)
    if isinstance(credential, Token):
        return qs.filter(
            token_id=credential.pk,
            token__revoked_at__isnull=True,
            token__expires_at__gt=now,
            token__user__is_active=True,
        ).first()
    if not isinstance(credential, AccessToken) or credential.code_id is None:
        return None
    valid = AccessToken.objects.filter(
        pk=credential.pk,
        code_id=credential.code_id,
        revoked_at__isnull=True,
        expires_at__gt=now,
        user__is_active=True,
    ).exists()
    if not valid:
        return None
    policy = qs.filter(
        oauth_code_id=credential.code_id,
        oauth_code__user_id=credential.user_id,
        oauth_code__client_id=credential.client_id,
    ).first()
    if policy is not None:
        # The package stores scopes but doesn't enforce them. A policy change
        # may narrow consent, never enlarge it beyond this token's actual scope.
        policy.capabilities = sorted(
            set(policy.capabilities) & set(credential.scope.split())
        )
    return policy


def authenticate(request):
    request.workspace = request.membership = None
    if token_auth(request) is not None:
        rejected = oauth_auth(request)
        if rejected is not None:
            return rejected
    with transaction.atomic():
        policy = policy_for(request)
        if policy is None:
            return HttpResponse(status=403)
        now = timezone.now()
        if now - policy.rate_window >= timedelta(minutes=1):
            policy.rate_window, policy.rate_count = now, 0
        if policy.rate_count >= settings.MCP_RATE_LIMIT:
            return HttpResponse(status=429, headers={"Retry-After": "60"})
        policy.rate_count += 1
        policy.save(update_fields=["rate_window", "rate_count"])
    request.mcp_policy = policy
    return None
