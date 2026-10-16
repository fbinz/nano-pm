"""Public roadmap state loading.

The public roadmap intentionally does not reuse the private chart reader.
Viewers see workspace, projects (including responsible people's display names)
and milestones, plus their own subscription flags when permitted. Recipient
addresses and browser capabilities are never exposed.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta

from django.db.models import Prefetch
from django.utils.translation import gettext as _, ngettext

from data.models import Membership, Milestone, Person, Project, PublicProjectSubscription, Workspace
from readers.chart import ChartState
from readers.chart_view import ChartVM, build_chart_vm


@dataclass(frozen=True)
class PublicMilestoneVM:
    key: str
    title: str
    description: str
    date: date
    relative_date: str
    x: int
    y: int


@dataclass(frozen=True)
class PublicProjectVM:
    key: str
    name: str
    description: str
    color: str
    responsible_names: list[str] = field(default_factory=list)
    milestones: list[PublicMilestoneVM] = field(default_factory=list)
    subscription_project_id: int | None = None
    following: bool = False
    row_height: int = 48


@dataclass(frozen=True)
class PublicRoadmapVM:
    title: str
    description: str
    workspace_name: str
    projects: list[PublicProjectVM]
    milestones: list[PublicMilestoneVM]
    chart: ChartVM
    can_follow: bool = False
    has_teams_upn: bool = False
    is_public_subscriber: bool = False
    public_subscriber_domains: list[str] = field(default_factory=list)


def _relative_date_label(target: date, today: date) -> str:
    days = (target - today).days
    if days == 0:
        return _("today")
    if days == 1:
        return _("tomorrow")
    if days == -1:
        return _("yesterday")

    abs_days = abs(days)
    if abs_days < 14:
        value = abs_days
        future = ngettext("in %(count)d day", "in %(count)d days", value)
        past = ngettext("%(count)d day ago", "%(count)d days ago", value)
    elif abs_days < 60:
        value = max(1, (abs_days + 3) // 7)
        future = ngettext("in %(count)d week", "in %(count)d weeks", value)
        past = ngettext("%(count)d week ago", "%(count)d weeks ago", value)
    elif abs_days < 730:
        value = max(1, (abs_days + 15) // 30)
        future = ngettext("in %(count)d month", "in %(count)d months", value)
        past = ngettext("%(count)d month ago", "%(count)d months ago", value)
    else:
        value = max(1, (abs_days + 182) // 365)
        future = ngettext("in %(count)d year", "in %(count)d years", value)
        past = ngettext("%(count)d year ago", "%(count)d years ago", value)

    return (future if days > 0 else past) % {"count": value}


def get_public_roadmap(token: str, user=None, browser_key_hash=None) -> PublicRoadmapVM | None:
    """Return a sanitized roadmap for an enabled public token, else None."""
    try:
        workspace = Workspace.objects.get(
            public_roadmap_enabled=True,
            public_roadmap_token=token,
        )
    except Workspace.DoesNotExist:
        return None

    membership = None
    if user is not None and user.is_authenticated:
        membership = Membership.objects.filter(workspace=workspace, user=user).first()
    followed_ids = set(membership.subscriptions.values_list("project_id", flat=True)) if membership else set()
    if browser_key_hash:
        followed_ids.update(PublicProjectSubscription.objects.filter(
            project__workspace=workspace, browser_key_hash=browser_key_hash,
        ).values_list("project_id", flat=True))
    today = date.today()
    projects = list(
        Project.objects.filter(workspace=workspace, completed_at__isnull=True)
        .order_by("order", "id")
        .prefetch_related(
            Prefetch(
                "responsible_people",
                queryset=Person.objects.filter(workspace=workspace).only("name").order_by("name", "id"),
                to_attr="public_responsible_people",
            ),
            Prefetch(
                "milestones",
                queryset=Milestone.objects.select_related("task").filter(date__gte=today).order_by("date", "id"),
            )
        )
    )
    # Build only shared grid geometry, without private task/people/dependency VMs.
    chart_start = today - timedelta(days=7)
    latest = max((m.date for p in projects for m in p.milestones.all()), default=today)
    chart_end = max(today + timedelta(days=60), latest + timedelta(days=14))
    chart = build_chart_vm(ChartState(
        projects=[], people=[], deps=[], today=today, today_fraction=0,
        chart_start=chart_start, chart_end=chart_end,
    ), px_per_day=28)
    project_vms = []
    timeline_milestones = []
    for index, project in enumerate(projects, start=1):
        project_key = f"p{index}"
        milestones = []
        lane_ends = []
        for milestone_index, milestone in enumerate(project.milestones.all(), start=1):
            task = milestone.task
            milestone_date = task.end if task is not None else milestone.date
            relative_date = _relative_date_label(milestone_date, today)
            title = milestone.title
            x = (milestone_date - chart_start).days * chart.px_per_day
            # Stack nearby markers so labels and hit targets never overlap.
            lane = next((i for i, end in enumerate(lane_ends) if end <= x - 12), len(lane_ends))
            if lane == len(lane_ends):
                lane_ends.append(0)
            lane_ends[lane] = x + 252
            milestones.append(PublicMilestoneVM(
                key=f"{project_key}-m{milestone_index}",
                title=title,
                description=milestone.description,
                date=milestone_date,
                relative_date=relative_date,
                x=x,
                y=8 + lane * 44,
            ))
        timeline_milestones.extend(milestones)

        project_vms.append(PublicProjectVM(
            key=project_key,
            name=project.name,
            description=project.description.strip(),
            color=project.color,
            responsible_names=[person.name for person in project.public_responsible_people],
            milestones=milestones,
            subscription_project_id=project.id,
            following=project.id in followed_ids,
            row_height=max(48, len(lane_ends) * 44 + 4),
        ))

    return PublicRoadmapVM(
        title=workspace.public_roadmap_display_title,
        description=workspace.public_roadmap_description.strip(),
        workspace_name=workspace.name,
        projects=project_vms,
        milestones=timeline_milestones,
        chart=chart,
        can_follow=True,
        has_teams_upn=bool(membership and membership.teams_upn),
        is_public_subscriber=membership is None,
        public_subscriber_domains=workspace.teams_public_subscriber_domains,
    )
