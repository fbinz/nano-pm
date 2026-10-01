"""PM-only workspace delivery settings and self-service project subscriptions."""

from django import forms
from django.contrib.auth.decorators import login_required
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.cache import never_cache
from django.utils.translation import gettext_lazy as _

from actions.activity import change_set, log_activity, snapshot
from actions.teams_delivery import validate_webhook_url
from data.models import Membership, Project, ProjectSubscription, Workspace
from data.models.project import TEAMS_NOTIFY_EVENT_CHOICES

from .helpers import is_pm, workspace_context
from .public_subscriptions import PublicFollowerDomainsForm, public_subscription, unfollow_public_subscription


class WorkspaceTeamsForm(forms.Form):
    teams_notify_events = forms.MultipleChoiceField(
        label=_("Notify for"), choices=TEAMS_NOTIFY_EVENT_CHOICES,
        required=False, widget=forms.CheckboxSelectMultiple,
    )


class WebhookForm(forms.Form):
    teams_webhook_url = forms.CharField(
        label=_("Microsoft Teams webhook URL"), max_length=2048,
        widget=forms.PasswordInput(attrs={"class": "input text-base w-full", "autocomplete": "new-password"}),
        help_text=_("Paste the URL from your Teams Workflow. Treat it like a password; saved URLs are never displayed."),
    )

    def clean_teams_webhook_url(self):
        value = self.cleaned_data["teams_webhook_url"].strip()
        validate_webhook_url(value)
        return value


@require_http_methods(["GET", "POST"])
@login_required
@sensitive_post_parameters("teams_webhook_url")
def teams_settings(request):
    if not is_pm(request):
        return HttpResponse(status=403)
    workspace = request.workspace
    workspace_form = WorkspaceTeamsForm(
        initial={"teams_notify_events": workspace.teams_notify_events},
    )
    webhook_form = WebhookForm()
    public_followers_form = PublicFollowerDomainsForm(initial={
        "teams_public_subscriber_domains": ", ".join(workspace.teams_public_subscriber_domains),
    })
    if request.method == "POST":
        action = request.POST.get("action")
        updates = None
        if action == "workspace":
            workspace_form = WorkspaceTeamsForm(request.POST)
            if workspace_form.is_valid():
                updates = {"teams_notify_events": workspace_form.cleaned_data["teams_notify_events"]}
        elif action == "webhook":
            webhook_form = WebhookForm(request.POST)
            if webhook_form.is_valid():
                updates = {"teams_webhook_url": webhook_form.cleaned_data["teams_webhook_url"]}
        elif action == "disconnect":
            updates = {"teams_webhook_url": ""}
        elif action == "public_subscribers":
            public_followers_form = PublicFollowerDomainsForm(request.POST)
            if public_followers_form.is_valid():
                updates = {"teams_public_subscriber_domains": public_followers_form.cleaned_data["teams_public_subscriber_domains"]}
        else:
            return HttpResponse(status=400)
        if updates is not None:
            # Each action changes only its own fields; connection changes must
            # never overwrite event preferences (or vice versa).
            before = snapshot(workspace, list(updates))
            for field, value in updates.items():
                setattr(workspace, field, value)
            workspace.save(update_fields=[*updates, "updated_at"])
            log_activity(
                workspace=workspace, actor=request.user, action="workspace.updated", entity=workspace,
                changes=change_set(before, snapshot(workspace, list(updates))),
                skip_empty_changes=True,
            )
            return redirect("teams_settings")
    return render(request, "components/screens/teams/settings.html", {
        **workspace_context(request), "user": request.user, "is_pm": is_pm(request),
        "workspace_form": workspace_form, "webhook_form": webhook_form,
        "public_followers_form": public_followers_form,
        "deliveries": workspace.teams_deliveries.order_by("-created_at", "-id")[:20],
    })


@require_http_methods(["POST"])
@never_cache
@sensitive_post_parameters("teams_email")
def roadmap_subscription(request, token, project_id):
    workspace = get_object_or_404(Workspace, public_roadmap_token=token, public_roadmap_enabled=True)
    membership = Membership.objects.filter(workspace=workspace, user=request.user).first() if request.user.is_authenticated else None
    project = get_object_or_404(Project, pk=project_id, workspace=workspace, completed_at__isnull=True)
    action = request.POST.get("action")
    if membership is None:
        return public_subscription(request, workspace, project, action)
    if action == "follow":
        ProjectSubscription.objects.get_or_create(project=project, membership=membership)
    elif action == "unfollow":
        ProjectSubscription.objects.filter(project=project, membership=membership).delete()
        unfollow_public_subscription(request, project)
    else:
        return HttpResponse(status=400)
    return redirect("public_roadmap", token=token)
