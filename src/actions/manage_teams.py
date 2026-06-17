"""Write operations for teams and person team memberships."""

from django.db import IntegrityError, transaction

from data.models import Person, Team


def _clean_name(name: str) -> str:
    return name.strip() or "Unnamed"


def create_team(*, workspace, name: str) -> Team | None:
    clean = _clean_name(name)
    if Team.objects.filter(workspace=workspace, name__iexact=clean).exists():
        return None
    try:
        return Team.objects.create(workspace=workspace, name=clean)
    except IntegrityError:
        return None


def update_team(*, workspace, team_id: int, name: str) -> Team | None:
    clean = _clean_name(name)
    try:
        team = Team.objects.get(id=team_id, workspace=workspace)
    except Team.DoesNotExist:
        return None
    if Team.objects.filter(workspace=workspace, name__iexact=clean).exclude(id=team.id).exists():
        return None
    team.name = clean
    try:
        team.save()
    except IntegrityError:
        return None
    return team


def delete_team(*, workspace, team_id: int) -> bool:
    deleted, _ = Team.objects.filter(id=team_id, workspace=workspace).delete()
    return deleted > 0


@transaction.atomic
def set_person_teams(*, workspace, person_id: int, team_ids: list[int]) -> Person | None:
    try:
        person = Person.objects.get(id=person_id, workspace=workspace)
    except Person.DoesNotExist:
        return None
    teams = list(Team.objects.filter(workspace=workspace, id__in=team_ids))
    person.teams.set(teams)
    return person
