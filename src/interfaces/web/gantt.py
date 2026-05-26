"""Gantt chart views — full page + Datastar SSE fragment endpoints."""

from datetime import date

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render
from django.urls import path
from django.views.decorators.http import require_http_methods

from datastar_py.django import (
    ServerSentEventGenerator as SSE,
    datastar_response,
)
from django_cotton import render_component

from actions.manage_projects import (
    create_project, update_project, delete_project, move_project,
)
from actions.manage_people import create_person, update_person, delete_person
from actions.manage_tasks import (
    create_task, update_task, delete_task, move_task, move_many_tasks,
    resize_start, resize_end,
)
from actions.manage_dependencies import add_dependency, delete_dependency
from actions.manage_milestones import (
    create_milestone, update_milestone, delete_milestone,
)
from data.models import Dependency, TaskStatus
from data.models.project import PROJECT_COLORS
from readers.gantt import (
    get_chart_state, get_task, get_project, get_milestone,
)
from readers.chart_view import (
    build_chart_vm,
    build_resource_vm,
    DEFAULT_ZOOM,
    ZOOM_PX_PER_DAY,
    ZOOM_PPD_RANGE,
    ZOOM_DAYS_PER_UNIT,
)


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

_VALID_ZOOMS = {"day", "week", "month", "quarter"}


def _zoom(request: HttpRequest) -> str:
    # The zoom is chosen via ?zoom=… on the page URL. SSE-driven mutation
    # endpoints (drag/resize/popover-save) POST to URLs without that query
    # string, so we cache the last-chosen zoom in the session and use it as
    # the fallback — otherwise every commit would re-render at DEFAULT_ZOOM.
    z = request.GET.get("zoom")
    if z in _VALID_ZOOMS:
        request.session["zoom"] = z
        return z
    sz = request.session.get("zoom")
    if sz in _VALID_ZOOMS:
        return sz
    return DEFAULT_ZOOM


def _ppd(request: HttpRequest, zoom: str) -> int:
    """Resolve px/day for `zoom`. ?ppd= wins (and is persisted per-zoom);
    falls back to a per-zoom session value, else the zoom's default."""
    lo, hi = ZOOM_PPD_RANGE[zoom]
    raw = request.GET.get("ppd")
    if raw is not None:
        try:
            v = int(round(float(raw)))
        except ValueError:
            v = None
        if v is not None:
            v = max(lo, min(hi, v))
            request.session[f"ppd_{zoom}"] = v
            return v
    sv = request.session.get(f"ppd_{zoom}")
    if isinstance(sv, int) and lo <= sv <= hi:
        return sv
    return ZOOM_PX_PER_DAY[zoom]


def _collapsed_projects(request: HttpRequest) -> set[int]:
    """Read the per-session set of collapsed project IDs (UI-only state; no DB)."""
    raw = request.session.get("collapsed_projects", [])
    return {int(x) for x in raw if isinstance(x, (int, str)) and str(x).lstrip("-").isdigit()}


def _set_collapsed_projects(request: HttpRequest, ids: set[int]) -> None:
    """Persist the collapsed project ID set into the session as a sorted list."""
    request.session["collapsed_projects"] = sorted(ids)


def _collapsed_people(request: HttpRequest) -> set[int]:
    raw = request.session.get("collapsed_people", [])
    return {int(x) for x in raw if isinstance(x, (int, str)) and str(x).lstrip("-").isdigit()}


def _set_collapsed_people(request: HttpRequest, ids: set[int]) -> None:
    request.session["collapsed_people"] = sorted(ids)


def _view_mode(request: HttpRequest) -> str:
    return request.session.get("view_mode", "project")


def _patch_chart(request: HttpRequest, zoom: str | None = None):
    """Yield an SSE patch that replaces the chart fragment with a fresh render."""
    state = get_chart_state(request.user)
    z = zoom or _zoom(request)
    ppd = _ppd(request, z)
    if _view_mode(request) == "resource":
        vm = build_resource_vm(state, z, px_per_day=ppd,
                               collapsed_person_ids=_collapsed_people(request))
        template = "screens/gantt/chart_resource"
    else:
        vm = build_chart_vm(state, z, px_per_day=ppd,
                            collapsed_project_ids=_collapsed_projects(request))
        template = "screens/gantt/chart"
    return SSE.patch_elements(render_component(request, template, vm=vm))


