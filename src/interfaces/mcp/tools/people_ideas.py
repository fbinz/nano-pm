"""People/team administration, explicit self-service roles and idea promotion."""

from django.db.models import Q

from actions import manage_ideas as ideas
from actions import manage_people as people
from actions import manage_teams as teams
from data.models import Idea, Membership, Person, Project, Team
from readers import mcp as view

from .. import schemas as s
from ..common import (
    dates,
    lookup,
    manage_project,
    match,
    name,
    page,
    patch,
    related,
    require,
)
from ..registry import tool


@tool(s.PeoplePage)
def list_people(r, p):
    """List minimal assignment identities, optionally filtered by team/account linkage."""
    qs = Person.objects.filter(workspace=r.workspace).order_by("id")
    if p.search:
        qs = qs.filter(name__icontains=p.search)
    if p.team_id:
        lookup(Team, p.team_id, r.workspace)
        qs = qs.filter(teams=p.team_id)
    if p.linked is not None:
        qs = qs.filter(user__isnull=not p.linked)
    return page(r, qs.distinct(), p, view.person)


@tool(s.ObjectParams)
def get_person(r, p):
    """Read a person's assignment identity/team IDs; never contact addresses."""
    return {"item": view.person(lookup(Person, p.id, r.workspace))}


@tool(s.PersonCreate, cap="core.write", pm=True, mutation=True)
def create_person(r, p):
    """Create a planning person and team assignments, not a login account."""
    related(Team, p.team_ids, r.workspace)
    obj = people.create_person(workspace=r.workspace, name=name(p.name), actor=r.user)
    teams.set_person_teams(
        workspace=r.workspace, person_id=obj.pk, team_ids=p.team_ids, actor=r.user
    )
    return {"item": view.person(obj)}


@tool(s.PersonUpdate, cap="core.write", pm=True, mutation=True)
def update_person(r, p):
    """Atomically patch a planning person's name and/or complete team-ID set."""
    obj = lookup(Person, p.id, r.workspace)
    match(p, view.person(obj))
    values = patch(p, "name team_ids")
    if "team_ids" in values:
        related(Team, values["team_ids"], r.workspace)
    if "name" in values:
        people.update_person(
            workspace=r.workspace, person_id=obj.pk, name=values["name"], actor=r.user
        )
    if "team_ids" in values:
        teams.set_person_teams(
            workspace=r.workspace,
            person_id=obj.pk,
            team_ids=values["team_ids"],
            actor=r.user,
        )
    obj.refresh_from_db()
    return {"item": view.person(obj)}


@tool(s.ObjectChange, cap="core.write", pm=True, mutation=True, destructive=True)
def delete_person(r, p):
    """Remove a planning person and assignments/responsibilities; does not delete their user or membership."""
    obj = lookup(Person, p.id, r.workspace)
    match(p, view.person(obj))
    summary = {
        "assignment_count": obj.tasks.count(),
        "responsibility_count": obj.responsible_projects.count(),
    }
    people.delete_person(workspace=r.workspace, person_id=p.id, actor=r.user)
    return {"deleted_ids": [p.id], **summary}


@tool(s.SearchPage)
def list_teams(r, p):
    """List teams and bounded member-ID summaries."""
    qs = Team.objects.filter(workspace=r.workspace).order_by("id")
    if p.search:
        qs = qs.filter(name__icontains=p.search)
    return page(r, qs, p, view.team)


@tool(s.TeamCreate, cap="core.write", pm=True, mutation=True)
def create_team(r, p):
    """Create a uniquely named workspace team."""
    obj = teams.create_team(workspace=r.workspace, name=name(p.name), actor=r.user)
    require(obj is not None, "conflict", "Team name already exists.")
    return {"item": view.team(obj)}


@tool(s.TeamUpdate, cap="core.write", pm=True, mutation=True)
def update_team(r, p):
    """Rename a team with a revision from list_teams."""
    obj = lookup(Team, p.id, r.workspace)
    match(p, view.team(obj))
    obj = teams.update_team(
        workspace=r.workspace, team_id=p.id, name=name(p.name), actor=r.user
    )
    require(obj is not None, "conflict", "Team name already exists.")
    return {"item": view.team(obj)}


@tool(s.ObjectChange, cap="core.write", pm=True, mutation=True, destructive=True)
def delete_team(r, p):
    """Delete a team, detaching its people without deleting them."""
    obj = lookup(Team, p.id, r.workspace)
    match(p, view.team(obj))
    count = obj.people.count()
    teams.delete_team(workspace=r.workspace, team_id=p.id, actor=r.user)
    return {"deleted_ids": [p.id], "detached_people_count": count}


@tool(s.Page, cap="workspace.admin", pm=True)
def list_memberships(r, p):
    """List membership IDs/roles/participation, not personal contact information; PM only."""
    return page(
        r,
        Membership.objects.filter(workspace=r.workspace)
        .select_related("user")
        .order_by("id"),
        p,
        view.membership,
    )


