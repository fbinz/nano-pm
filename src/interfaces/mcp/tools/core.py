"""Workspace, project and scheduling tools; all writes use application actions."""

from django.db.models import Q, Value
from django.utils import timezone

from actions import manage_dependencies as dependencies
from actions import manage_milestones as milestones
from actions import manage_projects as projects
from actions import manage_tasks as tasks
from actions import manage_workspace_settings as settings_actions
from data.models import (
    ActivityEvent,
    Dependency,
    Membership,
    Milestone,
    Person,
    Project,
    Task,
    Team,
)
from permissions import has_idea_perm, is_pm, request_person
from readers import mcp as view

from .. import schemas as s
from ..common import (
    date_filter,
    dates,
    either_task_filter,
    lookup,
    manage_project,
    manage_task,
    match,
    memberships,
    name,
    page,
    patch,
    project_filter,
    related,
    require,
    scope,
    unique,
)
from ..registry import tool


@tool(s.Empty, cap=None, global_=True)
def get_me(r, p):
    """Read caller identity and granted capability names; no contact information."""
    return {
        "id": r.user.pk,
        "username": r.user.get_username(),
        "capabilities": r.mcp_policy.capabilities,
    }


@tool(s.Empty, cap=None, global_=True)
def list_workspaces(r, p):
    """List token-allowed workspaces intersected with current user memberships."""
    return {
        "items": [
            {**view.workspace(m.workspace), "role": m.role}
            for m in memberships(r).order_by("workspace_id")
        ]
    }


@tool(s.WorkspaceParams)
def get_workspace(r, p):
    """Read safe workspace settings and the caller's current role."""
    return {"item": view.workspace(r.workspace), "role": r.membership.role}


@tool(s.WorkspaceCreate, cap="workspace.create", global_=True, mutation=True)
def create_workspace(r, p):
    """Create a workspace, PM membership and this token's workspace binding atomically."""
    workspace = settings_actions.create_workspace(name=name(p.name), actor=r.user)
    r.mcp_policy.workspaces.add(workspace)
    return {"item": view.workspace(workspace)}


@tool(s.WorkspaceUpdate, cap="workspace.admin", pm=True, mutation=True)
def update_workspace(r, p):
    """Patch workspace name or milestone-reason preference; PM only."""
    match(p, view.workspace(r.workspace))
    values = patch(p, "name prompt_milestone_move_reason")
    obj = settings_actions.update_settings(
        workspace=r.workspace, actor=r.user, values=values
    )
    return {"item": view.workspace(obj)}


@tool(s.ActivityPage)
def list_activity(r, p):
    """Read a redacted activity page; never expose raw audit metadata or secret snapshots."""
    qs = ActivityEvent.objects.filter(workspace=r.workspace).order_by("-id")
    allowed = [
        "workspace",
        "project",
        "task",
        "tasks",
        "milestone",
        "dependency",
        "person",
        "team",
    ]
    if has_idea_perm(r, "view"):
        allowed.append("idea")
    qs = qs.filter(entity_type__in=allowed)
    if p.entity_type:
        qs = qs.filter(entity_type=p.entity_type)
    if p.entity_id:
        qs = qs.filter(entity_id=p.entity_id)
    if p.actor_id:
        require(
            Membership.objects.filter(
                workspace=r.workspace, user_id=p.actor_id
            ).exists(),
            "not_found",
            "Actor not found.",
        )
        qs = qs.filter(actor_id=p.actor_id)
    return page(r, date_filter(qs, p, "created_at__date"), p, view.activity)


@tool(s.SchedulePage)
def get_schedule(r, p):
    """Read a paginated mixed task/milestone schedule for a date window of at most 366 days."""
    dates(p.start, p.end)
    require(
        (p.end - p.start).days <= 366,
        "validation_error",
        "Schedule window must not exceed 366 days.",
    )
    related(Project, p.project_ids, r.workspace)
    tq = Task.objects.filter(
        project__workspace=r.workspace, start__lt=p.end, end__gt=p.start
    ).order_by("id")
    mq = Milestone.objects.filter(
        project__workspace=r.workspace, date__gte=p.start, date__lt=p.end
    ).order_by("id")
    if p.project_ids:
        tq, mq = (
            tq.filter(project_id__in=p.project_ids),
            mq.filter(project_id__in=p.project_ids),
        )
    rows = (
        tq.order_by()
        .annotate(kind=Value("task"))
        .values("id", "kind")
        .union(
            mq.order_by().annotate(kind=Value("milestone")).values("id", "kind"),
        )
        .order_by("kind", "id")
    )

    def read_row(row):
        model, reader = (
            (Task, view.task) if row["kind"] == "task" else (Milestone, view.milestone)
        )
        return {
            "kind": row["kind"],
            **reader(lookup(model, row["id"], r.workspace), False),
        }

    result = page(r, rows, p, read_row)
    result["today"] = timezone.localdate().isoformat()
    return result


