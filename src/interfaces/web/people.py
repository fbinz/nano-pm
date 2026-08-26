"""People and teams endpoints — page + CRUD."""

from django.contrib.auth.decorators import login_required
from django.db.models import OuterRef, Subquery
from django.http import HttpRequest
from django.shortcuts import render
from django.utils.translation import gettext as _
from django.views.decorators.http import require_http_methods

from datastar_py.consts import ElementPatchMode
from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from actions.manage_people import (
    LastManagerError, create_person, update_person, delete_person,
    get_or_create_person_invite, set_person_role,
)
from actions.manage_teams import create_team, update_team, delete_team, set_person_teams
from data.models import Membership, Person, Team

from .helpers import is_pm, patch_chart, pm_required, workspace_context


def _people_queryset(request: HttpRequest):
    workspace_role = Membership.objects.filter(
        workspace=request.workspace,
        user_id=OuterRef("user_id"),
    ).values("role")[:1]
    return (
        Person.objects.filter(workspace=request.workspace)
        .select_related("user")
        .prefetch_related("teams")
        .annotate(workspace_role=Subquery(workspace_role))
    )


def _teams_queryset(request: HttpRequest):
    return Team.objects.filter(workspace=request.workspace)


def patch_add_team_input_clear():
    return SSE.patch_elements(
        '<input class="input input-sm" type="text" name="name" value="" '
        f'placeholder="{_("Add a team…")}" autocomplete="off">',
        selector='.add-team-form input[name="name"]',
        mode=ElementPatchMode.REPLACE,
    )


@login_required
def people_page(request: HttpRequest):
    return render(request, "components/screens/people/index.html", {
        "people": _people_queryset(request),
        "teams": _teams_queryset(request),
        "user": request.user,
        "is_pm": is_pm(request),
        **workspace_context(request),
    })


def patch_people_content(request):
    return SSE.patch_elements(
        render_component(request, "screens/people/people-content",
                         people=_people_queryset(request), teams=_teams_queryset(request),
                         is_pm=is_pm(request))
    )


def patch_people_list(request):
    return patch_people_content(request)


@login_required
@datastar_response
def people_invite_link(request: HttpRequest, person_id: int):
    inv = get_or_create_person_invite(
        workspace=request.workspace, person_id=person_id, actor=request.user
    )
    invite_url = request.build_absolute_uri(f"/invite/{inv.token}/")
    yield SSE.patch_elements(
        render_component(request, "screens/people/invite-reveal",
                         person_name=inv.person.name, invite_url=invite_url)
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_create(request: HttpRequest):
    name = request.POST.get("name", "").strip()
    if not name:
        return
    create_person(workspace=request.workspace, name=name, actor=request.user)
    yield patch_people_content(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_update(request: HttpRequest, person_id: int):
    update_person(
        workspace=request.workspace, person_id=person_id, name=request.POST.get("name", ""),
        actor=request.user,
    )
    yield patch_people_content(request)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_delete(request: HttpRequest, person_id: int):
    delete_person(workspace=request.workspace, person_id=person_id, actor=request.user)
    yield patch_people_content(request)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@pm_required
@datastar_response
def person_role_update(request: HttpRequest, person_id: int):
    try:
        membership = set_person_role(
            workspace=request.workspace,
            person_id=person_id,
            role=request.POST.get("role", ""),
            actor=request.user,
        )
    except LastManagerError:
        membership = None
    if membership is not None and membership.user_id == request.user.id:
        request.membership.role = membership.role
    yield patch_people_content(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def person_teams_update(request: HttpRequest, person_id: int):
    team_ids = [int(x) for x in request.POST.getlist("team_ids") if x.isdigit()]
    set_person_teams(workspace=request.workspace, person_id=person_id, team_ids=team_ids, actor=request.user)
    yield patch_people_content(request)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def team_create(request: HttpRequest):
    name = request.POST.get("name", "").strip()
    team = create_team(workspace=request.workspace, name=name, actor=request.user) if name else None
    yield patch_people_content(request)
    if team is not None:
        yield patch_add_team_input_clear()
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def team_update(request: HttpRequest, team_id: int):
    update_team(workspace=request.workspace, team_id=team_id, name=request.POST.get("name", ""), actor=request.user)
    yield patch_people_content(request)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def team_delete(request: HttpRequest, team_id: int):
    delete_team(workspace=request.workspace, team_id=team_id, actor=request.user)
    yield patch_people_content(request)
    yield patch_chart(request)
