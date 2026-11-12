"""The project notebook: capture early, plan progressively, keep the history."""

from urllib.parse import urlencode

from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db import IntegrityError, transaction
from django.db.models import Count, Prefetch, Q
from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.translation import gettext as _
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from datastar_py.django import DatastarResponse, ServerSentEventGenerator as SSE
from django_cotton import render_component

from actions.manage_projects import create_project, set_project_phase
from actions.project_journal import add_entry, edit_entry, delete_entry, resolve_question
from data.models import GitLabConnection, JournalKind, Project, ProjectJournalEntry, ProjectPhase
from data.models.task import status_for_dates
from readers import get_project

from .detail_forms import JournalEntryForm, JournalReplyForm, ProjectCreateForm, ProjectDetailForm, ProjectPhaseForm
from .gitlab import project_context as gitlab_project_context
from .helpers import can_manage_project, is_pm, workspace_context, request_data


def phase_steps():
    return [(value, label) for value, label in ProjectPhase.choices if value not in (ProjectPhase.PARKED, ProjectPhase.DROPPED)]


@require_GET
@login_required
def project_library(request):
    return render_library(request)


def render_library(request, form=None):
    phase = request.GET.get("phase", "")
    search = request.GET.get("q", "").strip()[:200]
    projects = Project.objects.filter(workspace=request.workspace).prefetch_related("responsible_people")
    if phase in ProjectPhase.values:
        projects = projects.filter(phase=phase)
    if search:
        projects = projects.filter(Q(name__icontains=search) | Q(description__icontains=search))
    return render(request, "components/screens/projects/index.html", {
        "projects": Paginator(projects.annotate(task_count=Count("tasks")), 30).get_page(request.GET.get("page")),
        "phases": ProjectPhase.choices, "selected_phase": phase, "search": search,
        "form": form if form is not None else ProjectCreateForm(), "is_pm": is_pm(request),
        **workspace_context(request),
    }, status=400 if form is not None else 200)


@require_POST
@login_required
def project_new(request):
    if not is_pm(request):
        return HttpResponse(status=403)
    form = ProjectCreateForm(request.POST)
    if not form.is_valid():
        return render_library(request, form)
    project = create_project(workspace=request.workspace, name=form.cleaned_data["name"], actor=request.user)
    return redirect("project_detail", project_id=project.id)


def journal_page(request, project, kind, page, *, can_edit, reply_entry_id=None, reply_form=None, edit_entry_id=None, edit_form=None):
    entries = project.journal.filter(parent__isnull=True)
    if kind in JournalKind.values:
        entries = entries.filter(kind=kind)
    entries = entries.prefetch_related(Prefetch("replies", queryset=ProjectJournalEntry.objects.order_by("created_at", "id")))
    journal = Paginator(entries, 30).get_page(page)
    for entry in journal:
        entry.can_resolve = can_edit or entry.author_id == request.user.id
        entry.reply_form = reply_form if entry.id == reply_entry_id else None
        for item in [entry, *entry.replies.all()]:
            item.can_edit_body = item.kind != JournalKind.PHASE and (can_edit or item.author_id == request.user.id)
            item.edit_form = edit_form if item.id == edit_entry_id else None
    return journal


