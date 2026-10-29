"""Cached execution view models; rendering never calls the GitLab API."""

from dataclasses import dataclass, field
from datetime import datetime

from django.utils import timezone
from django.utils.dateparse import parse_datetime


@dataclass
class ExecutionSegment:
    x: float
    w: float
    start: str
    end: str


@dataclass
class ExecutionPeriod:
    start: str
    end: str
    start_at: datetime | None
    end_at: datetime | None

    @property
    def same_day(self):
        return bool(self.start_at and self.end_at and self.start_at.date() == self.end_at.date())


def execution_periods(intervals):
    """Readable local dates without changing the cached source timestamps."""
    periods = []
    for interval in intervals:
        start, end = interval.get("start") or "", interval.get("end") or ""
        if not start and not end:
            continue
        periods.append(ExecutionPeriod(
            start, end,
            timezone.localtime(parse_datetime(start)) if start else None,
            timezone.localtime(parse_datetime(end)) if end else None,
        ))
    return periods


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

    def position(value, *, end_of_day=False):
        day = timezone.localtime(parse_datetime(value)).date()
        return ((day - chart_start).days + int(end_of_day)) * ppd

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
            # Snap geometry only, retaining exact/unknown source timestamps.
            # A lone boundary gets its whole local day; ongoing work includes
            # today. Date arithmetic also keeps DST days one cell wide.
            finish = end or (timezone.now().isoformat() if issue.state == "in-progress" else start)
            left = max(0, position(start or end))
            right = min(width, position(finish, end_of_day=True))
            if right > left:
                row.segments.append(ExecutionSegment(left, right - left, start or "", end or ""))
        rows.append(row)
    return rows


def expanded_projects(request):
    return set(request.session.get(f"gitlab_expanded_{request.workspace.pk}", []))
