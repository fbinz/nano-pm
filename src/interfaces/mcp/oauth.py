"""django-mcpz OAuth protocol, with explicit workspace/capability consent."""

import copy
import json
from functools import wraps
from urllib.parse import parse_qs, urlsplit

from django.conf import settings
from django.contrib.auth.decorators import login_not_required, login_required
from django.db import transaction
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.translation import gettext as _, gettext_lazy
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_exempt, csrf_protect
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables
from django.views.decorators.http import require_http_methods
from django_mcpz.oauth import views
from django_mcpz.oauth.conf import is_secure_url
from django_mcpz.oauth.discovery import canonical
from django_mcpz.oauth.models import AccessToken, AuthorizationCode, RefreshToken
from django_mcpz.tokens import sha256_hex

from data.models import Membership, MCPAccessPolicy, WorkspaceRole
from data.models.mcp import MCP_CAPABILITIES

CAPABILITY_LABELS = {
    "core.read": gettext_lazy("Read project data"),
    "core.write": gettext_lazy("Change project data"),
    "workspace.admin": gettext_lazy("Manage workspace settings and roles"),
    "workload.self": gettext_lazy("Read and submit your workload"),
    "workload.manage": gettext_lazy("Manage workload reports and settings"),
    "sharing.links": gettext_lazy("Reveal invitation and public roadmap links"),
    "workspace.create": gettext_lazy("Create workspaces"),
}
DEFAULT_SCOPES = ("core.read", "core.write")


