"""People endpoints — page + CRUD."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest
from django.shortcuts import render
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from actions.manage_people import (
    create_person, update_person, delete_person, get_or_create_person_invite,
)
from data.models import Person

from .helpers import is_pm, patch_chart, workspace_context


@login_required
def people_page(request: HttpRequest):
    people = Person.objects.filter(workspace=request.workspace).select_related("user")
    return render(request, "components/screens/people/index.html", {
        "people": people,
        "user": request.user,
        "is_pm": is_pm(request),
        **workspace_context(request),
    })


def patch_people_list(request):
    people = Person.objects.filter(workspace=request.workspace).select_related("user")
    return SSE.patch_elements(
        render_component(request, "screens/people/people-list",
                         people=people, is_pm=is_pm(request))
    )


@login_required
@datastar_response
def people_invite_link(request: HttpRequest, person_id: int):
    inv = get_or_create_person_invite(
        workspace=request.workspace, person_id=person_id
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
    create_person(workspace=request.workspace, name=name)
    yield patch_people_list(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_update(request: HttpRequest, person_id: int):
    update_person(
        workspace=request.workspace, person_id=person_id, name=request.POST.get("name", "")
    )
    yield patch_people_list(request)
    yield patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_delete(request: HttpRequest, person_id: int):
    delete_person(workspace=request.workspace, person_id=person_id)
    yield patch_people_list(request)
    yield patch_chart(request)
