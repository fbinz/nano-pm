"""Single-entity lookups, all scoped to a workspace."""

from data.models import Project, Task, Milestone, Person


def get_task(workspace, task_id: int) -> Task | None:
    try:
        return (
            Task.objects.select_related("project")
            .prefetch_related("assignees")
            .get(id=task_id, project__workspace=workspace)
        )
    except Task.DoesNotExist:
        return None


def get_project(workspace, project_id: int) -> Project | None:
    try:
        return Project.objects.get(id=project_id, workspace=workspace)
    except Project.DoesNotExist:
        return None


def get_milestone(workspace, milestone_id: int) -> Milestone | None:
    try:
        return Milestone.objects.select_related("project", "task").get(
            id=milestone_id, project__workspace=workspace
        )
    except Milestone.DoesNotExist:
        return None


def get_person(workspace, person_id: int) -> Person | None:
    try:
        return Person.objects.get(id=person_id, workspace=workspace)
    except Person.DoesNotExist:
        return None
