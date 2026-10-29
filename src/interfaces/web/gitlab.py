"""Workspace-scoped GitLab configuration and explicit ownership controls."""

from django import forms
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods

from actions.gitlab_matching import queue_sync, save_binding, transfer_issue
from data.models import GitLabConnection, GitLabIssue, Project
from data.models.gitlab import default_workflow
from interfaces.gitlab.client import encrypt_token, validate_origin
from readers.gitlab import execution_periods

from .helpers import can_manage_project, is_pm, workspace_context
from .detail_forms import DetailForm


class ConnectionForm(DetailForm):
    instance_url = forms.CharField(label=_("GitLab instance URL"), max_length=2048)
    token = forms.CharField(label=_("GitLab API token"), required=False, strip=False,
                           widget=forms.PasswordInput(render_value=False))
    project_ids = forms.CharField(label=_("GitLab project IDs"), required=False)
    group_ids = forms.CharField(label=_("GitLab group IDs"), required=False)

    def clean_instance_url(self):
        return validate_origin(self.cleaned_data["instance_url"])

    def _ids(self, field):
        value = self.cleaned_data[field].replace(",", " ").split()
        if any(not item.isascii() or not item.isdigit() or int(item) <= 0 for item in value):
            raise ValidationError(_("Enter numeric GitLab IDs separated by commas."))
        return sorted(set(int(item) for item in value))

    def clean_project_ids(self):
        return self._ids("project_ids")

    def clean_group_ids(self):
        return self._ids("group_ids")

    def clean(self):
        data = super().clean()
        if not data.get("project_ids") and not data.get("group_ids"):
            raise ValidationError(_("Choose at least one GitLab project or group to search."))
        return data


class WorkflowForm(DetailForm):
    in_progress_labels = forms.CharField(label=_("In-progress labels"), required=False, widget=forms.Textarea)
    done_labels = forms.CharField(label=_("Done labels"), required=False, widget=forms.Textarea)
    not_started_labels = forms.CharField(label=_("Not-started labels"), required=False, widget=forms.Textarea)
    fallback = forms.ChoiceField(label=_("Unmatched issue state"), choices=GitLabIssue.State.choices)

    @staticmethod
    def initial_for(mapping):
        return {
            "in_progress_labels": "\n".join(mapping["in-progress"]),
            "done_labels": "\n".join(mapping["done"]),
            "not_started_labels": "\n".join(mapping["not-started"]),
            "fallback": mapping["fallback"],
        }

    def mapping(self):
        return {
            state: list(dict.fromkeys(line.strip() for line in self.cleaned_data[field].splitlines() if line.strip()))
            for state, field in (
                ("in-progress", "in_progress_labels"), ("done", "done_labels"), ("not-started", "not_started_labels"),
            )
        } | {"fallback": self.cleaned_data["fallback"]}


