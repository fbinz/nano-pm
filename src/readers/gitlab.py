"""Cached execution view models; rendering never calls the GitLab API."""

from dataclasses import dataclass, field

from django.utils import timezone
from django.utils.dateparse import parse_datetime


@dataclass
class ExecutionSegment:
    x: float
    w: float
    start: str
    end: str
    point: bool = False


@dataclass
class IssueRow:
    id: int
    reference: str
    title: str
    url: str
    state: str
    state_label: str
    unavailable: bool
    segments: list[ExecutionSegment] = field(default_factory=list)
    has_timing: bool = False


def issue_rows(issues, chart_start, chart_end, ppd):
    width = (chart_end - chart_start).days * ppd
    rows = []

    def position(value):
        instant = timezone.localtime(parse_datetime(value))
        fraction = (instant.hour * 3600 + instant.minute * 60 + instant.second) / 86400
        return ((instant.date() - chart_start).days + fraction) * ppd

    for issue in issues:
        row = IssueRow(
            issue.pk, issue.reference, issue.title, issue.web_url,
            issue.state, issue.get_state_display(), issue.unavailable,
        )
        for interval in issue.intervals:
            start, end = interval.get("start"), interval.get("end")
            if not start and not end:
                continue
            row.has_timing = True
            point = not start or (not end and issue.state != "in-progress")
            x = position(start or end)
            if point:
                if 0 <= x < width:
                    row.segments.append(ExecutionSegment(x, 6, start or "", end or "", True))
                continue
            end_x = position(end or timezone.now().isoformat())
            left, right = max(0, x), min(width, end_x)
            if right >= left and right >= 0 and left < width:
                row.segments.append(ExecutionSegment(left, max(2, right - left), start, end or ""))
        rows.append(row)
    return rows


def expanded_projects(request):
    return set(request.session.get(f"gitlab_expanded_{request.workspace.pk}", []))
