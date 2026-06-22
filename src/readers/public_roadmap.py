"""Public roadmap state loading.

The public roadmap intentionally does not reuse the private chart reader: it
loads only workspace, projects and milestones so tasks, people, dependencies,
and internal planning state cannot leak through the public page.
"""

from dataclasses import dataclass, field
from datetime import date

from django.db.models import Prefetch
from django.utils.translation import gettext as _, ngettext

from data.models import Milestone, Project, Workspace


@dataclass(frozen=True)
class PublicMilestoneVM:
    title: str
    description: str
    date: date
    relative_date: str


@dataclass(frozen=True)
class PublicProjectVM:
    key: str
    name: str
    description: str
    color: str
    milestones: list[PublicMilestoneVM] = field(default_factory=list)


@dataclass(frozen=True)
class PublicTimelineMilestoneVM:
    title: str
    description: str
    date: date
    relative_date: str
    project_key: str
    project_name: str
    project_color: str


@dataclass(frozen=True)
class PublicRoadmapVM:
    title: str
    description: str
    workspace_name: str
    projects: list[PublicProjectVM]
    milestones: list[PublicTimelineMilestoneVM]


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


def get_public_roadmap(token: str) -> PublicRoadmapVM | None:
    """Return a sanitized roadmap for an enabled public token, else None."""
    try:
        workspace = Workspace.objects.get(
            public_roadmap_enabled=True,
            public_roadmap_token=token,
        )
    except Workspace.DoesNotExist:
        return None

    today = date.today()
    projects = list(
        Project.objects.filter(workspace=workspace, completed_at__isnull=True)
        .order_by("order", "id")
        .prefetch_related(
            Prefetch(
                "milestones",
                queryset=Milestone.objects.filter(date__gte=today).order_by("date", "id"),
            )
        )
    )
    project_vms = []
    timeline_milestones = []
    for index, project in enumerate(projects, start=1):
        project_key = f"p{index}"
        milestones = []
        for milestone in project.milestones.all():
            relative_date = _relative_date_label(milestone.date, today)
            milestones.append(PublicMilestoneVM(
                title=milestone.title,
                description=milestone.description,
                date=milestone.date,
                relative_date=relative_date,
            ))
            timeline_milestones.append(PublicTimelineMilestoneVM(
                title=milestone.title,
                description=milestone.description,
                date=milestone.date,
                relative_date=relative_date,
                project_key=project_key,
                project_name=project.name,
                project_color=project.color,
            ))

        project_vms.append(PublicProjectVM(
            key=project_key,
            name=project.name,
            description=project.description.strip(),
            color=project.color,
            milestones=milestones,
        ))

    timeline_milestones.sort(key=lambda milestone: (milestone.date, milestone.project_name, milestone.title))

    return PublicRoadmapVM(
        title=workspace.public_roadmap_display_title,
        description=workspace.public_roadmap_description.strip(),
        workspace_name=workspace.name,
        projects=project_vms,
        milestones=timeline_milestones,
    )
