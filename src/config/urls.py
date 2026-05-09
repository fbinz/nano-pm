from django.conf import settings
from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.core.management import call_command
from django.http import HttpResponse
from django.urls import path, include
from django.views.decorators.csrf import csrf_exempt


@csrf_exempt
def __test_reset__(request):
    """Reset DB to the seeded fixture. Used by the Playwright suite."""
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
    path("", include("interfaces.web.gantt")),
]

# `/__reset__/` is mounted ONLY when DJANGO_ENABLE_TEST_RESET is set. With it
# off (the default), the URL doesn't resolve at all — production gets a 404
# instead of relying on a runtime gate that DEBUG=True could accidentally
# bypass.
if settings.ENABLE_TEST_RESET:
    urlpatterns.insert(
        0, path("__reset__/", __test_reset__, name="__test_reset__")
    )