@tool(s.ProjectPage)
def list_projects(r, p):
    """List project summaries with search, completion, responsible-person and team filters."""
    qs = Project.objects.filter(workspace=r.workspace).order_by("order", "id")
    if p.search:
        qs = qs.filter(Q(name__icontains=p.search) | Q(description__icontains=p.search))
    if p.completed is not None:
        qs = qs.filter(completed_at__isnull=not p.completed)
    if p.responsible_person_id:
        lookup(Person, p.responsible_person_id, r.workspace)
        qs = qs.filter(responsible_people=p.responsible_person_id)
    if p.team_id:
        lookup(Team, p.team_id, r.workspace)
        qs = qs.filter(responsible_people__teams=p.team_id)
    return page(
        r,
        qs.distinct(),
        p,
        lambda obj: view.project(obj, False),
        revision=view.ordering(r.workspace),
    )


@tool(s.ObjectParams)
def get_project(r, p):
    """Read project details and revision; list children using the task/milestone tools."""
    return {"item": view.project(lookup(Project, p.id, r.workspace))}


@tool(s.ProjectCreate, cap="core.write", pm=True, mutation=True)
def create_project(r, p):
    """Create a project with validated responsible people; PM only."""
    related(Person, p.responsible_person_ids, r.workspace)
    obj = projects.create_project(
        workspace=r.workspace, name=name(p.name), color=p.color, actor=r.user
    )
    projects.update_project(
        workspace=r.workspace,
        project_id=obj.pk,
        description=p.description,
        responsible_person_ids=p.responsible_person_ids,
        public_roadmap_visible=p.public_roadmap_visible,
        actor=r.user,
    )
    obj.refresh_from_db()
    return {"item": view.project(obj)}


@tool(s.ProjectUpdate, cap="core.write", mutation=True)
def update_project(r, p):
    """Patch project fields/responsible people; requires project management."""
    obj = lookup(Project, p.id, r.workspace)
    manage_project(r, obj)
    match(p, view.project(obj))
    values = patch(p, "name description color responsible_person_ids public_roadmap_visible")
    if "responsible_person_ids" in values:
        related(Person, values["responsible_person_ids"], r.workspace)
    obj = projects.update_project(
        workspace=r.workspace, project_id=obj.pk, actor=r.user, **values
    )
    return {"item": view.project(obj)}


@tool(s.ObjectChange, cap="core.write", mutation=True)
def claim_project(r, p):
    """Claim yourself as responsible only when the project has no responsible people."""
    obj = lookup(Project, p.id, r.workspace)
    match(p, view.project(obj))
    person = request_person(r)
    require(person is not None and not obj.responsible_people.exists())
    obj = projects.update_project(
        workspace=r.workspace,
        project_id=obj.pk,
        responsible_person_ids=[person.pk],
        actor=r.user,
    )
    manage_project(r, obj)
    return {"item": view.project(obj)}


@tool(s.Completed, cap="core.write", mutation=True, destructive=True)
def set_project_completed(r, p):
    """Set completion explicitly; reopening can conflict with another GitLab prefix collector."""
    obj = lookup(Project, p.id, r.workspace)
    manage_project(r, obj)
    match(p, view.project(obj))
    if obj.is_completed != p.completed:
        obj = projects.set_project_completed(
            workspace=r.workspace,
            project_id=obj.pk,
            completed=p.completed,
            actor=r.user,
        )
    return {"item": view.project(obj)}


@tool(s.Reorder, cap="core.write", pm=True, mutation=True)
def reorder_projects(r, p):
    """Reorder supplied projects in their existing slots; use list_projects' aggregate revision."""
    match(p, {"revision": view.ordering(r.workspace)})
    related(Project, p.project_ids, r.workspace)
    projects.reorder_projects(
        workspace=r.workspace, project_ids=p.project_ids, actor=r.user
    )
    return {"revision": view.ordering(r.workspace)}


