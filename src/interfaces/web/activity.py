"""Activity log page."""

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from readers import get_activity_events

from .helpers import is_pm, workspace_context


@login_required
def activity_page(request: HttpRequest) -> HttpResponse:
    return render(
        request,
        "components/screens/activity/index.html",
        {
            "events": get_activity_events(request.workspace),
            "user": request.user,
            "is_pm": is_pm(request),
            **workspace_context(request),
        },
    )
