"""Write operations for people (team members)."""

from actions.activity import change_set, created_changes, deleted_changes, log_activity, snapshot
from data.models import Invitation, Person


def _person_values(person: Person) -> dict:
    values = snapshot(person, ["name"])
    values["teams"] = list(person.teams.order_by("name", "id").values_list("name", flat=True))
    return values


def create_person(*, workspace, name: str, actor=None) -> Person:
    person = Person.objects.create(workspace=workspace, name=name.strip() or "Unnamed")
    log_activity(
        workspace=workspace,
        actor=actor,
        action="person.created",
        entity=person,
        changes=created_changes(_person_values(person)),
    )
    return person


def update_person(*, workspace, person_id: int, name: str, actor=None) -> Person | None:
    try:
        p = Person.objects.get(id=person_id, workspace=workspace)
    except Person.DoesNotExist:
        return None
    before = snapshot(p, ["name"])
    p.name = name.strip() or p.name
    p.save()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="person.updated",
        entity=p,
        changes=change_set(before, snapshot(p, ["name"])),
        skip_empty_changes=True,
    )
    return p


def delete_person(*, workspace, person_id: int, actor=None) -> bool:
    person = Person.objects.filter(id=person_id, workspace=workspace).prefetch_related("teams").first()
    if person is None:
        return False
    values = _person_values(person)
    label = person.name
    entity_id = person.id
    person.delete()
    log_activity(
        workspace=workspace,
        actor=actor,
        action="person.deleted",
        entity_type="person",
        entity_id=entity_id,
        entity_label=label,
        changes=deleted_changes(values),
    )
    return True


def get_or_create_person_invite(*, workspace, person_id: int, actor=None) -> Invitation:
    person = Person.objects.get(id=person_id, workspace=workspace)
    inv, created = Invitation.objects.get_or_create(workspace=workspace, person=person)
    if created:
        log_activity(
            workspace=workspace,
            actor=actor,
            action="person.invited",
            entity=person,
            changes=created_changes({"person": person.name}),
            metadata={"invitation_id": inv.id},
        )
    return inv
