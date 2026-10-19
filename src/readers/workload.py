"""Workload estimates, project guidance and respondent-only summaries."""

from datetime import timedelta
from hashlib import sha256

from django.db.models import OuterRef, Prefetch, Q, Subquery
from django.utils import timezone

from actions.manage_workload import participates
from data.models import (
    Membership,
    Person,
    Project,
    Team,
    WorkloadCategory,
    WorkloadProjectAllocation,
    WorkloadReport,
)
from data.models.project import PROJECT_COLORS


def donut_arc(amount, offset, gap):
    gap = 0 if amount == 100 else min(gap, amount / 2)
    return {
        "percentage": f"{amount:.6g}",
        "dasharray": f"{max(0, amount - gap):.6g} {100 - amount + gap:.6g}",
        "offset": f"{-offset - gap / 2:.6g}",
    }


def donut_vm(allocations, chart_id):
    """Read-only geometry on the same overall-workload scale as the editor."""
    rows, offset = [], 0
    for index, allocation in enumerate(allocations):
        value = allocation["percentage"]
        field = f"{chart_id}-category-{index}"
        projects, project_offset = [], offset
        for project_index, project in enumerate(allocation["projects"]):
            projects.append(
                {
                    "field": f"{field}-project-{project_index}",
                    "project": {
                        "name": project["project_label"],
                        "color": project["color"],
                    },
                    "value": project["percentage"],
                    "arc": donut_arc(project["percentage"], project_offset, 0.4),
                }
            )
            project_offset += project["percentage"]
        unspecified = max(0, value - sum(p["value"] for p in projects))
        rows.append(
            {
                "field": field,
                "category": {
                    "name": allocation["name"],
                    "supports_projects": allocation["supports_projects"],
                },
                "color": allocation["color"],
                "value": value,
                "arc": donut_arc(value, offset, 0.8),
                "projects": projects,
                "has_projects": any(p["value"] for p in projects),
                "unspecified": round(unspecified, 6),
                "remainder_arc": donut_arc(unspecified, project_offset, 0.4),
            }
        )
        offset += value
    return {
        "rows": rows,
        "total": round(offset, 6),
        "remainder": max(0, round(100 - offset, 6)),
        "has_projects": any(row["has_projects"] for row in rows),
    }


def reports(workspace):
    return WorkloadReport.objects.filter(workspace=workspace).prefetch_related(
        Prefetch(
            "allocations__projects",
            queryset=WorkloadProjectAllocation.objects.select_related("project"),
        )
    )


def report_vm(report):
    allocations = []
    for index, allocation in enumerate(report.allocations.all()):
        projects = [
            {
                "key": project.project_id or project.project_label,
                "project_label": project.project_label,
                "percentage": project.percentage,
                "color": project.project.color
                if project.project
                else PROJECT_COLORS[
                    sha256(project.project_label.encode()).digest()[0]
                    % len(PROJECT_COLORS)
                ],
            }
            for project in allocation.projects.all()
        ]
        allocations.append(
            {
                "key": allocation.category_id or allocation.category_label,
                "name": allocation.category_label,
                "percentage": allocation.percentage,
                "supports_projects": allocation.supports_projects,
                "projects": projects,
                "unspecified": allocation.percentage
                - sum(p["percentage"] for p in projects),
                "color": PROJECT_COLORS[
                    ((allocation.category_id - 1) if allocation.category_id else index)
                    % len(PROJECT_COLORS)
                ],
            }
        )
    return {
        "id": report.id,
        "user_label": report.user_label,
        "reviewed_at": report.reviewed_at,
        "outdated": report.reviewed_at < timezone.now() - timedelta(days=90),
        "allocations": allocations,
    }


def checkin_context(request):
    """Workspace-wide recurring check-in, never during an SSE patch."""
    membership = getattr(request, "membership", None)
    if (
        request.method != "GET"
        or request.path == "/profile/workload/"
        or not participates(membership)
        or not membership.workspace.workload_checkin_enabled
    ):
        return None
    now = timezone.now()
    if membership.workload_snoozed_until and membership.workload_snoozed_until > now:
        return None
    latest = WorkloadReport.objects.filter(
        workspace=request.workspace, user=request.user
    ).first()
    if latest and latest.reviewed_at > now - timedelta(
        days=membership.workspace.workload_checkin_interval_days
    ):
        return None
    if not WorkloadCategory.objects.filter(workspace=request.workspace, active=True).exists():
        return None
    return {
        **personal(request.workspace, request.user, checkin=True),
        "dismissal_key": f"workload-checkin:{membership.pk}:{latest.pk if latest else 'new'}:"
        f"{latest.reviewed_at.isoformat() if latest else ''}:{membership.workload_snoozed_until}:"
        f"{membership.workspace.workload_checkin_interval_days}",
    }