def _parse_iso(s: str) -> date | None:
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Page                                                                        #
# --------------------------------------------------------------------------- #

@login_required
def index(request: HttpRequest) -> HttpResponse:
    request.session["view_mode"] = "project"
    request.session.save()
    state = get_chart_state(request.user)
    zoom = _zoom(request)
    ppd = _ppd(request, zoom)
    vm = build_chart_vm(
        state, zoom,
        px_per_day=ppd,
        collapsed_project_ids=_collapsed_projects(request),
    )
    days_per_unit = ZOOM_DAYS_PER_UNIT[zoom]
    lo, hi = ZOOM_PPD_RANGE[zoom]
    return render(
        request,
        "components/screens/gantt/index.html",
        {
            "vm": vm,
            "zoom": zoom,
            "user": request.user,
            # Slider is in "px per active unit" — convert from px/day for the
            # template. Step matches one px/day so the slider lands on integer
            # px/day values regardless of the unit.
            "ppd_unit": ppd * days_per_unit,
            "ppd_unit_min": lo * days_per_unit,
            "ppd_unit_max": hi * days_per_unit,
            "ppd_unit_step": days_per_unit,
            "days_per_unit": days_per_unit,
        },
    )


@login_required
@datastar_response
def zoom_set(request: HttpRequest):
    """Slider-driven density change — re-render the chart at the requested
    px/day. Reads ?ppd=… and persists per-zoom in the session via _ppd()."""
    # The generator body runs lazily during response streaming, AFTER
    # Django's session middleware has already finished on this response.
    # Without an explicit save here the new ppd never reaches the backend.
    zoom = _zoom(request)
    _ppd(request, zoom)
    request.session.save()
    yield _patch_chart(request, zoom=zoom)


# --------------------------------------------------------------------------- #
# Tasks                                                                       #
# --------------------------------------------------------------------------- #

def _render_task_popover(request: HttpRequest, task_id: int) -> str | None:
    """Render the task-popover fragment for `task_id`, or None if it's gone.
    Shared by task_popover (initial open) and side-effecting endpoints that
    want to refresh the drawer's deps list (e.g. dep_delete)."""
    task = get_task(request.user, task_id)
    if task is None:
        return None
    state = get_chart_state(request.user)
    preds = list(
        Dependency.objects.filter(successor=task)
        .select_related("predecessor")
    )
    succs = list(
        Dependency.objects.filter(predecessor=task)
        .select_related("successor")
    )
    task.assignee_ids = list(task.assignees.values_list("id", flat=True))
    task.project_id = task.project.id
    return render_component(
        request, "screens/gantt/task-popover",
        task=task, projects=state.projects, people=state.people,
        preds=preds, succs=succs,
    )


