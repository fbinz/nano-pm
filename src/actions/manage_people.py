"""Write operations for people (team members)."""

from data.models import Invitation, Person


def create_person(*, workspace, name: str) -> Person:
    return Person.objects.create(workspace=workspace, name=name.strip() or "Unnamed")


def update_person(*, workspace, person_id: int, name: str) -> Person | None:
    try:
        p = Person.objects.get(id=person_id, workspace=workspace)
    except Person.DoesNotExist:
        return None
    p.name = name.strip() or p.name
    p.save()
    return p


def delete_person(*, workspace, person_id: int) -> bool:
    deleted, _ = Person.objects.filter(id=person_id, workspace=workspace).delete()
    return deleted > 0


def get_or_create_person_invite(*, workspace, person_id: int) -> Invitation:
    person = Person.objects.get(id=person_id, workspace=workspace)
    inv, _ = Invitation.objects.get_or_create(workspace=workspace, person=person)
    return inv
