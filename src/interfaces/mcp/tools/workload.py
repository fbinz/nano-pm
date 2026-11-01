"""Workload privacy and immutable snapshots; never impersonate another reporter."""

from datetime import timedelta

from django.utils import timezone

from actions import manage_workload as workload
from actions.activity import log_activity
from data.models import (
    Membership,
    Person,
    Project,
    Team,
    WorkloadCategory,
    WorkloadReport,
)
from permissions import is_pm
from readers import mcp as view
from readers.workload import overview

from .. import schemas as s
from ..common import date_filter, has_cap, lookup, match, page, patch, require, unique
from ..registry import tool


def audit(r, action, entity=None):
    log_activity(
        workspace=r.workspace, actor=r.user, action=action, entity=entity or r.workspace
    )


@tool(s.WorkspaceParams, cap="workload.self", participant=True)
def get_my_workload(r, p):
    """Read only your latest estimate, available categories/projects and check-in state/revision."""
    return {"item": view.my_workload(r.workspace, r.membership)}


@tool(s.WorkloadSubmit, cap="workload.self", participant=True, mutation=True)
def submit_my_workload(r, p):
    """Submit your own immutable percentage estimate. Categories must total 100; project shares cannot exceed their category."""
    match(p, view.my_workload(r.workspace, r.membership))
    unique([a.category_id for a in p.allocations])
    active_ids = set(
        WorkloadCategory.objects.filter(workspace=r.workspace, active=True).values_list(
            "id", flat=True
        )
    )
    require(
        {a.category_id for a in p.allocations} == active_ids,
        "validation_error",
        "Provide exactly the active workspace categories.",
    )
    data = {}
    for allocation in p.allocations:
        category = lookup(WorkloadCategory, allocation.category_id, r.workspace)
        data[f"category_{category.pk}"] = str(allocation.percentage)
        unique([x.project_id for x in allocation.projects])
        require(
            category.supports_projects or not allocation.projects,
            "validation_error",
            "Category does not support projects.",
        )
        for project in allocation.projects:
            obj = lookup(Project, project.project_id, r.workspace)
            require(
                not obj.is_completed,
                "validation_error",
                "Completed projects cannot receive allocations.",
            )
            data[f"project_{category.pk}_{obj.pk}"] = str(project.percentage)
            data[f"selected_project_{category.pk}_{obj.pk}"] = "on"
    report = workload.submit(
        workspace=r.workspace, user=r.user, data=data, checkin=p.checkin
    )
    if p.checkin:
        r.membership.workload_snoozed_until = None
        r.membership.save(update_fields=["workload_snoozed_until"])
    audit(r, "workload_report.created", report)
    return {
        "item": view.report(report),
        "state": view.my_workload(r.workspace, r.membership),
    }


@tool(s.Change, cap="workload.self", participant=True, mutation=True)
def review_my_workload(r, p):
    """Create a new reviewed snapshot copying your latest estimate without changing percentages."""
    match(p, view.my_workload(r.workspace, r.membership))
    obj = workload.submit(workspace=r.workspace, user=r.user, review=True)
    audit(r, "workload_report.reviewed", obj)
    return {
        "item": view.report(obj),
        "state": view.my_workload(r.workspace, r.membership),
    }


@tool(s.Change, cap="workload.self", participant=True, mutation=True)
def snooze_my_workload_checkin(r, p):
    """Snooze only your own workload check-in for seven days."""
    match(p, view.my_workload(r.workspace, r.membership))
    r.membership.workload_snoozed_until = timezone.now() + timedelta(days=7)
    r.membership.save(update_fields=["workload_snoozed_until"])
    audit(r, "workload_checkin.snoozed", r.membership)
    return {"item": view.my_workload(r.workspace, r.membership)}


def report_filters(r, p, qs):
    if p.membership_id:
        membership = lookup(Membership, p.membership_id, r.workspace)
        qs = qs.filter(user_id=membership.user_id)
    if p.team_id:
        lookup(Team, p.team_id, r.workspace)
        qs = qs.filter(
            user_id__in=Person.objects.filter(
                workspace=r.workspace, teams=p.team_id
            ).values("user_id")
        )
    return date_filter(qs, p, "reviewed_at__date")


@tool(s.ReportPage, cap="workload.manage", pm=True)
def get_workload_overview(r, p):
    """Read PM-only aggregate workload and a paginated set of current membership report rows."""
    user_id = ""
    if p.membership_id:
        user_id = lookup(Membership, p.membership_id, r.workspace).user_id
    if p.team_id:
        lookup(Team, p.team_id, r.workspace)
    require(
        p.start is None and p.end is None,
        "validation_error",
        "Use list_workload_reports for date filters.",
    )
    data = overview(r.workspace, p.team_id or "", user_id)
    result = page(
        r,
        data["members"],
        p,
        lambda row: {
            "membership": view.membership(row["membership"]),
            "included": row["included"],
            "report": view.report(WorkloadReport.objects.get(pk=row["report"]["id"]))
            if row["report"]
            else None,
        },
    )
    # Hand-built aggregate DTO, not the renderer's donut/HTML view model.
    result.update(
        {
            "participating": data["participating"],
            "reported": data["reported"],
            "averages": [
                {
                    "category": a["name"],
                    "percentage": a["percentage"],
                    "projects": [
                        {"label": x["project_label"], "percentage": x["percentage"]}
                        for x in a["projects"][:100]
                    ],
                }
                for a in data["averages"][:100]
            ],
        }
    )
    return result


