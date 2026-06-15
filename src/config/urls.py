from django.conf import settings
from django.contrib import admin
from django.contrib.auth import get_user_model, login, views as auth_views
from django.core.management import call_command
from django.db import OperationalError, connection
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect, render
from django.urls import path, include
from django.utils.translation import gettext as _
from django.views.decorators.csrf import csrf_exempt
from django.views.i18n import JavaScriptCatalog

from data.models import Invitation, Membership, WorkspaceRole


@csrf_exempt
def __test_reset__(request):
    """Reset DB to the seeded fixture. Used by the Playwright suite."""
    call_command("seed_data")
    return HttpResponse(status=204)


def healthz(request):
    """Liveness + readiness for CapRover / load balancers.

    Pings the DB with a one-row SELECT — cheap, but catches the common
    failure modes (volume not mounted, file permissions, WAL lock stuck).
    Returns 200 OK on success, 503 with the error class name on failure.
    No auth, no CSRF, no DB session writes.
    """
    try:
        with connection.cursor() as c:
            c.execute("SELECT 1")
            c.fetchone()
    except OperationalError as e:
        return HttpResponse(f"db: {type(e).__name__}", status=503, content_type="text/plain")
    return HttpResponse("ok", content_type="text/plain")


def invite_accept(request: HttpRequest, token: str):
    try:
        inv = Invitation.objects.select_related("workspace", "person").get(token=token)
    except Invitation.DoesNotExist:
        return HttpResponse(_("Invalid or expired invite link."), status=404)

    if request.method == "GET":
        return render(request, "accounts/invite.html", {
            "workspace_name": inv.workspace.name,
        })

    User = get_user_model()
    username = request.POST.get("username", "").strip()
    password = request.POST.get("password", "")
    if not username or not password:
        return render(request, "accounts/invite.html", {
            "workspace_name": inv.workspace.name,
            "error": _("Username and password are required."),
        })
    if User.objects.filter(username=username).exists():
        return render(request, "accounts/invite.html", {
            "workspace_name": inv.workspace.name,
            "error": _("That username is already taken."),
        })
    user = User.objects.create_user(username=username, password=password)
    Membership.objects.create(user=user, workspace=inv.workspace, role=WorkspaceRole.MEMBER)
    if inv.person and inv.person.user is None:
        inv.person.user = user
        inv.person.save()
    login(request, user)
    request.session["active_workspace_id"] = inv.workspace_id
    return redirect("/")


urlpatterns = [
    path("healthz", healthz, name="healthz"),
    path("admin/", admin.site.urls),
    path(
        "accounts/login/",
        auth_views.LoginView.as_view(template_name="accounts/login.html"),
        name="login",
    ),
    path("accounts/logout/", auth_views.LogoutView.as_view(), name="logout"),
    # set_language view — POST {language, next} to switch the active locale
    # (persisted in the language cookie / session). Powers the sidebar switcher.
    path("i18n/", include("django.conf.urls.i18n")),
    # Serves the djangojs message catalog as a JS module exposing gettext()
    # for client-side strings in static/js/nano.js.
    path("jsi18n/", JavaScriptCatalog.as_view(), name="javascript-catalog"),
    path("invite/<str:token>/", invite_accept, name="invite_accept"),
    path("", include("interfaces.web")),
]

# `/__reset__/` is mounted ONLY when DJANGO_ENABLE_TEST_RESET is set. With it
# off (the default), the URL doesn't resolve at all — production gets a 404
# instead of relying on a runtime gate that DEBUG=True could accidentally
# bypass.
if settings.ENABLE_TEST_RESET:
    urlpatterns.insert(
        0, path("__reset__/", __test_reset__, name="__test_reset__")
    )