def bounded(view):
    """Public protocol endpoints need proxy rate limiting as well as body bounds."""

    @wraps(view)
    @sensitive_variables()
    def wrapped(request, *args, **kwargs):
        if not is_secure_url(request.build_absolute_uri()):
            return JsonResponse(
                {"error": "invalid_request", "error_description": "HTTPS is required."},
                status=400,
            )
        try:
            length = int(request.META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            return HttpResponse(status=400)
        if (
            length > settings.MCP_MAX_BODY_BYTES
            or len(request.body) > settings.MCP_MAX_BODY_BYTES
        ):
            return HttpResponse(status=413)
        response = view(request, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        # Same-origin preserves Origin/Referer for CSRF-checked consent forms,
        # while still withholding the authorization query from remote callbacks.
        response["Referrer-Policy"] = "same-origin"
        return response

    return wrapped


@login_not_required
@csrf_exempt
@bounded
@sensitive_post_parameters()
def authorize(request):
    # OAuth permits a client to POST the authorization request itself without
    # CSRF, but accepting/rejecting consent always goes through csrf_protect.
    if request.method == "POST" and "decision" not in request.POST:
        return views.authorize(request)
    return consent(request)


@csrf_protect
@sensitive_variables()
def consent(request):
    if not request.user.is_authenticated:
        return views.authorize(request)
    members = list(
        Membership.objects.filter(user=request.user)
        .select_related("workspace")
        .order_by("workspace__name", "id")
    )
    requested = set(request.GET.get("scope", "").split()) or set(DEFAULT_SCOPES)
    errors = []
    if requested - set(MCP_CAPABILITIES):
        errors.append(_("This client requested unsupported permissions."))
    allowed = set(MCP_CAPABILITIES)
    if not any(m.role == WorkspaceRole.PM for m in members):
        allowed -= {"workspace.admin", "workload.manage", "sharing.links"}
    choices = requested & allowed
    selected_caps = (
        set(request.POST.getlist("capability"))
        if request.method == "POST"
        else set(DEFAULT_SCOPES) & choices
    )
    selected_ws = request.POST.getlist("workspace") if request.method == "POST" else []
    if request.method == "POST" and request.POST.get("decision") == "allow":
        member_ids = {str(m.workspace_id) for m in members}
        if not selected_caps or not selected_caps <= choices:
            errors.append(_("Choose only the requested permissions available to you."))
        if not set(selected_ws) <= member_ids or len(selected_ws) != len(
            set(selected_ws)
        ):
            errors.append(_("Choose only workspaces you belong to."))
        if not selected_ws and selected_caps != {"workspace.create"}:
            errors.append(_("Choose at least one workspace."))
        expected_resource = canonical(request.build_absolute_uri(reverse("mcp")))
        try:
            matching_resource = (
                canonical(request.GET.get("resource", "")) == expected_resource
            )
        except ValueError:
            matching_resource = False
        if not matching_resource:
            errors.append(_("The requested MCP resource does not match this site."))
    request.mcp_oauth_workspaces = [
        {
            "id": str(m.workspace_id),
            "name": m.workspace.name,
            "selected": str(m.workspace_id) in selected_ws,
        }
        for m in members
    ]
    request.mcp_oauth_capabilities = [
        {"id": cap, "label": CAPABILITY_LABELS[cap], "selected": cap in selected_caps}
        for cap in MCP_CAPABILITIES
        if cap in choices
    ]
    request.mcp_oauth_errors = errors
    # Delegate client/redirect/resource/PKCE validation and code generation to
    # django-mcpz. Never trust an unvalidated redirect URI or implement PKCE here.
    delegated = copy.copy(request)
    if request.method == "POST" and request.POST.get("decision") == "allow":
        if errors:
            delegated.method = "GET"
            response = views.authorize(delegated)
            if response.status_code == 200:
                response.status_code = 400
            return response
        delegated.GET = request.GET.copy()
        delegated.GET["scope"] = " ".join(sorted(selected_caps))
        with transaction.atomic():
            # Serialize consent with membership changes on SQLite as well.
            current = set(
                Membership.objects.filter(
                    user=request.user, workspace_id__in=selected_ws
                ).values_list("workspace_id", flat=True)
            )
            if current != {int(pk) for pk in selected_ws}:
                return HttpResponse(status=403)
            response = views.authorize(delegated)
            if response.status_code == 302:
                code_value = parse_qs(urlsplit(response["Location"]).query).get(
                    "code", [None]
                )[0]
                if code_value:
                    code = AuthorizationCode.objects.get(
                        digest=sha256_hex(code_value), user=request.user
                    )
                    policy = MCPAccessPolicy.objects.create(
                        oauth_code=code, capabilities=sorted(selected_caps)
                    )
                    policy.workspaces.set(current)
            return response
    return views.authorize(delegated)


@login_not_required
@csrf_exempt
@bounded
@sensitive_post_parameters()
@sensitive_variables()
def token(request):
    # A code family, not an hourly access token, owns consent and retry state.
    # Serialize checks, vendor issuance and optional scope narrowing together.
    with transaction.atomic():
        source = None
        narrowed = None
        if request.method == "POST":
            params = request.POST
            if params.get("grant_type") == "authorization_code":
                source = (
                    AuthorizationCode.objects.select_related("client")
                    .filter(digest=sha256_hex(params.get("code", "")))
                    .first()
                )
                code_id = source.pk if source else None
            elif params.get("grant_type") == "refresh_token":
                source = (
                    RefreshToken.objects.select_related("client")
                    .filter(digest=sha256_hex(params.get("refresh_token", "")))
                    .first()
                )
                code_id = source.code_id if source else None
                if source is not None and source.client.client_id != params.get(
                    "client_id"
                ):
                    return views.token(request)
                if source is not None and source.used_at is None and "scope" in params:
                    selected = set(params["scope"].split())
                    if not selected or not selected <= set(source.scope.split()):
                        return views.token_error(
                            "invalid_scope", "Refresh cannot expand the granted scope."
                        )
                    narrowed = " ".join(sorted(selected))
            else:
                code_id = None
            if source is not None and source.client.client_id != params.get(
                "client_id"
            ):
                return views.token(request)
            if (
                source is not None
                and not MCPAccessPolicy.objects.filter(
                    oauth_code_id=code_id, revoked_at__isnull=True
                ).exists()
            ):
                return views.token_error(
                    "invalid_grant", "Consent is missing or revoked."
                )
        response = views.token(request)
        if response.status_code == 200 and narrowed is not None:
            body = json.loads(response.content)
            AccessToken.objects.filter(digest=sha256_hex(body["access_token"])).update(
                scope=narrowed
            )
            RefreshToken.objects.filter(
                digest=sha256_hex(body["refresh_token"])
            ).update(scope=narrowed)
            body["scope"] = narrowed
            return JsonResponse(body)
        return response


register = bounded(views.register)
revoke = bounded(views.revoke)


@login_not_required
@bounded
def resource_metadata(request, resource_path=""):
    response = views.protected_resource_metadata(request, resource_path)
    data = json.loads(response.content)
    data["scopes_supported"] = list(MCP_CAPABILITIES)
    return JsonResponse(data)


@login_not_required
@bounded
def server_metadata(request, issuer_path=""):
    response = views.authorization_server_metadata(request, issuer_path)
    data = json.loads(response.content)
    data["scopes_supported"] = list(MCP_CAPABILITIES)
    return JsonResponse(data)


@login_required
@require_http_methods(["GET", "POST"])
@never_cache
def connections(request):
    if request.method == "POST":
        raw_id = request.POST.get("policy_id", "")
        if not (raw_id.isascii() and raw_id.isdecimal() and len(raw_id) <= 19):
            raise Http404
        policy_id = int(raw_id)
        if not 0 < policy_id <= 2**63 - 1:
            raise Http404
        with transaction.atomic():
            policy = (
                MCPAccessPolicy.objects.select_for_update()
                .filter(
                    pk=policy_id,
                    oauth_code__user=request.user,
                )
                .first()
            )
            if policy is None:
                raise Http404
            policy.revoked_at = timezone.now()
            policy.save(update_fields=["revoked_at"])
            policy.oauth_code.revoke_family()
        return redirect("mcp_connections")
    policies = (
        MCPAccessPolicy.objects.filter(
            oauth_code__user=request.user, revoked_at__isnull=True
        )
        .select_related("oauth_code__client")
        .prefetch_related("workspaces")
        .order_by("-pk")
    )
    return render(request, "accounts/mcp-connections.html", {"policies": policies})