@tool(
    s.TransferProject,
    cap="core.write",
    pm=True,
    extra_caps=("workspace.admin",),
    mutation=True,
    destructive=True,
    scheduling=True,
)
def move_project_to_workspace(r, p):
    """Move a project and children; requires PM in both workspaces. Removes external dependencies/subscriptions, remaps people, detaches workload and retires GitLab ownership."""
    source = r.workspace
    obj = lookup(Project, p.id, source)
    match(p, view.project(obj))
    target = scope(r, p.target_workspace_id)
    require(is_pm(r) and source.pk != target.pk)
    r.mcp_guards.append(("workspace_pm", target.pk))
    scope(r, source.pk)
    obj = projects.move_project_to_workspace(
        user=r.user,
        workspace=source,
        project_id=obj.pk,
        target_workspace_id=target.pk,
        actor=r.user,
    )
    require(obj is not None)
    return {
        "item": view.project(obj),
        "target_workspace_id": target.pk,
        "consequences": [
            "External dependencies and subscriptions removed",
            "People remapped by linked user",
            "GitLab ownership retired",
            "Workload references detached",
        ],
    }


@tool(
    s.ObjectChange, cap="core.write", mutation=True, destructive=True, scheduling=True
)
def delete_project(r, p):
    """Delete a project and its tasks/milestones/dependencies; retire GitLab ownership."""
    obj = lookup(Project, p.id, r.workspace)
    manage_project(r, obj)
    match(p, view.project(obj))
    projects.delete_project(workspace=r.workspace, project_id=p.id, actor=r.user)
    return {"deleted_ids": [p.id]}


@tool(s.TaskPage)
def list_tasks(r, p):
    """List tasks; dates filter overlap with [start,end), status is derived from workspace-local today."""
    qs = Task.objects.filter(project__workspace=r.workspace).order_by("id")
    qs = project_filter(qs, p, r.workspace)
    if p.search:
        qs = qs.filter(
            Q(title__icontains=p.search) | Q(description__icontains=p.search)
        )
    if p.assignee_id:
        lookup(Person, p.assignee_id, r.workspace)
        qs = qs.filter(assignees=p.assignee_id)
    if p.team_id:
        lookup(Team, p.team_id, r.workspace)
        qs = qs.filter(assignees__teams=p.team_id)
    if p.start:
        qs = qs.filter(end__gt=p.start)
    if p.end:
        qs = qs.filter(start__lt=p.end)
    if p.start and p.end:
        dates(p.start, p.end)
    today = timezone.localdate()
    if p.status == "done":
        qs = qs.filter(end__lte=today)
    elif p.status == "planned":
        qs = qs.filter(start__gt=today, end__gt=today)
    elif p.status == "in-progress":
        qs = qs.filter(start__lte=today, end__gt=today)
    return page(r, qs.distinct(), p, lambda obj: view.task(obj, False))


@tool(s.ObjectParams)
def get_task(r, p):
    """Read a task, assignment IDs, linked milestone, dependency IDs and revision."""
    return {"item": view.task(lookup(Task, p.id, r.workspace))}


def task_milestone(workspace, milestone_id, project_id, task_id=None):
    if milestone_id is None:
        return
    milestone = lookup(Milestone, milestone_id, workspace)
    require(
        milestone.task_id in (None, task_id)
        and (milestone.project_id == project_id or milestone.task_id == task_id),
        "validation_error",
        "Milestone is already linked or belongs to a different project.",
    )


@tool(s.TaskCreate, cap="core.write", mutation=True, scheduling=True)
def create_task(r, p):
    """Create a task with exclusive end date and validated assignees; may cascade schedules."""
    manage_project(r, lookup(Project, p.project_id, r.workspace))
    dates(p.start, p.end)
    related(Person, p.assignee_ids, r.workspace)
    task_milestone(r.workspace, p.milestone_id, p.project_id)
    obj, _ = tasks.create_task(
        workspace=r.workspace,
        project_id=p.project_id,
        title=name(p.title),
        start=p.start,
        end=p.end,
        actor=r.user,
    )
    obj, _ = tasks.update_task(
        workspace=r.workspace,
        task_id=obj.pk,
        description=p.description,
        assignee_ids=p.assignee_ids,
        milestone_id=p.milestone_id,
        actor=r.user,
    )
    obj.refresh_from_db()
    return {"item": view.task(obj)}


@tool(s.TaskUpdate, cap="core.write", mutation=True, scheduling=True)
def update_task(r, p):
    """Patch task fields and links atomically; changing dates can cascade to other tasks/milestones."""
    obj = lookup(Task, p.id, r.workspace)
    manage_task(r, obj)
    match(p, view.task(obj))
    values = patch(
        p, "title description start end project_id assignee_ids milestone_id"
    )
    dates(values.get("start", obj.start), values.get("end", obj.end))
    if "project_id" in values and values["project_id"] != obj.project_id:
        manage_project(r, obj.project)
        manage_project(r, lookup(Project, values["project_id"], r.workspace))
    if "assignee_ids" in values:
        related(Person, values["assignee_ids"], r.workspace)
    if "milestone_id" in values:
        task_milestone(
            r.workspace,
            values["milestone_id"],
            values.get("project_id", obj.project_id),
            obj.pk,
        )
        if values["milestone_id"] is None:
            values["milestone_id"] = 0
    obj, _ = tasks.update_task(
        workspace=r.workspace, task_id=obj.pk, actor=r.user, **values
    )
    obj.refresh_from_db()
    return {"item": view.task(obj)}


