"""Write operations for teams and person team memberships."""

from django.db import IntegrityError, transaction

from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from data.models import Person, Team


def _clean_name(name: str) -> str:
    return name.strip() or "Unnamed"


def create_team(*, workspace, name: str, actor=None) -> Team | None:
    clean = _clean_name(name)
    if Team.objects.filter(workspace=workspace, name__iexact=clean).exists():
        return None
    try:
        team = Team.objects.create(workspace=workspace, name=clean)
    except IntegrityError:
        return None
    log_activity(
        workspace=workspace,
        actor=actor,
        action="team.created",
        entity=team,
        changes=created_changes(snapshot(team, ["name"])),
    )
    return team


def update_team(*, workspace, team_id: int, name: str, actor=None) -> Team | None:
    clean = _clean_name(name)
    try:
        team = Team.objects.get(id=team_id, workspace=workspace)
    except Team.DoesNotExist:
        return None
    if Team.objects.filter(workspace=workspace, name__iexact=clean).exclude(id=team.id).exists():
        return None
    before = snapshot(team, ["name"])
    team.name = clean
    try:
        team.save()
    except IntegrityError:
        return None
    log_activity(
        workspace=workspace,
        actor=actor,
        action="team.updated",
        entity=team,
        changes=change_set(before, snapshot(team, ["name"])),
        skip_empty_changes=True,
    )
    return team


def delete_team(*, workspace, team_id: int, actor=None) -> bool:
    team = Team.objects.filter(id=team_id, workspace=workspace).first()
    if team is None:
        return False
    values = snapshot(team, ["name"])
    label = team.name
    entity_id = team.id
    team.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="team.deleted",
        entity_type="team",
        entity_id=entity_id,
        entity_label=label,
        changes=deleted_changes(values),
    )
    return True


@transaction.atomic
def set_person_teams(
    *, workspace, person_id: int, team_ids: list[int], actor=None
) -> Person | None:
    try:
        person = Person.objects.get(id=person_id, workspace=workspace)
    except Person.DoesNotExist:
        return None
    before = {
        "teams": list(person.teams.order_by("name", "id").values_list("name", flat=True))
    }
    teams = list(Team.objects.filter(workspace=workspace, id__in=team_ids))
    person.teams.set(teams)
    after = {
        "teams": list(person.teams.order_by("name", "id").values_list("name", flat=True))
    }
    log_activity(
        workspace=workspace,
        actor=actor,
        action="person.updated",
        entity=person,
        changes=change_set(before, after),
        skip_empty_changes=True,
    )
    return person
