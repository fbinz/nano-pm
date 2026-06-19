"""Public roadmap state loading.

The public roadmap intentionally does not reuse the private chart reader: it
loads only workspace, projects and milestones so tasks, people, dependencies,
and internal planning state cannot leak through the public page.
"""

from dataclasses import dataclass, field
from datetime import date

from django.db.models import Prefetch

from data.models import Milestone, Project, Workspace


@dataclass(frozen=True)
class PublicMilestoneVM:
    title: str
    description: str
    date: date


@dataclass(frozen=True)
class PublicProjectVM:
    name: str
    color: str
    milestones: list[PublicMilestoneVM] = field(default_factory=list)


@dataclass(frozen=True)
class PublicRoadmapVM:
    title: str
    description: str
    workspace_name: str
    projects: list[PublicProjectVM]


def get_public_roadmap(token: str) -> PublicRoadmapVM | None:
    """Return a sanitized roadmap for an enabled public token, else None."""
    try:
        workspace = Workspace.objects.get(
            public_roadmap_enabled=True,
            public_roadmap_token=token,
        )
    except Workspace.DoesNotExist:
        return None

    projects = list(
        Project.objects.filter(workspace=workspace, completed_at__isnull=True)
        .order_by("order", "id")
        .prefetch_related(
            Prefetch(
                "milestones",
                queryset=Milestone.objects.order_by("date", "id"),
            )
        )
    )

    project_vms = []
    for project in projects:
        milestones = [
            PublicMilestoneVM(
                title=milestone.title,
                description=milestone.description,
                date=milestone.date,
            )
            for milestone in project.milestones.all()
        ]
        if milestones:
            project_vms.append(PublicProjectVM(
                name=project.name,
                color=project.color,
                milestones=milestones,
            ))

    return PublicRoadmapVM(
        title=workspace.public_roadmap_display_title,
        description=workspace.public_roadmap_description.strip(),
        workspace_name=workspace.name,
        projects=project_vms,
    )
