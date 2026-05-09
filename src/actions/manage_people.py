"""Write operations for people (team members modelled, not users)."""

from data.models import Person


def create_person(*, owner, name: str) -> Person:
    return Person.objects.create(owner=owner, name=name.strip() or "Unnamed")


def update_person(*, owner, person_id: int, name: str) -> Person | None:
    try:
        p = Person.objects.get(id=person_id, owner=owner)
    except Person.DoesNotExist:
        return None
    p.name = name.strip() or p.name
    p.save()
    return p


def delete_person(*, owner, person_id: int) -> bool:
    deleted, _ = Person.objects.filter(id=person_id, owner=owner).delete()
    return deleted > 0
