"""Application permission predicates, shared by web and MCP interfaces."""

from data.models import Person, WorkspaceRole


def is_pm(request):
    membership = getattr(request, "membership", None)
    return membership is not None and membership.role == WorkspaceRole.PM


def request_person(request):
    return Person.objects.filter(workspace=request.workspace, user=request.user).first()


def is_assigned(request, task):
    person = request_person(request)
    return person is not None and task.assignees.filter(id=person.id).exists()


def is_project_responsible(request, project):
    person = request_person(request)
    return (
        person is not None and project.responsible_people.filter(id=person.id).exists()
    )


def can_manage_project(request, project):
    return is_pm(request) or is_project_responsible(request, project)


def can_manage_task(request, task):
    return (
        can_manage_project(request, task.project)
        or not task.assignees.exists()
        or is_assigned(request, task)
    )