def render_workspace(request, project, *, form=None, entry_form=None, phase_form=None, reply_entry_id=None, reply_form=None, edit_entry_id=None, edit_form=None, status=200):
    can_edit = can_manage_project(request, project)
    if form is None and can_edit:
        form = ProjectDetailForm(project=project, workspace=request.workspace)
    tasks = list(project.tasks.prefetch_related("assignees"))
    today = timezone.localdate()
    for task in tasks:
        task.status_label = status_for_dates(task.start, task.end, today).label
    journal_submission = reply_entry_id is not None or edit_entry_id is not None
    kind = request.POST.get("journal_kind", "") if journal_submission else request.GET.get("kind", "")
    page = request.POST.get("journal_page", "") if journal_submission else request.GET.get("page")
    kind = kind if kind in JournalKind.values else ""
    journal = journal_page(
        request, project, kind, page, can_edit=can_edit,
        reply_entry_id=reply_entry_id, reply_form=reply_form, edit_entry_id=edit_entry_id, edit_form=edit_form,
    )
    has_gitlab = GitLabConnection.objects.filter(workspace=request.workspace).exists()
    tab = request.GET.get("tab", "workspace")
    if tab not in {"project", "workspace", "plan", "gitlab"} or (tab == "gitlab" and not has_gitlab):
        tab = "workspace"
    # Direct/stale submissions must still expose validation errors on Project.
    if form is not None and form.is_bound:
        tab = "project"
    context = {
        "project": project, "form": form, "can_edit": can_edit,
        "edit_label": _("Edit project"), "save_label": _("Save project"),
        "tasks": tasks, "milestones": project.milestones.all(),
        "responsible_people": project.responsible_people.all(),
        "tab": tab, "has_gitlab": has_gitlab, "journal": journal, "selected_kind": kind,
        "journal_filters": [("", _("All entries")), ("decision", _("Decisions")), ("question", _("Questions")), ("update", _("Updates"))],
        "phase_steps": phase_steps(),
        "phase_form": phase_form if phase_form is not None else ProjectPhaseForm(initial={"phase": project.phase}),
        "entry_form": entry_form if entry_form is not None else JournalEntryForm(initial={"kind": JournalKind.NOTE}),
        "open_questions": project.journal.filter(kind=JournalKind.QUESTION, resolved_at__isnull=True, parent__isnull=True).count(),
        "is_pm": is_pm(request), **workspace_context(request),
    }
    if tab == "gitlab":
        context.update(gitlab_project_context(project, request.workspace, request.GET.get("gitlab_state", "")))
    return render(request, "components/screens/projects/detail.html", context, status=status)


def workspace_project(request, project_id):
    project = get_project(request.workspace, project_id)
    if project is None:
        raise Http404
    return project


@require_POST
@login_required
@transaction.atomic
def project_phase(request, project_id):
    project = workspace_project(request, project_id)
    if not can_manage_project(request, project):
        return HttpResponse(status=403)
    data = request_data(request)
    interactive = data.get("interaction") == "hold"
    previous = project.phase
    form = ProjectPhaseForm(data)
    if form.is_valid():
        try:
            project = set_project_phase(workspace=request.workspace, project_id=project.id, actor=request.user, **form.cleaned_data)
        except (ValidationError, IntegrityError):
            form.add_error(None, _("Another active project already collects this GitLab prefix. Disable collection or change its prefix before reopening."))
        else:
            if not interactive:
                return redirect("project_detail", project_id=project.id)
            events = [
                SSE.patch_elements(render_component(request, "screens/projects/phase-badge", project=project)),
                SSE.patch_elements(render_component(
                    request, "screens/projects/phase-steps", project=project,
                    phase_steps=phase_steps(), can_edit=True,
                )),
            ]
            # Preserve unposted drafts and the active tab/filter. Only prepend
            # the committed transition when it belongs in the current journal.
            if (
                data.get("journal_present") is True
                and previous != project.phase
                and not data.get("journal_kind")
                and str(data.get("journal_page", "1")) == "1"
            ):
                entry = project.journal.filter(kind=JournalKind.PHASE, parent__isnull=True).first()
                events.append(SSE.patch_elements(
                    render_component(request, "screens/projects/journal-entry", project=project, entry=entry),
                    selector=".journal-entries", mode="prepend",
                ))
            events.append(phase_feedback(request, project, data, "success", _("Now in %(phase)s. All saved.") % {"phase": project.get_phase_display()}))
            return DatastarResponse(events)
    if interactive:
        message = " ".join(str(error) for errors in form.errors.values() for error in errors)
        return DatastarResponse([phase_feedback(request, project, data, "error", message)])
    return render_workspace(request, project, phase_form=form, status=400)