@tool(s.RoleUpdate, cap="workspace.admin", pm=True, mutation=True, destructive=True)
def set_member_role(r, p):
    """Set pm/member role by membership ID, including users without a Person; cannot demote the last PM."""
    obj = lookup(Membership, p.id, r.workspace)
    match(p, view.membership(obj))
    try:
        obj = people.set_membership_role(
            workspace=r.workspace, membership_id=p.id, role=p.role, actor=r.user
        )
    except people.LastManagerError:
        require(False, "validation_error", "Cannot demote the last PM.")
    require(obj is not None, "not_found", "Membership not found.")
    return {"item": view.membership(obj)}


@tool(
    s.ObjectChange,
    cap="workspace.admin",
    pm=True,
    extra_caps=("sharing.links",),
    mutation=True,
    destructive=True,
)
def create_person_invite(r, p):
    """Explicitly reveal/get-create a sensitive invitation link for a planning person; do not share without approval."""
    obj = lookup(Person, p.id, r.workspace)
    match(p, view.person(obj))
    invite = people.get_or_create_person_invite(
        workspace=r.workspace, person_id=p.id, actor=r.user
    )
    return {
        "link_reference": {
            "kind": "invite",
            "id": invite.pk,
            "version": view.fingerprint(invite.token),
        }
    }


@tool(s.IdeaPage, idea_action="view")
def list_ideas(r, p):
    """List permitted idea summaries, optionally filtered by text/status/tag."""
    qs = Idea.objects.filter(workspace=r.workspace).order_by("id")
    if p.search:
        qs = qs.filter(Q(title__icontains=p.search) | Q(body__icontains=p.search))
    if p.status:
        qs = qs.filter(status=p.status)
    if p.tag:
        qs = qs.filter(tags__icontains=p.tag)
    return page(r, qs, p, lambda obj: view.idea(obj, False))


@tool(s.ObjectParams, idea_action="view")
def get_idea(r, p):
    """Read permitted idea details and conversion references."""
    return {"item": view.idea(lookup(Idea, p.id, r.workspace))}


@tool(s.IdeaCreate, cap="core.write", idea_action="add", mutation=True)
def create_idea(r, p):
    """Create an idea with the authenticated caller as creator."""
    obj = ideas.create_idea(
        workspace=r.workspace, creator=r.user, title=name(p.title), actor=r.user
    )
    obj = ideas.update_idea(
        workspace=r.workspace, idea_id=obj.pk, body=p.body, tags=p.tags, actor=r.user
    )
    return {"item": view.idea(obj)}


@tool(s.IdeaUpdate, cap="core.write", idea_action="change", mutation=True)
def update_idea(r, p):
    """Patch idea content/status/tags; conversion links require the explicit conversion tools."""
    obj = lookup(Idea, p.id, r.workspace)
    match(p, view.idea(obj))
    values = patch(p, "title body status tags")
    if values.get("status") == "converted":
        require(
            obj.converted_project_id or obj.converted_task_id,
            "validation_error",
            "Use a conversion tool to create the planned object.",
        )
    obj = ideas.update_idea(workspace=r.workspace, idea_id=p.id, actor=r.user, **values)
    return {"item": view.idea(obj)}


def convertible(r, p):
    obj = lookup(Idea, p.id, r.workspace)
    match(p, view.idea(obj))
    require(
        not obj.converted_project_id
        and not obj.converted_task_id
        and obj.status != "converted",
        "conflict",
        "Idea has already been converted.",
    )
    return obj


@tool(s.ConvertProject, cap="core.write", pm=True, idea_action="change", mutation=True)
def convert_idea_to_project(r, p):
    """Atomically promote an unconverted idea to a project and copy its body; PM only."""
    convertible(r, p)
    obj = ideas.convert_idea_to_project(
        workspace=r.workspace,
        idea_id=p.id,
        name=None if p.name is s.UNSET else name(p.name),
        actor=r.user,
    )
    return {"item": view.idea(obj), "project": view.project(obj.converted_project)}


@tool(
    s.ConvertTask,
    cap="core.write",
    idea_action="change",
    mutation=True,
    scheduling=True,
)
def convert_idea_to_task(r, p):
    """Atomically promote an unconverted idea into a target-project task with copied body."""
    convertible(r, p)
    dates(p.start, p.end)
    manage_project(r, lookup(Project, p.project_id, r.workspace))
    obj = ideas.create_task_from_idea(
        workspace=r.workspace,
        idea_id=p.id,
        project_id=p.project_id,
        title="" if p.title is s.UNSET else name(p.title),
        start=p.start,
        end=p.end,
        actor=r.user,
    )
    require(
        obj.converted_task_id is not None, "validation_error", "Could not create task."
    )
    obj.converted_task.refresh_from_db()
    return {"item": view.idea(obj), "task": view.task(obj.converted_task)}


@tool(
    s.ObjectChange,
    cap="core.write",
    idea_action="delete",
    mutation=True,
    destructive=True,
)
def delete_idea(r, p):
    """Delete an idea without deleting its previously converted project/task."""
    obj = lookup(Idea, p.id, r.workspace)
    match(p, view.idea(obj))
    ideas.delete_idea(workspace=r.workspace, idea_id=p.id, actor=r.user)
    return {"deleted_ids": [p.id]}