@login_required
@datastar_response
def task_popover(request: HttpRequest, task_id: int):
    fragment = _render_task_popover(request, task_id)
    if fragment is None:
        return
    yield SSE.patch_elements(fragment)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_update(request: HttpRequest, task_id: int):
    title = request.POST.get("title", "").strip() or None
    # description: empty string is a valid value (clears existing notes), so
    # only fall back to None when the field is absent from the POST entirely.
    description = request.POST.get("description") if "description" in request.POST else None
    start = _parse_iso(request.POST.get("start", ""))
    end = _parse_iso(request.POST.get("end", ""))
    status = request.POST.get("status") or None
    project_id_raw = request.POST.get("project_id")
    project_id = int(project_id_raw) if project_id_raw and project_id_raw.isdigit() else None
    assignee_ids = [int(x) for x in request.POST.getlist("assignee_ids") if x.isdigit()]
    update_task(
        owner=request.user,
        task_id=task_id,
        title=title,
        description=description,
        start=start,
        end=end,
        status=status,
        project_id=project_id,
        assignee_ids=assignee_ids,
    )
    yield _patch_chart(request)
    # Close the popover by emptying its slot.
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_move(request: HttpRequest, task_id: int):
    new_start = _parse_iso(request.POST.get("start", ""))
    if new_start is None:
        return
    move_task(owner=request.user, task_id=task_id, new_start=new_start)
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_move_many(request: HttpRequest):
    """Bulk-shift a set of tasks by a common day delta — used by the
    multi-select drag flow. Body fields: `task_ids` (CSV of ints),
    `delta_days` (int, may be negative)."""
    raw_ids = request.POST.get("task_ids", "")
    task_ids = [int(x) for x in raw_ids.split(",") if x.strip().lstrip("-").isdigit()]
    try:
        delta_days = int(request.POST.get("delta_days", "0"))
    except ValueError:
        delta_days = 0
    if not task_ids or delta_days == 0:
        return
    move_many_tasks(owner=request.user, task_ids=task_ids, delta_days=delta_days)
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_resize_start(request: HttpRequest, task_id: int):
    new_start = _parse_iso(request.POST.get("start", ""))
    if new_start is None:
        return
    resize_start(owner=request.user, task_id=task_id, new_start=new_start)
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_resize_end(request: HttpRequest, task_id: int):
    new_end = _parse_iso(request.POST.get("end", ""))
    if new_end is None:
        return
    resize_end(owner=request.user, task_id=task_id, new_end=new_end)
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_create(request: HttpRequest):
    project_id = int(request.POST.get("project_id", 0) or 0)
    start = _parse_iso(request.POST.get("start", ""))
    end = _parse_iso(request.POST.get("end", ""))
    title = request.POST.get("title", "").strip() or "New task"
    if not project_id or start is None or end is None:
        return
    create_task(
        owner=request.user, project_id=project_id, title=title, start=start, end=end,
    )
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_delete_view(request: HttpRequest, task_id: int):
    delete_task(owner=request.user, task_id=task_id)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


# --------------------------------------------------------------------------- #
# Milestones                                                                  #
# --------------------------------------------------------------------------- #

@login_required
@datastar_response
def milestone_popover(request: HttpRequest, milestone_id: int):
    m = get_milestone(request.user, milestone_id)
    if m is None:
        return
    state = get_chart_state(request.user)
    m.project_id = m.project.id  # for the template's `selected` check
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/milestone-popover",
            m=m, projects=state.projects,
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_update_view(request: HttpRequest, milestone_id: int):
    project_id_raw = request.POST.get("project_id", "")
    description = request.POST.get("description") if "description" in request.POST else None
    update_milestone(
        owner=request.user,
        milestone_id=milestone_id,
        title=request.POST.get("title") or None,
        description=description,
        on=_parse_iso(request.POST.get("date", "")),
        project_id=int(project_id_raw) if project_id_raw.isdigit() else None,
    )
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_delete_view(request: HttpRequest, milestone_id: int):
    delete_milestone(owner=request.user, milestone_id=milestone_id)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_move(request: HttpRequest, milestone_id: int):
    new_date = _parse_iso(request.POST.get("date", ""))
    if new_date is None:
        return
    update_milestone(owner=request.user, milestone_id=milestone_id, on=new_date)
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_create(request: HttpRequest, project_id: int):
    """Create a milestone with placeholder title and open its editor —
    same UX as the rubber-band-create-task flow. The optional `date` POST
    field places the milestone at a specific date (used by the click-on-row
    flow); without it the milestone lands on today's date (used by the
    + Add milestone button in the project popover)."""
    proj = get_project(request.user, project_id)
    if proj is None:
        return
    on = _parse_iso(request.POST.get("date", "")) or date.today()
    m = create_milestone(
        owner=request.user, project_id=project_id,
        title="New milestone", on=on,
    )
    if m is None:
        return
    state = get_chart_state(request.user)
    yield _patch_chart(request)
    m.project_id = m.project.id  # for the template's `selected` check
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/milestone-popover",
            m=m, projects=state.projects,
        )
    )


# --------------------------------------------------------------------------- #
# Dependencies                                                                #
# --------------------------------------------------------------------------- #

