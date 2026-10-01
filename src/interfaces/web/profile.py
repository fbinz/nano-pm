"""Self-service account details and workspace-specific Teams addresses."""

from django import forms
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import PasswordChangeForm
from django.contrib.auth.views import PasswordChangeView
from django.core.exceptions import ValidationError
from django.db import transaction
from django.shortcuts import redirect, render
from django.urls import reverse_lazy
from django.utils.translation import gettext_lazy as _
from django.views.decorators.cache import never_cache
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods

from .helpers import is_pm, workspace_context


class ProfileForm(forms.ModelForm):
    teams_upn = forms.EmailField(
        label=_("Teams email address"), required=False, max_length=254,
        widget=forms.EmailInput(attrs={"autocomplete": "off"}),
        help_text=_("Use the email address you sign in to Microsoft Teams with for this workspace. It may differ from your contact email. Leave blank to turn off your mentions."),
    )
    workspace_id = forms.IntegerField(required=False, widget=forms.HiddenInput)

    class Meta:
        model = get_user_model()
        fields = ["first_name", "last_name", "email"]
        labels = {
            "first_name": _("First name"),
            "last_name": _("Last name"),
            "email": _("Email address"),
        }
        widgets = {
            "first_name": forms.TextInput(attrs={"autocomplete": "given-name"}),
            "last_name": forms.TextInput(attrs={"autocomplete": "family-name"}),
            "email": forms.EmailInput(attrs={"autocomplete": "email"}),
        }

    def __init__(self, *args, membership, **kwargs):
        super().__init__(*args, **kwargs)
        self.membership = membership
        if membership is not None:
            self.initial["teams_upn"] = membership.teams_upn
            self.initial["workspace_id"] = membership.workspace_id
        else:
            del self.fields["teams_upn"]
        for field in self.fields.values():
            if not field.widget.is_hidden:
                field.widget.attrs["class"] = "input text-base w-full"

    def clean_teams_upn(self):
        address = self.cleaned_data["teams_upn"].strip().lower()
        if any(char in address for char in '<>&"'):
            raise ValidationError(_("Enter a valid Microsoft sign-in address."))
        return address

    def clean(self):
        data = super().clean()
        expected_workspace = self.membership.workspace_id if self.membership else None
        if data.get("workspace_id") != expected_workspace:
            raise ValidationError(_("The active workspace changed. Reload your profile and try again."))
        return data


@require_http_methods(["GET", "POST"])
@login_required
@never_cache
@sensitive_post_parameters("email", "teams_upn")
def profile(request):
    form = ProfileForm(
        request.POST if request.method == "POST" else None,
        instance=request.user, membership=request.membership,
    )
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            user = form.save(commit=False)
            # Explicit allowlist: posted usernames, user IDs, roles and flags cannot
            # modify another account or grant privileges. Contact fields are global.
            user.save(update_fields=["first_name", "last_name", "email"])
            if request.membership is not None:
                request.membership.teams_upn = form.cleaned_data["teams_upn"]
                request.membership.save(update_fields=["teams_upn"])
        messages.success(request, _("Profile saved."))
        return redirect("profile")
    return render(request, "components/screens/profile/index.html", {
        **workspace_context(request), "user": request.user, "is_pm": is_pm(request), "form": form,
    })


class ProfilePasswordChangeForm(PasswordChangeForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            field.widget.attrs["class"] = "input text-base w-full"


class ProfilePasswordChangeView(PasswordChangeView):
    # Django handles old-password verification, password validators, sensitive
    # POST filtering and updating the current session's authentication hash.
    form_class = ProfilePasswordChangeForm
    template_name = "components/screens/profile/password.html"
    success_url = reverse_lazy("profile")

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context.update({
            **workspace_context(self.request), "user": self.request.user, "is_pm": is_pm(self.request),
        })
        return context

    def form_valid(self, form):
        response = super().form_valid(form)
        messages.success(self.request, _("Password changed."))
        return response