def phase_feedback(request, project, data, result, message):
    return SSE.patch_elements(render_component(
        request, "screens/projects/phase-feedback", project=project,
        operation=str(data.get("phase_operation", ""))[:64], result=result, message=message,
    ))


@require_POST
@login_required
def project_journal(request, project_id):
    project = workspace_project(request, project_id)
    form = JournalEntryForm(request.POST)
    if form.is_valid():
        add_entry(workspace=request.workspace, project_id=project.id, actor=request.user, **form.cleaned_data)
        return redirect("project_detail", project_id=project.id)
    return render_workspace(request, project, entry_form=form, status=400)


def journal_options(data):
    kind = data.get("journal_kind", "")
    page = data.get("journal_page", "")
    return {
        "journal_kind": kind if kind in JournalKind.values else "",
        "journal_page": page if isinstance(page, str) and page.isascii() and page.isdecimal() and len(page) <= 8 else "",
    }


def reply_composer_events(request, context, form=None, *, focus_button=False):
    return [SSE.patch_elements(render_component(
        request, "screens/projects/journal-reply-composer", **context, reply_form=form, focus_button=focus_button,
    ))]


@require_http_methods(["GET", "POST"])
@login_required
def project_reply(request, project_id, entry_id):
    project = workspace_project(request, project_id)
    entry = get_object_or_404(project.journal, id=entry_id, parent__isnull=True)
    data = request.POST if request.method == "POST" else request.GET
    context = {"entry": entry, "project": project, **journal_options(data)}
    form = JournalReplyForm(request.POST if request.method == "POST" else None)
    if request.method == "GET":
        cancel = request.GET.get("cancel") == "1"
        return DatastarResponse(reply_composer_events(request, context, None if cancel else form, focus_button=cancel))
    if form.is_valid():
        reply = add_entry(workspace=request.workspace, project_id=project.id, actor=request.user, parent_id=entry_id, **form.cleaned_data)
        if request.headers.get("Datastar-Request") == "true":
            reply.can_edit_body = True
            reply.edit_form = None
            return DatastarResponse([
                SSE.patch_elements(render_component(
                    request, "screens/projects/journal-reply", reply=reply, project=project, **journal_options(data),
                ), selector=f"#journal-replies-{entry.id}", mode="append"),
                *reply_composer_events(request, context, focus_button=True),
            ])
        return journal_redirect(request, project, entry_id, thread_id=entry_id)
    if request.headers.get("Datastar-Request") == "true":
        return DatastarResponse(reply_composer_events(request, context, form))
    return render_workspace(request, project, reply_entry_id=entry_id, reply_form=form, status=400)


def journal_redirect(request, project, entry_id, *, thread_id=None):
    query = {"thread": thread_id} if thread_id is not None else {}
    kind = request.POST.get("journal_kind", "")
    page = request.POST.get("journal_page", "")
    if kind in JournalKind.values:
        query["kind"] = kind
    if page.isascii() and page.isdecimal() and len(page) <= 8 and int(page) > 1:
        query["page"] = page
    url = reverse("project_detail", args=[project.id])
    if query:
        url += "?" + urlencode(query)
    return redirect(url + f"#entry-{entry_id}")


