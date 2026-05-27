"""Write operations for people (team members)."""

from data.models import Person


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
