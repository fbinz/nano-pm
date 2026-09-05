"""Activity log page."""

from django.contrib.auth.decorators import login_required
from django.core.paginator import Paginator
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from readers import get_activity_events

from .helpers import is_pm, workspace_context


@login_required
def activity_page(request: HttpRequest) -> HttpResponse:
    paginator = Paginator(get_activity_events(request.workspace), 25)
    page_obj = paginator.get_page(request.GET.get("page"))
    return render(
        request,
        "components/screens/activity/index.html",
        {
            "events": page_obj.object_list,
            "page_obj": page_obj,
            "page_range": paginator.get_elided_page_range(page_obj.number),
            "pagination_ellipsis": paginator.ELLIPSIS,
            "user": request.user,
            "is_pm": is_pm(request),
            **workspace_context(request),
        },
    )