class BindingForm(WorkflowForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.order_fields(["prefix", "collect", "override_workflow", "in_progress_labels", "done_labels", "not_started_labels", "fallback"])
        for name in ("collect", "override_workflow"):
            self.fields[name].widget.attrs["class"] = "checkbox"

    prefix = forms.CharField(label=_("GitLab title prefix"), max_length=200)
    collect = forms.BooleanField(label=_("Collect matching GitLab issues"), required=False)
    override_workflow = forms.BooleanField(label=_("Override workspace workflow"), required=False)

    def clean_prefix(self):
        value = self.cleaned_data["prefix"].strip()
        if ":" in value:
            raise ValidationError(_("Enter a project prefix without a colon."))
        return value


def settings_context(workspace):
    connection = GitLabConnection.objects.filter(workspace=workspace).first()
    return {
        "gitlab_connection": connection,
        "gitlab_connection_form": ConnectionForm(initial={
            "instance_url": connection.instance_url if connection else "https://gitlab.com",
            "project_ids": ", ".join(map(str, connection.project_ids)) if connection else "",
            "group_ids": ", ".join(map(str, connection.group_ids)) if connection else "",
        }),
        "gitlab_workflow_form": WorkflowForm(initial=WorkflowForm.initial_for(
            connection.workflow if connection else default_workflow(),
        )),
    }


def settings_redirect():
    return redirect(reverse("workspace_settings") + "#workspace-gitlab-settings")


@require_http_methods(["GET", "POST"])
@login_required
@sensitive_post_parameters("token")
def settings(request):
    if not is_pm(request):
        return HttpResponse(status=403)
    if request.method == "GET":
        return settings_redirect()
    context = settings_context(request.workspace)
    connection = context["gitlab_connection"]
    form = context["gitlab_connection_form"]
    workflow_form = context["gitlab_workflow_form"]
    if request.method == "POST":
        action = request.POST.get("action")
        if action == "connect":
            form = ConnectionForm(request.POST)
            if form.is_valid():
                try:
                    with transaction.atomic():
                        current = GitLabConnection.objects.filter(workspace=request.workspace).first()
                        data = form.cleaned_data
                        if current and current.instance_url != data["instance_url"]:
                            raise ValidationError(_("Disconnecting does not reset ownership. Use a new workspace for a different GitLab instance."))
                        if not data["token"] and (not current or not current.token_ciphertext):
                            raise ValidationError(_("Enter a GitLab API token."))
                        ciphertext = encrypt_token(data["token"]) if data["token"] else current.token_ciphertext
                        connection = current or GitLabConnection(workspace=request.workspace, instance_url=data["instance_url"])
                        connection.token_ciphertext = ciphertext
                        connection.project_ids = data["project_ids"]
                        connection.group_ids = data["group_ids"]
                        connection.enabled = True
                        connection.save()
                        queue_sync(connection)
                    return settings_redirect()
                except ValidationError as error:
                    form.add_error(None, error)
        elif connection and action in ("disconnect", "sync", "workflow"):
            if action == "workflow":
                workflow_form = WorkflowForm(request.POST)
                if not workflow_form.is_valid():
                    return render_settings(request, connection, form, workflow_form, status=400)
            with transaction.atomic():
                connection.refresh_from_db()
                if action == "disconnect":
                    connection.enabled = False
                    connection.token_ciphertext = ""
                elif action == "workflow":
                    connection.workflow = workflow_form.mapping()
                connection.save()
                queue_sync(connection)
            return settings_redirect()
        else:
            return HttpResponse(status=400)
    return render_settings(request, connection, form, workflow_form)


def render_settings(request, connection, form, workflow_form, status=200):
    from .workload import settings_context as workload_settings_context

    return render(request, "components/screens/workspaces/settings.html", {
        **workspace_context(request), **workload_settings_context(request.workspace),
        "is_pm": True, "gitlab_connection": connection,
        "gitlab_connection_form": form, "gitlab_workflow_form": workflow_form,
    }, status=status)


def project_context(project, workspace):
    connection = GitLabConnection.objects.filter(workspace=workspace).first()
    binding = getattr(project, "gitlab_binding", None)
    mapping = binding.workflow if binding and binding.workflow else connection.workflow if connection else default_workflow()
    form = BindingForm(initial={
        **WorkflowForm.initial_for(mapping), "prefix": binding.prefix if binding else "",
        "collect": binding.collect if binding else True,
        "override_workflow": bool(binding and binding.workflow),
    })
    issues = list(GitLabIssue.objects.filter(owner=project, connection__workspace=workspace)
                  .select_related("owner__gitlab_binding", "connection"))
    for issue in issues:
        issue.execution_periods = execution_periods(issue.intervals)
    return {
        "gitlab_connection": connection, "gitlab_binding_form": form, "gitlab_issues": issues,
        "gitlab_done_count": sum(issue.state == "done" for issue in issues),
        "gitlab_destinations": Project.objects.filter(workspace=workspace).exclude(pk=project.pk).order_by("name"),
    }


@require_http_methods(["POST"])
@login_required
def project_settings(request, project_id):
    project = get_object_or_404(Project, pk=project_id, workspace=request.workspace)
    if not can_manage_project(request, project):
        return HttpResponse(status=403)
    connection = get_object_or_404(GitLabConnection, workspace=request.workspace)
    form = BindingForm(request.POST)
    if form.is_valid():
        try:
            save_binding(
                workspace=request.workspace, project_id=project.pk,
                prefix=form.cleaned_data["prefix"], collect=form.cleaned_data["collect"],
                workflow=form.mapping() if form.cleaned_data["override_workflow"] else None,
            )
            return redirect("project_detail", project_id=project.pk)
        except ValidationError as error:
            form.add_error(None, error)
    return render(request, "components/screens/gitlab/binding-errors.html", {
        **workspace_context(request), "is_pm": is_pm(request),
        "form": form, "project": project, "connection": connection,
    }, status=400)


@require_http_methods(["POST"])
@login_required
def issue_transfer(request, issue_id):
    issue = get_object_or_404(GitLabIssue, pk=issue_id, connection__workspace=request.workspace, retired=False)
    try:
        target_id = int(request.POST.get("project_id", ""))
    except (TypeError, ValueError):
        return HttpResponse(status=400)
    target = get_object_or_404(Project, pk=target_id, workspace=request.workspace)
    if not issue.owner or not can_manage_project(request, issue.owner) or not can_manage_project(request, target):
        return HttpResponse(status=403)
    transfer_issue(workspace=request.workspace, issue_id=issue.pk, project_id=target.pk)
    return redirect("project_detail", project_id=target.pk)


@require_http_methods(["POST"])
@login_required
def toggle_overlay(request, project_id):
    get_object_or_404(Project, pk=project_id, workspace=request.workspace)
    key = f"gitlab_expanded_{request.workspace.pk}"
    expanded = set(request.session.get(key, []))
    expanded.symmetric_difference_update({project_id})
    request.session[key] = sorted(expanded)
    from datastar_py.django import DatastarResponse
    from .helpers import patch_chart
    return DatastarResponse([patch_chart(request)])
