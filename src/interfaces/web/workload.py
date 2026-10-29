"""Workspace workload settings, personal estimates and PM summaries."""

from datetime import timedelta
from functools import wraps

from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import HttpResponse, HttpResponseBadRequest
from django.shortcuts import redirect, render
from django.utils import timezone
from django.utils.translation import gettext as _
from django.views.decorators.http import require_http_methods
from datastar_py.consts import ElementPatchMode
from datastar_py.django import ServerSentEventGenerator as SSE, DatastarResponse
from django_cotton import render_component

from actions.manage_workload import (
    configure,
    configure_category,
    delete_category,
    participates,
    set_participation,
    submit,
)
from data.models import Membership, Person, WorkloadCategory
from readers.workload import overview, personal
from .helpers import is_pm, pm_required, workspace_context


def participant_required(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not participates(request.membership):
            return HttpResponse(status=403)
        return view(request, *args, **kwargs)

    return wrapped


def context(request):
    return {"user": request.user, "is_pm": is_pm(request), **workspace_context(request)}


def identifier(value):
    if len(str(value)) > 19 or not str(value).isascii() or not str(value).isdecimal():
        raise ValidationError(_("Invalid identifier."))
    return int(value)


def settings_options(workspace):
    return [
        {
            "name": name,
            "label": label,
            "enabled": getattr(workspace, name),
            "help": _(
                "Show a dialog when an estimate is missing or due for renewal. "
                "Manual updates remain available."
            ) if name == "workload_checkin_enabled" else "",
        }
        for name, label in [
            ("workload_enabled", _("Enable workload reporting")),
            ("workload_members_included", _("Include members by default")),
            ("workload_pms_included", _("Include PMs by default")),
            ("workload_checkin_enabled", _("Show automatic workload check-in dialogs")),
        ]
    ]


def settings_context(workspace):
    return {
        "options": settings_options(workspace),
        "categories": WorkloadCategory.objects.filter(workspace=workspace),
        "memberships": Membership.objects.filter(workspace=workspace)
        .select_related("user")
        .order_by("user__username"),
    }


@login_required
@pm_required
@require_http_methods(["GET", "POST"])
def settings(request):
    if request.method == "GET":
        return redirect("workspace_settings")
    error = ""
    if request.method == "POST":
        try:
            action = request.POST.get("action", "settings")
            if action == "settings":
                configure(
                    workspace=request.workspace, actor=request.user, data=request.POST
                )
            elif action == "category":
                data = request.POST.copy()
                if data.get("category_id"):
                    data["category_id"] = str(identifier(data["category_id"]))
                configure_category(
                    workspace=request.workspace, actor=request.user, data=data
                )
            elif action == "participation":
                set_participation(
                    workspace=request.workspace,
                    actor=request.user,
                    membership_id=identifier(request.POST.get("membership_id")),
                    value=request.POST.get("participation"),
                )
            else:
                raise ValidationError(_("Unknown setting."))
        except ValidationError as exc:
            error = " ".join(exc.messages)
        else:
            return redirect("workspace_settings")
    from .gitlab import settings_context as gitlab_settings_context

    return render(
        request,
        "components/screens/workspaces/settings.html",
        {**context(request), **settings_context(request.workspace),
         **gitlab_settings_context(request.workspace), "error": error},
    )


@login_required
@pm_required
@require_http_methods(["POST"])
def setting_update(request, setting):
    try:
        configure(
            workspace=request.workspace,
            actor=request.user,
            data=request.POST,
            setting=setting,
        )
    except ValidationError:
        return HttpResponseBadRequest()
    request.workspace.refresh_from_db()
    if setting == "workload_checkin_interval_days":
        option = {"label": _("Workload check-in interval")}
    else:
        option = next(
            option
            for option in settings_options(request.workspace)
            if option["name"] == setting
        )
    if setting in {"workload_enabled", "workload_checkin_enabled"}:
        fragment = render_component(
            request,
            "screens/workload/configuration",
            workspace=request.workspace,
            **settings_context(request.workspace),
        )
    elif setting == "workload_checkin_interval_days":
        fragment = render_component(
            request, "screens/workload/cadence", workspace=request.workspace
        )
    else:
        fragment = render_component(
            request, "screens/workload/setting-toggle", option=option
        )
    patches = [
        SSE.patch_elements(fragment),
        SSE.patch_elements(
            render_component(
                request,
                "screens/workload/settings-saved-toast",
                option=option,
            )
        ),
        SSE.patch_elements(
            render_component(
                request,
                "screens/workload/overview-nav",
                workspace=request.workspace,
                active_nav="workspace-settings",
            )
        ),
    ]
    if setting in {"workload_enabled", "workload_checkin_enabled"} and not option["enabled"]:
        patches.append(SSE.patch_elements(render_component(
            request, "screens/workload/checkin-finished"
        )))
    return DatastarResponse(patches)


@login_required
@pm_required
@require_http_methods(["POST"])
def participation_update(request, membership_id):
    membership = (
        Membership.objects.filter(
            workspace=request.workspace,
            pk=membership_id,
        )
        .select_related("user")
        .first()
    )
    if membership is None:
        return HttpResponse(status=404)
    try:
        set_participation(
            workspace=request.workspace,
            actor=request.user,
            membership_id=membership.id,
            value=request.POST.get("participation"),
        )
    except ValidationError:
        return HttpResponseBadRequest()
    membership.refresh_from_db()
    patches = [
        SSE.patch_elements(
            render_component(
                request,
                "screens/workload/participation-row",
                membership=membership,
            )
        ),
        SSE.patch_elements(
            render_component(
                request,
                "screens/workload/participation-saved-toast",
                membership=membership,
            )
        ),
    ]
    return DatastarResponse(patches)


@login_required
@pm_required
@require_http_methods(["POST"])
def category_create(request):
    data = request.POST.copy()
    data.pop("category_id", None)
    try:
        category = configure_category(
            workspace=request.workspace,
            actor=request.user,
            data=data,
        )
    except ValidationError as exc:
        return DatastarResponse(
            SSE.patch_elements(
                render_component(
                    request,
                    "screens/workload/category-status",
                    category_id="new",
                    error=" ".join(exc.messages),
                )
            )
        )
    return DatastarResponse(
        [
            SSE.patch_elements(
                render_component(
                    request, "screens/workload/category-row", category=category
                ),
                selector="#workload-categories-body",
                mode=ElementPatchMode.APPEND,
            ),
            SSE.patch_elements(
                render_component(
                    request,
                    "screens/workload/category-saved-toast",
                    category=category,
                )
            ),
            SSE.patch_elements(
                render_component(request, "screens/workload/category-new-row"),
                selector="#workload-new-category",
                mode=ElementPatchMode.REPLACE,
            ),
        ]
    )


@login_required
@pm_required
@require_http_methods(["POST"])
def category_update(request, category_id):
    category = WorkloadCategory.objects.filter(
        workspace=request.workspace,
        pk=category_id,
    ).first()
    if category is None:
        return HttpResponse(status=404)
    data = request.POST.copy()
    data["category_id"] = str(category.id)
    try:
        configure_category(workspace=request.workspace, actor=request.user, data=data)
    except ValidationError as exc:
        # Keep the draft inputs intact so the user can correct the failing cell.
        fragment = render_component(
            request,
            "screens/workload/category-status",
            category_id=category.id,
            error=" ".join(exc.messages),
        )
        return DatastarResponse(SSE.patch_elements(fragment))

    category.refresh_from_db()
    return DatastarResponse(
        [
            SSE.patch_elements(
                render_component(
                    request,
                    "screens/workload/category-row",
                    category=category,
                )
            ),
            SSE.patch_elements(
                render_component(
                    request,
                    "screens/workload/category-saved-toast",
                    category=category,
                )
            ),
        ]
    )


@login_required
@pm_required
@require_http_methods(["POST"])
def category_delete(request, category_id):
    category = delete_category(
        workspace=request.workspace,
        actor=request.user,
        category_id=category_id,
    )
    if category is None:
        return HttpResponse(status=404)
    return DatastarResponse(
        [
            SSE.patch_elements(
                "",
                selector=f"#workload-category-{category_id}",
                mode=ElementPatchMode.REMOVE,
            ),
            SSE.patch_elements(
                render_component(
                    request,
                    "screens/workload/category-deleted-toast",
                    category=category,
                )
            ),
        ]
    )


@login_required
@require_http_methods(["GET"])
def my_workload(request):
    if not participates(request.membership):
        raise PermissionDenied
    return render(
        request,
        "components/screens/workload/index.html",
        {
            **context(request),
            **personal(request.workspace, request.user),
        },
    )


@login_required
@participant_required
@require_http_methods(["GET"])
def legacy_my_workload(request):
    return redirect("my_workload")


@login_required
@participant_required
@require_http_methods(["POST"])
def save(request):
    error = status = ""
    data = None
    action = request.POST.get("action", "save")
    checkin = action == "checkin"
    try:
        if action not in {"save", "review", "checkin"}:
            raise ValidationError(_("Unknown action."))
        submit(
            workspace=request.workspace,
            user=request.user,
            data=request.POST,
            review=action == "review",
            checkin=checkin,
        )
        status = (
            _("Review date refreshed.") if action == "review" else _("Estimate saved.")
        )
    except ValidationError as exc:
        error = " ".join(exc.messages)
        data = request.POST if action != "review" else None
    if checkin and not error:
        Membership.objects.filter(pk=request.membership.pk).update(workload_snoozed_until=None)
        return checkin_finished(request, status)
    patches = [SSE.patch_elements(render_component(
        request,
        "screens/workload/content",
        **personal(request.workspace, request.user, data, checkin=checkin),
        error=error,
    ))]
    if not error:
        patches.append(SSE.patch_elements(render_component(
            request, "screens/workload/saved-toast", message=status
        )))
    return DatastarResponse(patches)


def checkin_finished(request, message):
    return DatastarResponse([
        SSE.patch_elements(render_component(request, "screens/workload/checkin-finished")),
        SSE.patch_elements(render_component(
            request, "screens/workload/saved-toast", message=message
        )),
    ])


@login_required
@participant_required
@require_http_methods(["POST"])
def checkin_snooze(request):
    Membership.objects.filter(pk=request.membership.pk).update(
        workload_snoozed_until=timezone.now() + timedelta(days=7)
    )
    return checkin_finished(request, _("We’ll remind you next week."))


@login_required
@pm_required
@require_http_methods(["GET"])
def workload_overview(request):
    team_id, user_id = request.GET.get("team", ""), request.GET.get("person", "")
    try:
        for value in (team_id, user_id):
            if value:
                identifier(value)
    except ValidationError:
        return HttpResponseBadRequest()
    return render(
        request,
        "components/screens/workload/overview.html",
        {
            **context(request),
            **overview(request.workspace, team_id, user_id),
        },
    )


@login_required
@pm_required
@require_http_methods(["POST"])
def person_participation(request, person_id):
    from .people import patch_people_content

    person = Person.objects.filter(
        workspace=request.workspace, pk=person_id, user__isnull=False
    ).first()
    membership = (
        Membership.objects.filter(
            workspace=request.workspace, user_id=person.user_id
        ).first()
        if person
        else None
    )
    if membership is None:
        return HttpResponse(status=404)
    try:
        set_participation(
            workspace=request.workspace,
            actor=request.user,
            membership_id=membership.id,
            value=request.POST.get("participation"),
        )
    except ValidationError:
        return HttpResponseBadRequest()
    return DatastarResponse(patch_people_content(request))