@require_http_methods(["GET", "POST"])
@login_required
def project_journal_edit(request, project_id, entry_id):
    project = workspace_project(request, project_id)
    entry = get_object_or_404(project.journal, id=entry_id)
    if entry.kind == JournalKind.PHASE or not (can_manage_project(request, project) or entry.author_id == request.user.id):
        return HttpResponse(status=403)
    entry.can_edit_body = True
    data = request.POST if request.method == "POST" else request.GET
    context = {"item": entry, "project": project, **journal_options(data)}
    form = JournalReplyForm(request.POST if request.method == "POST" else None, initial={"body": entry.body})
    if request.method == "GET":
        cancel = request.GET.get("cancel") == "1"
        return DatastarResponse([
            SSE.patch_elements(render_component(
                request, "screens/projects/journal-body", **context, edit_form=None if cancel else form,
            )),
            SSE.patch_elements(render_component(
                request, "screens/projects/journal-edit-button", **context,
                edit_form=None if cancel else form, focus_button=cancel,
            )),
        ])
    if form.is_valid():
        saved = edit_entry(workspace=request.workspace, project_id=project.id, entry_id=entry.id, body=form.cleaned_data["body"])
        if request.headers.get("Datastar-Request") == "true":
            return DatastarResponse([
                SSE.patch_elements(render_component(request, "screens/projects/journal-body", item=saved)),
                SSE.patch_elements(render_component(request, "screens/projects/journal-time", item=saved)),
                SSE.patch_elements(render_component(request, "screens/projects/journal-edit-button", **context, focus_button=True)),
            ])
        return journal_redirect(request, project, entry.parent_id or entry.id, thread_id=entry.parent_id)
    if request.headers.get("Datastar-Request") == "true":
        return DatastarResponse([SSE.patch_elements(render_component(
            request, "screens/projects/journal-body", **context, edit_form=form,
        ))])
    return render_workspace(request, project, edit_entry_id=entry.id, edit_form=form, status=400)


@require_POST
@login_required
def project_journal_delete(request, project_id, entry_id):
    project = workspace_project(request, project_id)
    entry = get_object_or_404(project.journal, id=entry_id)
    can_edit = can_manage_project(request, project)
    if entry.kind == JournalKind.PHASE or not (can_edit or entry.author_id == request.user.id):
        return HttpResponse(status=403)
    parent_id = entry.parent_id
    options = journal_options(request_data(request))
    delete_entry(workspace=request.workspace, project_id=project.id, entry_id=entry.id)
    if request.headers.get("Datastar-Request") != "true":
        return journal_redirect(request, project, parent_id or entry_id, thread_id=parent_id)
    if parent_id is not None:
        return DatastarResponse([
            SSE.remove_elements(f"#journal-reply-{entry_id}"),
            SSE.execute_script(f"document.querySelector('#entry-{parent_id} .journal-time')?.focus({{ preventScroll: true }})"),
        ])
    page = options["journal_page"]
    journal = journal_page(request, project, options["journal_kind"], page, can_edit=can_edit)
    if page and int(page) > journal.paginator.num_pages:
        # A now-empty final page has no remaining entry drafts to overwrite.
        entries_event = SSE.patch_elements(render_component(
            request, "screens/projects/journal-entries", project=project, journal=journal, journal_kind=options["journal_kind"],
        ))
    else:
        entries_event = SSE.remove_elements(f"#entry-{entry_id}")
    return DatastarResponse([
        entries_event,
        SSE.patch_elements(render_component(request, "screens/projects/journal-pagination", journal=journal, journal_kind=options["journal_kind"])),
        SSE.patch_elements(render_component(
            request, "screens/projects/journal-open-questions",
            count=project.journal.filter(kind=JournalKind.QUESTION, resolved_at__isnull=True, parent__isnull=True).count(),
        )),
        SSE.execute_script("document.querySelector('.project-composer textarea')?.focus({ preventScroll: true })"),
    ])


@require_POST
@login_required
def project_resolve(request, project_id, entry_id):
    project = workspace_project(request, project_id)
    entry = get_object_or_404(project.journal, id=entry_id, parent__isnull=True, kind=JournalKind.QUESTION)
    if not (can_manage_project(request, project) or entry.author_id == request.user.id):
        return HttpResponse(status=403)
    resolve_question(workspace=request.workspace, project_id=project.id, entry_id=entry.id)
    return redirect("project_detail", project_id=project.id)