def personal(workspace, user, data=None, *, checkin=False):
    history = list(reports(workspace).filter(user=user)[:20])
    current = history[0] if history else None
    existing = {a.category_id: a for a in current.allocations.all()} if current else {}
    projects = list(
        Project.objects.filter(workspace=workspace, completed_at__isnull=True)
    )
    people = Person.objects.filter(workspace=workspace, user=user)
    today = timezone.localdate()
    suggested_ids = set(
        Project.objects.filter(workspace=workspace, completed_at__isnull=True)
        .filter(
            Q(responsible_people__in=people)
            | Q(
                tasks__assignees__in=people,
                tasks__start__lte=today,
                tasks__end__gt=today,
            )
        )
        .values_list("id", flat=True)
    )
    rows = []
    for c in WorkloadCategory.objects.filter(workspace=workspace, active=True):
        old = existing.get(c.id)
        old_projects = (
            {p.project_id: p.percentage for p in old.projects.all()} if old else {}
        )
        rows.append(
            {
                "category": c,
                "color": PROJECT_COLORS[(c.id - 1) % len(PROJECT_COLORS)],
                "field": f"category_{c.id}",
                "previous": old.percentage if old else None,
                "value": data.get(f"category_{c.id}", "" if checkin else "0")
                if data is not None
                else ("" if checkin else (old.percentage if old else 0)),
                "projects": [
                    {
                        "project": p,
                        "assigned": p.id in suggested_ids,
                        "field": f"project_{c.id}_{p.id}",
                        "previous": old_projects.get(p.id),
                        "value": data.get(f"project_{c.id}_{p.id}", "" if checkin else "0")
                        if data is not None
                        else ("" if checkin else old_projects.get(p.id, 0)),
                    }
                    for p in projects
                ]
                if c.supports_projects
                else [],
            }
        )
    for row in rows:
        for item in row["projects"]:
            # Keep explicitly added zero-valued draft rows after validation
            # errors. Snapshots only restore projects with an actual share.
            item["selected"] = (
                checkin and data is None and item["previous"] is not None
            ) or str(item["value"]) not in {"0", ""} or (
                data is not None and data.get(f"selected_{item['field']}") == "on"
            )
        row["project_open"] = any(item["selected"] for item in row["projects"])
    total = sum(
        int(row["value"])
        for row in rows
        if len(str(row["value"])) <= 3
        and str(row["value"]).isascii()
        and str(row["value"]).isdecimal()
    )
    return {
        "checkin": checkin,
        "rows": rows,
        "total": total,
        "suggested": [p for p in projects if p.id in suggested_ids],
        "current": report_vm(current) if current else None,
        "history": [report_vm(r) for r in history],
    }


def overview(workspace, team_id="", user_id=""):
    latest = WorkloadReport.objects.filter(
        workspace=workspace, user_id=OuterRef("user_id")
    ).order_by("-id")
    memberships = (
        Membership.objects.filter(workspace=workspace)
        .select_related("workspace", "user")
        .annotate(latest_report=Subquery(latest.values("id")[:1]))
        .order_by("user__username")
    )
    teams = Team.objects.filter(workspace=workspace)
    if team_id:
        memberships = memberships.filter(
            user_id__in=Person.objects.filter(
                workspace=workspace,
                teams__in=teams.filter(pk=team_id),
            ).values("user_id")
        )
    if user_id:
        memberships = memberships.filter(user_id=user_id)
    memberships = list(memberships)
    latest_reports = {
        r.id: r
        for r in reports(workspace).filter(
            id__in=[m.latest_report for m in memberships if m.latest_report]
        )
    }
    rows, averages = [], {}
    participating = reported = 0
    for m in memberships:
        included = participates(m)
        latest_report = latest_reports.get(m.latest_report)
        report = report_vm(latest_report) if latest_report else None
        participating += int(included)
        if included and report:
            reported += 1
            for allocation in report["allocations"]:
                aggregate = averages.setdefault(
                    allocation["key"],
                    {
                        **allocation,
                        "percentage": 0,
                        "projects": {},
                    },
                )
                aggregate["percentage"] += allocation["percentage"]
                aggregate["name"] = allocation["name"]
                aggregate["supports_projects"] |= allocation["supports_projects"]
                for project in allocation["projects"]:
                    share = aggregate["projects"].setdefault(
                        project["key"],
                        {
                            **project,
                            "percentage": 0,
                        },
                    )
                    share["percentage"] += project["percentage"]
        rows.append(
            {
                "membership": m,
                "included": included,
                "report": report,
            }
        )
    average_allocations = (
        [
            {
                **allocation,
                "percentage": allocation["percentage"] / reported,
                "projects": [
                    {**project, "percentage": project["percentage"] / reported}
                    for project in allocation["projects"].values()
                ],
            }
            for allocation in averages.values()
        ]
        if reported
        else []
    )
    return {
        "members": rows,
        "participating": participating,
        "reported": reported,
        "averages": average_allocations,
        "average_donut": donut_vm(average_allocations, "average"),
        "teams": teams,
        "team_id": str(team_id),
        "user_id": str(user_id),
        "people_choices": Membership.objects.filter(workspace=workspace)
        .select_related("user")
        .order_by("user__username"),
        "recent_history": [report_vm(r) for r in reports(workspace)[:20]],
    }
