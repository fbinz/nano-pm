from django.conf import settings
from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.core.management import call_command
from django.http import HttpResponse, HttpResponseForbidden
from django.urls import path, include
from django.views.decorators.csrf import csrf_exempt


@csrf_exempt
def __test_reset__(request):
    """Reset DB to the seeded fixture. DEBUG-only — used by the Playwright suite."""
    if not settings.DEBUG:
        return HttpResponseForbidden()
    call_command("seed_data")
    return HttpResponse(status=204)


urlpatterns = [
    path("admin/", admin.site.urls),
    path(
        "accounts/login/",
        auth_views.LoginView.as_view(template_name="accounts/login.html"),
        name="login",
    ),
    path("accounts/logout/", auth_views.LogoutView.as_view(), name="logout"),
    path("__reset__/", __test_reset__, name="__test_reset__"),
    path("", include("interfaces.web.gantt")),
]
