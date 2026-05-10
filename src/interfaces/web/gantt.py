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
    create_task, update_task, delete_task, move_task, resize_start, resize_end,
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


def _patch_chart(request: HttpRequest, zoom: str | None = None):
    """Yield an SSE patch that replaces the chart fragment with a fresh render."""
    state = get_chart_state(request.user)
    z = zoom or _zoom(request)
    vm = build_chart_vm(state, z, px_per_day=_ppd(request, z))
    return SSE.patch_elements(render_component(request, "screens/gantt/chart", vm=vm))


def _parse_iso(s: str) -> date | None:
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def _anchor_xy(request: HttpRequest) -> tuple[int, int]:
    """Pull popover anchor coords from the URL — see nano.openTaskPopover/etc."""
    def _int(name: str, default: int) -> int:
        try:
            return int(request.GET.get(name, default))
        except ValueError:
            return default
    return _int("popoverX", 200), _int("popoverY", 200)


# --------------------------------------------------------------------------- #
# Page                                                                        #
# --------------------------------------------------------------------------- #

@login_required
def index(request: HttpRequest) -> HttpResponse:
    state = get_chart_state(request.user)
    zoom = _zoom(request)
    ppd = _ppd(request, zoom)
    vm = build_chart_vm(state, zoom, px_per_day=ppd)
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

@login_required
@datastar_response
def task_popover(request: HttpRequest, task_id: int):
    task = get_task(request.user, task_id)
    if task is None:
        return
    state = get_chart_state(request.user)
    preds = list(
        Dependency.objects.filter(successor=task)
        .select_related("predecessor")
    )
    succs = list(
        Dependency.objects.filter(predecessor=task)
        .select_related("successor")
    )
    anchor_x, anchor_y = _anchor_xy(request)
    # Augment task object so the template can check assignee membership simply.
    task.assignee_ids = list(task.assignees.values_list("id", flat=True))
    task.project_id = task.project.id
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/task-popover",
            task=task, projects=state.projects, people=state.people,
            preds=preds, succs=succs, anchor_x=anchor_x, anchor_y=anchor_y,
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def task_update(request: HttpRequest, task_id: int):
    title = request.POST.get("title", "").strip() or None
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
        start=start,
        end=end,
        status=status,
        project_id=project_id,
        assignee_ids=assignee_ids,
    )
    yield _patch_chart(request)
    # Close the popover by emptying its slot.
    yield SSE.patch_elements('<div id="popover-slot"></div>')


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
    yield SSE.patch_elements('<div id="popover-slot"></div>')


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
    anchor_x, anchor_y = _anchor_xy(request)
    m.project_id = m.project.id  # for the template's `selected` check
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/milestone-popover",
            m=m, projects=state.projects,
            anchor_x=anchor_x, anchor_y=anchor_y,
        )
    )


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_update_view(request: HttpRequest, milestone_id: int):
    project_id_raw = request.POST.get("project_id", "")
    update_milestone(
        owner=request.user,
        milestone_id=milestone_id,
        title=request.POST.get("title") or None,
        on=_parse_iso(request.POST.get("date", "")),
        project_id=int(project_id_raw) if project_id_raw.isdigit() else None,
    )
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="popover-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def milestone_delete_view(request: HttpRequest, milestone_id: int):
    delete_milestone(owner=request.user, milestone_id=milestone_id)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="popover-slot"></div>')


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
    """Create a milestone with placeholder title at today's date and open its
    editor — same UX as the rubber-band-create-task flow."""
    proj = get_project(request.user, project_id)
    if proj is None:
        return
    m = create_milestone(
        owner=request.user, project_id=project_id,
        title="New milestone", on=date.today(),
    )
    if m is None:
        return
    state = get_chart_state(request.user)
    yield _patch_chart(request)
    m.project_id = m.project.id  # for the template's `selected` check
    anchor_x, anchor_y = _anchor_xy(request)
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/milestone-popover",
            m=m, projects=state.projects,
            anchor_x=anchor_x, anchor_y=anchor_y,
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
    anchor_x, anchor_y = _anchor_xy(request)
    yield SSE.patch_elements(
        render_component(
            request, "screens/gantt/project-popover",
            project=proj,
            colors=PROJECT_COLORS,
            anchor_x=anchor_x,
            anchor_y=anchor_y,
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
    yield SSE.patch_elements('<div id="popover-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_move(request: HttpRequest, project_id: int):
    direction = int(request.GET.get("dir", "0") or 0)
    move_project(owner=request.user, project_id=project_id, direction=direction)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="popover-slot"></div>')


@require_http_methods(["POST"])
@login_required
@datastar_response
def project_delete(request: HttpRequest, project_id: int):
    delete_project(owner=request.user, project_id=project_id)
    yield _patch_chart(request)
    yield SSE.patch_elements('<div id="popover-slot"></div>')


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
    # People
    path("people/modal/",                            people_modal,     name="people_modal"),
    path("people/",                                  people_create,    name="people_create"),
    path("people/<int:person_id>/update/",           people_update,    name="people_update"),
    path("people/<int:person_id>/delete/",           people_delete,    name="people_delete"),
]
