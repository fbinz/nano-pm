"""Anonymous roadmap subscriptions: private browser ownership, no email verification."""

import hashlib
import secrets

from django import forms
from django.conf import settings
from django.http import HttpResponse
from django.shortcuts import redirect, render
from django.utils.translation import gettext_lazy as _

from actions.public_subscriptions import normalize_domains, validate_public_email
from data.models import PublicProjectSubscription
from readers.public_roadmap import get_public_roadmap

COOKIE_NAME = "nano_roadmap_follower"
COOKIE_SALT = "public-roadmap-follower"
COOKIE_AGE = 365 * 24 * 60 * 60


class PublicFollowerDomainsForm(forms.Form):
    teams_public_subscriber_domains = forms.CharField(
        label=_("Allowed domains for public followers"), required=False, max_length=2000,
        widget=forms.TextInput(attrs={"class": "input text-base w-full", "placeholder": "mycompany.com"}),
        help_text=_("Comma-separated domains. Only exact matches are allowed; list subdomains separately. Leave blank to allow any email domain. Email addresses are not verified."),
    )

    def clean_teams_public_subscriber_domains(self):
        return normalize_domains(self.cleaned_data["teams_public_subscriber_domains"])


class PublicFollowForm(forms.Form):
    teams_email = forms.EmailField(
        label=_("Teams email address"), max_length=254,
        widget=forms.EmailInput(attrs={"class": "input text-base w-full", "autocomplete": "email"}),
        help_text=_("Use your own Microsoft Teams sign-in address. You need access to this workspace's Teams channel. No confirmation email will be sent."),
    )

    def __init__(self, *args, domains, **kwargs):
        super().__init__(*args, **kwargs)
        self.domains = domains

    def clean_teams_email(self):
        return validate_public_email(self.cleaned_data["teams_email"], self.domains)


def _browser_key(request):
    return request.get_signed_cookie(COOKIE_NAME, default="", salt=COOKIE_SALT, max_age=COOKIE_AGE)


def _key_hash(key):
    return hashlib.sha256(key.encode()).hexdigest() if key else None


def render_public_roadmap(request, token, *, form=None, project=None, status=200):
    key = _browser_key(request)
    vm = get_public_roadmap(token, user=request.user, browser_key_hash=_key_hash(key))
    if vm is None:
        return HttpResponse(status=404)
    # One-shot PRG handoff: only the submitting browser receives its validated
    # address. The client persists it locally; never put an address in the URL.
    saved_email = ""
    pending = request.session.get("public_follow_email")
    if pending and pending.get("roadmap") == token:
        saved_email = request.session.pop("public_follow_email")["email"]
    response = render(request, "public/roadmap.html", {
        "vm": vm, "token": token,
        "public_follow_form": form if form is not None else PublicFollowForm(domains=vm.public_subscriber_domains),
        "subscription_project": project,
        "saved_follow_email": saved_email,
    }, status=status)
    if vm.is_public_subscriber and not key:
        response.set_signed_cookie(
            COOKIE_NAME, secrets.token_urlsafe(32), salt=COOKIE_SALT, max_age=COOKIE_AGE,
            httponly=True, secure=request.is_secure() or settings.SESSION_COOKIE_SECURE,
            samesite="Lax", path="/roadmap/",
        )
    return response


def unfollow_public_subscription(request, project):
    key_hash = _key_hash(_browser_key(request))
    if key_hash:
        PublicProjectSubscription.objects.filter(project=project, browser_key_hash=key_hash).delete()


def public_subscription(request, workspace, project, action):
    key_hash = _key_hash(_browser_key(request))
    if key_hash is None:
        return HttpResponse(status=403)
    if action == "unfollow":
        # Never look up a subscription by its email or by a client-supplied ID.
        # Owners may still unfollow after the PM changes the domain restrictions.
        unfollow_public_subscription(request, project)
    elif action == "follow":
        form = PublicFollowForm(request.POST, domains=workspace.teams_public_subscriber_domains)
        if not form.is_valid():
            return render_public_roadmap(request, workspace.public_roadmap_token, form=form, project=project, status=400)
        PublicProjectSubscription.objects.update_or_create(
            project=project, browser_key_hash=key_hash,
            defaults={"teams_email": form.cleaned_data["teams_email"]},
        )
        request.session["public_follow_email"] = {
            "roadmap": workspace.public_roadmap_token,
            "email": form.cleaned_data["teams_email"],
        }
    else:
        return HttpResponse(status=400)
    return redirect("public_roadmap", token=workspace.public_roadmap_token)