@require_http_methods(["POST"])
@login_required
@datastar_response
def dep_add(request: HttpRequest):
    pred = int(request.POST.get("predecessor", 0) or 0)
    succ = int(request.POST.get("successor", 0) or 0)
    _, _, err = add_dependency(
        owner=request.user, predecessor_id=pred, successor_id=succ
    )
    if err:
        yield SSE.patch_elements(
            f'<div id="toast-slot"><div class="toast error">{err}</div></div>'
        )
        return
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def dep_delete(request: HttpRequest, predecessor_id: int, successor_id: int):
    delete_dependency(
        owner=request.user,
        predecessor_id=predecessor_id,
        successor_id=successor_id,
    )
    yield _patch_chart(request)
    # If the request originated from an open task popover (button passes
    # ?task=<id>), re-render that popover so its deps-list reflects the
    # deletion — otherwise the dep-row sticks around as a ghost button.
    task_raw = request.GET.get("task", "")
    if task_raw.isdigit():
        fragment = _render_task_popover(request, int(task_raw))
        if fragment is not None:
            yield SSE.patch_elements(fragment)


# --------------------------------------------------------------------------- #
# Projects                                                                    #
# --------------------------------------------------------------------------- #

@require_http_methods(["POST"])
@login_required
@datastar_response
def project_create(request: HttpRequest):
    create_project(owner=request.user)
    yield _patch_chart(request)


@login_required
@datastar_response
def project_popover(request: HttpRequest, project_id: int):
    proj = get_project(request.user, project_id)
    if proj is None:
        return
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/project-popover",
            project=proj,
            colors=PROJECT_COLORS,
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_update(request: HttpRequest, project_id: int):
    update_project(
        owner=request.user,
        project_id=project_id,
        name=request.POST.get("name") or None,
        color=request.POST.get("color") or None,
    )
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_move(request: HttpRequest, project_id: int):
    direction = int(request.GET.get("dir", "0") or 0)
    move_project(owner=request.user, project_id=project_id, direction=direction)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_delete(request: HttpRequest, project_id: int):
    delete_project(owner=request.user, project_id=project_id)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="drawer-slot"></div>')


@require_http_methods(["POST"])
@login_required
def project_toggle_collapse(request: HttpRequest, project_id: int):
    """Persist the collapsed/expanded state to the session (fire-and-forget from
    the client). The visual toggle is handled client-side via Datastar signals;
    this just ensures the next full page load renders the correct initial state."""
    if get_project(request.user, project_id) is None:
        return HttpResponse(status=404)
    collapsed = _collapsed_projects(request)
    collapsed.symmetric_difference_update({project_id})
    _set_collapsed_projects(request, collapsed)
    request.session.save()
    return HttpResponse(status=204)


@require_http_methods(["POST"])
@login_required
def set_all_collapsed(request: HttpRequest):
    """Persist the full collapsed set (fire-and-forget from collapse-all / expand-all)."""
    raw = request.POST.get("ids", "")
    ids = {int(x) for x in raw.split(",") if x.strip().isdigit()}
    _set_collapsed_projects(request, ids)
    request.session.save()
    return HttpResponse(status=204)


# --------------------------------------------------------------------------- #
# Resource view                                                                #
# --------------------------------------------------------------------------- #

@login_required
def resource_index(request: HttpRequest) -> HttpResponse:
    request.session["view_mode"] = "resource"
    request.session.save()
    state = get_chart_state(request.user)
    zoom = _zoom(request)
    ppd = _ppd(request, zoom)
    vm = build_resource_vm(
        state, zoom, px_per_day=ppd,
        collapsed_person_ids=_collapsed_people(request),
    )
    days_per_unit = ZOOM_DAYS_PER_UNIT[zoom]
    lo, hi = ZOOM_PPD_RANGE[zoom]
    return render(
        request,
        "components/screens/gantt/resource_index.html",
        {
            "vm": vm,
            "zoom": zoom,
            "user": request.user,
            "ppd_unit": ppd * days_per_unit,
            "ppd_unit_min": lo * days_per_unit,
            "ppd_unit_max": hi * days_per_unit,
            "ppd_unit_step": days_per_unit,
            "days_per_unit": days_per_unit,
        },
    )


@require_http_methods(["POST"])
@login_required
def person_toggle_collapse(request: HttpRequest, person_id: int):
    collapsed = _collapsed_people(request)
    collapsed.symmetric_difference_update({person_id})
    _set_collapsed_people(request, collapsed)
    request.session.save()
    return HttpResponse(status=204)


@require_http_methods(["POST"])
@login_required
def set_all_people_collapsed(request: HttpRequest):
    raw = request.POST.get("ids", "")
    ids = {int(x) for x in raw.split(",") if x.strip().lstrip("-").isdigit()}
    _set_collapsed_people(request, ids)
    request.session.save()
    return HttpResponse(status=204)