@tool(s.ReportPage, cap="workload.manage", pm=True)
def list_workload_reports(r, p):
    """Read paginated immutable workload snapshots; PM and dedicated workload capability required."""
    qs = report_filters(
        r, p, WorkloadReport.objects.filter(workspace=r.workspace).order_by("-id")
    )
    return page(r, qs, p, view.report)


@tool(s.ObjectParams, anycaps=("workload.self", "workload.manage"))
def get_workload_report(r, p):
    """Read your own report with self capability, or another report only as a workload-authorized PM."""
    obj = lookup(WorkloadReport, p.id, r.workspace)
    require(
        (has_cap(r, "workload.self") and obj.user_id == r.user.pk)
        or (has_cap(r, "workload.manage") and is_pm(r)),
        "not_found",
        "Report not found.",
    )
    return {"item": view.report(obj)}


@tool(s.WorkspaceParams, cap="workload.manage", pm=True)
def get_workload_settings(r, p):
    """Read workload feature/check-in/default participation settings."""
    return {"item": view.workload_settings(r.workspace)}


@tool(s.WorkloadSettings, cap="workload.manage", pm=True, mutation=True)
def update_workload_settings(r, p):
    """Patch only supplied workload settings; booleans never reset unrelated settings."""
    match(p, view.workload_settings(r.workspace))
    values = patch(
        p,
        "workload_enabled workload_checkin_enabled workload_members_included workload_pms_included workload_checkin_interval_days",
    )
    for key, value in values.items():
        data = {
            key: str(value)
            if key == "workload_checkin_interval_days"
            else ("on" if value else None)
        }
        workload.configure(workspace=r.workspace, actor=r.user, data=data, setting=key)
    r.workspace.refresh_from_db()
    audit(r, "workload_settings.updated")
    return {"item": view.workload_settings(r.workspace)}


@tool(s.Page, anycaps=("workload.self", "workload.manage"))
def list_workload_categories(r, p):
    """List workload categories for a participating caller or a workload-authorized PM."""
    require(
        (has_cap(r, "workload.manage") and is_pm(r))
        or (has_cap(r, "workload.self") and r.membership.can_report_workload)
    )
    return page(
        r,
        WorkloadCategory.objects.filter(workspace=r.workspace).order_by("id"),
        p,
        view.category,
    )


def category_data(values):
    return {
        key: ("on" if value else None) if type(value) is bool else value
        for key, value in values.items()
    }


@tool(s.CategoryCreate, cap="workload.manage", pm=True, mutation=True)
def create_workload_category(r, p):
    """Create a workload category without modifying historical snapshots."""
    obj = workload.configure_category(
        workspace=r.workspace,
        actor=r.user,
        data=category_data(
            {
                "name": p.name,
                "active": p.active,
                "supports_projects": p.supports_projects,
            }
        ),
    )
    audit(r, "workload_category.created", obj)
    return {"item": view.category(obj)}


@tool(s.CategoryUpdate, cap="workload.manage", pm=True, mutation=True)
def update_workload_category(r, p):
    """Patch category name/active/project support, preserving omitted properties."""
    obj = lookup(WorkloadCategory, p.id, r.workspace)
    match(p, view.category(obj))
    values = patch(p, "name active supports_projects")
    data = {
        "category_id": obj.pk,
        "name": obj.name,
        "active": obj.active,
        "supports_projects": obj.supports_projects,
        **values,
    }
    obj = workload.configure_category(
        workspace=r.workspace, actor=r.user, data=category_data(data)
    )
    audit(r, "workload_category.updated", obj)
    return {"item": view.category(obj)}


@tool(s.ObjectChange, cap="workload.manage", pm=True, mutation=True, destructive=True)
def delete_workload_category(r, p):
    """Delete a category while preserving historical allocation labels/percentages."""
    obj = lookup(WorkloadCategory, p.id, r.workspace)
    match(p, view.category(obj))
    audit(r, "workload_category.deleted", obj)
    workload.delete_category(workspace=r.workspace, actor=r.user, category_id=p.id)
    return {"deleted_ids": [p.id]}


@tool(s.Participation, cap="workload.manage", pm=True, mutation=True)
def set_workload_participation(r, p):
    """Set membership participation to inherit/included/exempt; no account impersonation."""
    obj = lookup(Membership, p.id, r.workspace)
    match(p, view.membership(obj))
    workload.set_participation(
        workspace=r.workspace, actor=r.user, membership_id=p.id, value=p.value
    )
    obj.refresh_from_db()
    audit(r, "workload_participation.updated", obj)
    return {"item": view.membership(obj)}