@tool(s.ObjectChange, cap="core.write", mutation=True)
def claim_task(r, p):
    """Assign yourself only when a task currently has no assignees."""
    obj = lookup(Task, p.id, r.workspace)
    match(p, view.task(obj))
    person = request_person(r)
    require(person is not None and not obj.assignees.exists())
    obj, _ = tasks.update_task(
        workspace=r.workspace, task_id=obj.pk, assignee_ids=[person.pk], actor=r.user
    )
    manage_task(r, obj)
    obj.refresh_from_db()
    return {"item": view.task(obj)}


@tool(s.MoveTask, cap="core.write", mutation=True, scheduling=True)
def move_task(r, p):
    """Move a task to a new start while preserving duration; cascade successors and linked milestones."""
    obj = lookup(Task, p.id, r.workspace)
    manage_task(r, obj)
    match(p, view.task(obj))
    tasks.move_task(
        workspace=r.workspace, task_id=obj.pk, new_start=p.new_start, actor=r.user
    )
    obj.refresh_from_db()
    return {"item": view.task(obj)}


@tool(s.MoveTasks, cap="core.write", mutation=True, scheduling=True)
def move_tasks(r, p):
    """Atomically shift up to 100 explicitly revision-checked tasks by a common day delta."""
    unique([target.id for target in p.targets])
    require(p.delta_days != 0, "validation_error", "Day delta must not be zero.")
    for target in p.targets:
        obj = lookup(Task, target.id, r.workspace)
        manage_task(r, obj)
        match(target, view.task(obj))
    tasks.move_many_tasks(
        workspace=r.workspace,
        task_ids=[t.id for t in p.targets],
        delta_days=p.delta_days,
        actor=r.user,
    )
    return {
        "items": [
            view.task(lookup(Task, target.id, r.workspace)) for target in p.targets
        ],
        "next_cursor": None,
    }


@tool(
    s.ObjectChange, cap="core.write", mutation=True, destructive=True, scheduling=True
)
def delete_task(r, p):
    """Delete a task, its linked milestone and dependency edges."""
    obj = lookup(Task, p.id, r.workspace)
    manage_task(r, obj)
    match(p, view.task(obj))
    tasks.delete_task(workspace=r.workspace, task_id=obj.pk, actor=r.user)
    return {"deleted_ids": [p.id]}


@tool(s.MilestonePage)
def list_milestones(r, p):
    """List milestone summaries by project, task linkage and date window."""
    qs = project_filter(
        Milestone.objects.filter(project__workspace=r.workspace).order_by("id"),
        p,
        r.workspace,
    )
    if p.task_id:
        lookup(Task, p.task_id, r.workspace)
        qs = qs.filter(task_id=p.task_id)
    if p.linked is not None:
        qs = qs.filter(task__isnull=not p.linked)
    return page(
        r, date_filter(qs, p, "date"), p, lambda obj: view.milestone(obj, False)
    )


@tool(s.ObjectParams)
def get_milestone(r, p):
    """Read milestone details, linkage and move-reason policy; history is in list_activity."""
    return {"item": view.milestone(lookup(Milestone, p.id, r.workspace))}


def validate_link(r, task_id, project_id, on, current_id=None):
    if task_id is None:
        return
    task = lookup(Task, task_id, r.workspace)
    manage_task(r, task)
    require(
        task.project_id == project_id and task.end == on,
        "validation_error",
        "Linked task must have the same project and end date.",
    )
    require(
        not Milestone.objects.filter(task=task).exclude(pk=current_id).exists(),
        "validation_error",
        "Task already has a milestone.",
    )


@tool(s.MilestoneCreate, cap="core.write", mutation=True, scheduling=True)
def create_milestone(r, p):
    """Create a real milestone, optionally linked to a task with matching project/end date."""
    manage_project(r, lookup(Project, p.project_id, r.workspace))
    if p.require_move_reason:
        require(is_pm(r))
    validate_link(r, p.task_id, p.project_id, p.date)
    obj = milestones.create_milestone(
        workspace=r.workspace,
        project_id=p.project_id,
        title=name(p.title),
        on=p.date,
        actor=r.user,
    )
    obj = milestones.update_milestone(
        workspace=r.workspace,
        milestone_id=obj.pk,
        description=p.description,
        task_id=p.task_id,
        require_move_reason=p.require_move_reason,
        actor=r.user,
    )
    return {"item": view.milestone(obj)}


