"""Workload estimates, project guidance and respondent-only summaries."""

from datetime import timedelta

from django.db.models import OuterRef, Q, Subquery
from django.utils import timezone

from actions.manage_workload import participates
from data.models import (
    Membership,
    Person,
    Project,
    Team,
    WorkloadCategory,
    WorkloadReport,
)
from data.models.project import PROJECT_COLORS


def reports(workspace):
    return WorkloadReport.objects.filter(workspace=workspace).prefetch_related(
        "allocations__projects"
    )


def report_vm(report):
    allocations = []
    for index, allocation in enumerate(report.allocations.all()):
        projects = list(allocation.projects.all())
        allocations.append(
            {
                "name": allocation.category_label,
                "percentage": allocation.percentage,
                "supports_projects": allocation.supports_projects,
                "projects": projects,
                "unspecified": allocation.percentage
                - sum(p.percentage for p in projects),
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


def personal(workspace, user, data=None):
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
                "value": data.get(f"category_{c.id}", "0")
                if data is not None
                else (old.percentage if old else 0),
                "projects": [
                    {
                        "project": p,
                        "field": f"project_{c.id}_{p.id}",
                        "value": data.get(f"project_{c.id}_{p.id}", "0")
                        if data is not None
                        else old_projects.get(p.id, 0),
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
            item["selected"] = str(item["value"]) not in {"0", ""} or (
                data is not None
                and data.get(f"selected_{item['field']}") == "on"
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
    rows, sums, labels = [], {}, {}
    participating = reported = 0
    for m in memberships:
        included = participates(m)
        report = latest_reports.get(m.latest_report)
        participating += int(included)
        if included and report:
            reported += 1
            for a in report.allocations.all():
                key = a.category_id or a.category_label
                sums[key] = sums.get(key, 0) + a.percentage
                labels[key] = a.category_label
        rows.append(
            {
                "membership": m,
                "included": included,
                "report": report_vm(report) if report else None,
            }
        )
    return {
        "members": rows,
        "participating": participating,
        "reported": reported,
        "averages": [
            {"name": labels[k], "percentage": round(v / reported, 1)}
            for k, v in sums.items()
        ]
        if reported
        else [],
        "teams": teams,
        "team_id": str(team_id),
        "user_id": str(user_id),
        "people_choices": Membership.objects.filter(workspace=workspace)
        .select_related("user")
        .order_by("user__username"),
        "recent_history": [report_vm(r) for r in reports(workspace)[:20]],
    }
