"""People/team administration and explicit self-service roles."""

from actions import manage_people as people
from actions import manage_teams as teams
from data.models import Membership, Person, Team
from readers import mcp as view

from .. import schemas as s
from ..common import (
    lookup,
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
