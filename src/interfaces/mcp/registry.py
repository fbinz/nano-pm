"""Registration with a single authorization/transaction boundary for every tool."""

import logging
import time
from datetime import timedelta
from functools import wraps

import msgspec
from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist, PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from django_mcpz.server import ToolError

from data.models import Invitation, MCPMutationReceipt, Workspace
from .auth import policy_for
from permissions import has_idea_perm, is_pm
from readers.mcp import fingerprint, schedule_effects, schedule_state

from .common import fail, has_cap, replay_guards, require, scope, visible
from .server import server
from .outputs import OUTPUTS

logger = logging.getLogger("interfaces.mcp")


def sensitive_link(request, reference):
    if reference["kind"] == "invite":
        obj = Invitation.objects.filter(
            pk=reference["id"], workspace=request.workspace
        ).first()
        require(obj is not None, "not_found", "Invitation no longer exists.")
        token = obj.token
        path = f"/invite/{token}/"
    else:
        obj = Workspace.objects.get(pk=request.workspace.pk)
        require(
            obj.public_roadmap_enabled,
            "feature_disabled",
            "Public roadmap is disabled.",
        )
        token = obj.public_roadmap_token
        path = f"/roadmap/{token}/"
    require(
        fingerprint(token) == reference["version"],
        "conflict",
        "This link has changed. Read its current value.",
    )
    return {"url": request.build_absolute_uri(path)}


def refresh_identity(request):
    # Recheck inside the write transaction too: a concurrent revoke/policy edit
    # must not race the initial bearer authentication.
    policy = policy_for(request)
    require(policy is not None)
    request.mcp_policy = policy


def tool(
    schema,
    *,
    cap="core.read",
    pm=False,
    mutation=False,
    global_=False,
    destructive=False,
    scheduling=False,
    idea_action=None,
    anycaps=(),
    extra_caps=(),
    participant=False,
    description=None,
):
    caps = anycaps or (cap,)

    def decorate(func):
        def permitted(request):
            if not all(has_cap(request, c) for c in extra_caps):
                return False
            if global_:
                return any(has_cap(request, c) for c in caps) if cap else True
            return visible(request, caps, pm, idea_action)

        @wraps(func)
        @sensitive_variables()
        def run(request, params):
            started = time.monotonic()
            outcome = "error"
            request.mcp_tool, request.mcp_guards = func.__name__, []
            try:
                # Reads also get a consistent snapshot. SQLite BEGIN IMMEDIATE
                # serializes revision checks, receipt insertion and writes.
                with transaction.atomic():
                    refresh_identity(request)
                    require(permitted(request))
                    if not global_:
                        scope(request, params.workspace_id)
                        if pm:
                            require(is_pm(request))
                        if idea_action:
                            require(has_idea_perm(request, idea_action))
                        if participant:
                            require(
                                request.membership.can_report_workload,
                                "feature_disabled",
                                "Workload reporting is unavailable for this membership.",
                            )
                    if not mutation:
                        result = func(request, params)
                    else:
                        workspace_key = getattr(params, "workspace_id", 0)
                        arguments_hash = fingerprint(msgspec.to_builtins(params))
                        receipt = MCPMutationReceipt.objects.filter(
                            policy=request.mcp_policy,
                            tool=func.__name__,
                            workspace_key=workspace_key,
                            operation_id=params.operation_id,
                        ).first()
                        if receipt:
                            require(
                                receipt.created_at > timezone.now() - timedelta(days=7),
                                "conflict",
                                "Replay window expired. Inspect current state before submitting another operation.",
                            )
                            require(
                                receipt.arguments_hash == arguments_hash,
                                "conflict",
                                "Operation ID was already used with different arguments.",
                            )
                            replay_guards(request, receipt.result.get("guards", []))
                            result = receipt.result["output"]
                            if func.__name__ == "create_workspace":
                                scope(request, result["item"]["id"])
                        else:
                            before = (
                                schedule_state(request.workspace)
                                if scheduling
                                else None
                            )
                            result = func(request, params)
                            if scheduling:
                                result["effects"] = schedule_effects(
                                    before, schedule_state(request.workspace)
                                )
                            # Normalize and size-check before commit, so a failed
                            # serialization cannot leave a successful hidden write.
                            result = msgspec.json.decode(msgspec.json.encode(result))
                            require(
                                len(msgspec.json.encode(result))
                                < settings.MCP_MAX_RESPONSE_BYTES // 3,
                                "validation_error",
                                "Result too large; use a smaller operation.",
                            )
                            MCPMutationReceipt.objects.create(
                                policy=request.mcp_policy,
                                tool=func.__name__,
                                workspace_key=workspace_key,
                                operation_id=params.operation_id,
                                arguments_hash=arguments_hash,
                                result={"output": result, "guards": request.mcp_guards},
                            )
                    if "link_reference" in result:
                        result = sensitive_link(request, result["link_reference"])
                    result = msgspec.json.decode(msgspec.json.encode(result))
                    try:
                        validated = msgspec.convert(result, OUTPUTS[func.__name__])
                        if validated != result:
                            raise msgspec.ValidationError("Unexpected output fields")
                    except msgspec.ValidationError:
                        logger.error("tool=%s invalid_output_schema", func.__name__)
                        fail(
                            "internal_error",
                            "The operation returned an invalid result.",
                        )
                    outcome = "ok"
                    return result
            except ToolError:
                raise
            except ValidationError as exc:
                fail("validation_error", " ".join(exc.messages))
            except PermissionDenied:
                fail("forbidden", "This operation is not permitted.")
            except ObjectDoesNotExist:
                fail("not_found", "Object not found.")
            except IntegrityError:
                fail("conflict", "This change conflicts with existing data.")
            except (OverflowError, ValueError):
                fail("validation_error", "Value is outside the supported range.")
            except Exception as exc:
                # Do not hand unexpected exceptions to mcpz/Sentry with raw
                # arguments or frame locals. Operators have the redacted call ID.
                logger.error(
                    "tool=%s exception_type=%s", func.__name__, type(exc).__name__
                )
                fail("internal_error", "The operation could not be completed.")
            finally:
                logger.info(
                    "tool=%s actor=%s policy=%s workspace=%s outcome=%s duration_ms=%.1f",
                    func.__name__,
                    request.user.pk,
                    request.mcp_policy.pk,
                    getattr(params, "workspace_id", 0),
                    outcome,
                    (time.monotonic() - started) * 1000,
                )

        server.tool(
            name=func.__name__,
            description=description or func.__doc__ or func.__name__,
            input_schema=schema,
            output_schema=OUTPUTS[func.__name__],
            read_only=not mutation,
            destructive=destructive,
            idempotent=mutation,
            open_world=False,
            permission=permitted,
        )(run)
        return run

    return decorate