@tool(s.MilestoneUpdate, cap="core.write", mutation=True, scheduling=True)
def update_milestone(r, p):
    """Patch a milestone; a linked date change resizes its task. Required move reasons need three characters."""
    obj = lookup(Milestone, p.id, r.workspace)
    manage_project(r, obj.project)
    match(p, view.milestone(obj))
    values = patch(p, "title description date project_id task_id require_move_reason")
    if "require_move_reason" in values:
        require(is_pm(r))
    if "project_id" in values:
        manage_project(r, lookup(Project, values["project_id"], r.workspace))
    if obj.task_id:
        manage_task(r, obj.task)
        require(
            values.get("project_id", obj.project_id) == obj.project_id,
            "validation_error",
            "Move a linked milestone by moving its task's project.",
        )
        if "date" in values:
            require(
                values["date"] > obj.task.start,
                "validation_error",
                "Linked task must retain a positive duration.",
            )
    if "date" in values and values["date"] != obj.date and obj.require_move_reason:
        require(
            len(p.move_reason.strip()) >= 3,
            "reason_required",
            "Provide a move reason of at least three characters.",
        )
    if "task_id" in values:
        validate_link(
            r,
            values["task_id"],
            values.get("project_id", obj.project_id),
            values.get("date", obj.date),
            obj.pk,
        )
        if values["task_id"] is None:
            values["task_id"] = 0
    if "date" in values:
        values["on"] = values.pop("date")
    obj = milestones.update_milestone(
        workspace=r.workspace,
        milestone_id=obj.pk,
        move_reason=p.move_reason,
        actor=r.user,
        **values,
    )
    return {"item": view.milestone(obj)}


@tool(
    s.ObjectChange, cap="core.write", mutation=True, destructive=True, scheduling=True
)
def delete_milestone(r, p):
    """Delete a milestone without deleting its linked task."""
    obj = lookup(Milestone, p.id, r.workspace)
    manage_project(r, obj.project)
    match(p, view.milestone(obj))
    milestones.delete_milestone(
        workspace=r.workspace, milestone_id=obj.pk, actor=r.user
    )
    return {"deleted_ids": [p.id]}


@tool(s.DependencyPage)
def list_dependencies(r, p):
    """List workspace-local finish-to-start dependency edges, optionally touching a task/project."""
    qs = Dependency.objects.filter(
        predecessor__project__workspace=r.workspace,
        successor__project__workspace=r.workspace,
    ).order_by("id")
    return page(r, either_task_filter(qs, p, r.workspace), p, view.dependency)


@tool(s.DependencyCreate, cap="core.write", mutation=True, scheduling=True)
def add_dependency(r, p):
    """Add a finish-to-start edge after checking both tasks' revisions; reject cycles and cascade dates."""
    for pk, revision in (
        (p.predecessor_id, p.predecessor_revision),
        (p.successor_id, p.successor_revision),
    ):
        obj = lookup(Task, pk, r.workspace)
        manage_task(r, obj)
        require(
            view.task(obj)["revision"] == revision, "conflict", "Task revision changed."
        )
    require(
        p.predecessor_id != p.successor_id,
        "validation_error",
        "A task cannot depend on itself.",
    )
    require(
        not dependencies.would_cycle(r.workspace, p.predecessor_id, p.successor_id),
        "cycle_detected",
        "This dependency would create a cycle.",
    )
    obj, _, error = dependencies.add_dependency(
        workspace=r.workspace,
        predecessor_id=p.predecessor_id,
        successor_id=p.successor_id,
        actor=r.user,
    )
    require(error is None, "validation_error", str(error))
    return {"item": view.dependency(obj)}


@tool(s.DependencyDelete, cap="core.write", mutation=True, destructive=True)
def delete_dependency(r, p):
    """Remove a dependency edge; requires management of both endpoint tasks."""
    for pk in (p.predecessor_id, p.successor_id):
        manage_task(r, lookup(Task, pk, r.workspace))
    obj = Dependency.objects.filter(
        predecessor_id=p.predecessor_id, successor_id=p.successor_id
    ).first()
    require(obj is not None, "not_found", "Dependency not found.")
    match(p, view.dependency(obj))
    pk = obj.pk
    dependencies.delete_dependency(
        workspace=r.workspace,
        predecessor_id=p.predecessor_id,
        successor_id=p.successor_id,
        actor=r.user,
    )
    return {"deleted_ids": [pk]}