# --------------------------------------------------------------------------- #
# People                                                                      #
# --------------------------------------------------------------------------- #

@login_required
@datastar_response
def people_modal(request: HttpRequest):
    state = get_chart_state(request.user)
    yield SSE.patch_elements(
        render_component(request, "screens/gantt/people-modal", people=state.people)
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_create(request: HttpRequest):
    name = request.POST.get("name", "").strip()
    if not name:
        return
    create_person(owner=request.user, name=name)
    state = get_chart_state(request.user)
    yield SSE.patch_elements(
        render_component(request, "screens/gantt/people-modal", people=state.people)
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_update(request: HttpRequest, person_id: int):
    update_person(
        owner=request.user, person_id=person_id, name=request.POST.get("name", "")
    )
    state = get_chart_state(request.user)
    yield SSE.patch_elements(
        render_component(request, "screens/gantt/people-modal", people=state.people)
    )
    yield _patch_chart(request)


@require_http_methods(["POST"])
@login_required
@datastar_response
def people_delete(request: HttpRequest, person_id: int):
    delete_person(owner=request.user, person_id=person_id)
    state = get_chart_state(request.user)
    yield SSE.patch_elements(
        render_component(request, "screens/gantt/people-modal", people=state.people)
    )
    yield _patch_chart(request)


# --------------------------------------------------------------------------- #
# URL routing                                                                 #
# --------------------------------------------------------------------------- #

urlpatterns = [
    path("", index, name="gantt_index"),
    path("zoom/", zoom_set, name="zoom_set"),
    # Tasks
    path("tasks/<int:task_id>/popover/",       task_popover,        name="task_popover"),
    path("tasks/<int:task_id>/update/",        task_update,         name="task_update"),
    path("tasks/<int:task_id>/move/",          task_move,           name="task_move"),
    path("tasks/move-many/",                    task_move_many,      name="task_move_many"),
    path("tasks/<int:task_id>/resize/start/",  task_resize_start,   name="task_resize_start"),
    path("tasks/<int:task_id>/resize/end/",    task_resize_end,     name="task_resize_end"),
    path("tasks/",                              task_create,         name="task_create"),
    path("tasks/<int:task_id>/delete/",        task_delete_view,    name="task_delete"),
    # Milestones
    path("milestones/<int:milestone_id>/popover/", milestone_popover,     name="milestone_popover"),
    path("milestones/<int:milestone_id>/update/",  milestone_update_view, name="milestone_update"),
    path("milestones/<int:milestone_id>/delete/",  milestone_delete_view, name="milestone_delete"),
    path("milestones/<int:milestone_id>/move/",    milestone_move,        name="milestone_move"),
    path("projects/<int:project_id>/milestones/",  milestone_create,      name="milestone_create"),
    # Dependencies
    path("dependencies/",                                            dep_add,    name="dep_add"),
    path("dependencies/<int:predecessor_id>/<int:successor_id>/delete/",
                                                                     dep_delete, name="dep_delete"),
    # Projects
    path("projects/",                                project_create,   name="project_create"),
    path("projects/<int:project_id>/popover/",       project_popover,  name="project_popover"),
    path("projects/<int:project_id>/update/",        project_update,   name="project_update"),
    path("projects/<int:project_id>/move/",          project_move,     name="project_move"),
    path("projects/<int:project_id>/delete/",        project_delete,   name="project_delete"),
    path("projects/<int:project_id>/toggle-collapse/",
                                                     project_toggle_collapse, name="project_toggle_collapse"),
    path("projects/set-collapsed/",                  set_all_collapsed,       name="set_all_collapsed"),
    # Resource view
    path("resources/",                               resource_index,          name="resource_index"),
    path("resources/people/<int:person_id>/toggle-collapse/",
                                                     person_toggle_collapse,  name="person_toggle_collapse"),
    path("resources/people/set-collapsed/",          set_all_people_collapsed, name="set_all_people_collapsed"),
    # People
    path("people/modal/",                            people_modal,     name="people_modal"),
    path("people/",                                  people_create,    name="people_create"),
    path("people/<int:person_id>/update/",           people_update,    name="people_update"),
    path("people/<int:person_id>/delete/",           people_delete,    name="people_delete"),
]
