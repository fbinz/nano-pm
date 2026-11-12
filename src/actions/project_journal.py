"""Small, workspace-scoped contributions to a project's permanent journal."""

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from data.models import JournalKind, Project, ProjectJournalEntry


@transaction.atomic
def add_entry(*, workspace, project_id, actor, body, kind=JournalKind.NOTE, parent_id=None):
    project = Project.objects.select_for_update().get(id=project_id, workspace=workspace)
    if not body.strip() or len(body) > 20000 or kind not in (JournalKind.NOTE, JournalKind.QUESTION, JournalKind.DECISION, JournalKind.UPDATE):
        raise ValidationError("Invalid journal entry.")
    parent = None
    if parent_id is not None:
        parent = project.journal.get(id=parent_id, parent__isnull=True)
        kind = JournalKind.NOTE
    return ProjectJournalEntry.objects.create(
        project=project, parent=parent, author=actor, author_label=actor.get_username(),
        body=body.strip(), kind=kind, phase=project.phase,
    )


@transaction.atomic
def edit_entry(*, workspace, project_id, entry_id, body):
    project = Project.objects.select_for_update().get(id=project_id, workspace=workspace)
    entry = project.journal.select_for_update().get(id=entry_id)
    body = body.strip()
    if not body or len(body) > 20000 or entry.kind == JournalKind.PHASE:
        raise ValidationError("Invalid journal entry.")
    if body != entry.body:
        entry.body = body
        entry.updated_at = timezone.now()
        entry.save(update_fields=["body", "updated_at"])
    return entry


def resolve_question(*, workspace, project_id, entry_id):
    entry = ProjectJournalEntry.objects.get(
        id=entry_id, project_id=project_id, project__workspace=workspace,
        parent__isnull=True, kind=JournalKind.QUESTION,
    )
    entry.resolved_at = None if entry.resolved_at else timezone.now()
    entry.save(update_fields=["resolved_at"])
    return entry
