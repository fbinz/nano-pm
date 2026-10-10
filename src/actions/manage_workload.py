"""Validated, workspace-scoped workload configuration and immutable snapshots."""

from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils.translation import gettext as _

from data.models import (
    Membership,
    Project,
    Workspace,
    WorkspaceRole,
    WorkloadAllocation,
    WorkloadCategory,
    WorkloadProjectAllocation,
    WorkloadReport,
)


def participates(membership):
    return membership is not None and membership.can_report_workload


def require_manager(workspace, user):
    if not Membership.objects.filter(
        workspace=workspace, user=user, role=WorkspaceRole.PM
    ).exists():
        raise PermissionDenied


@transaction.atomic
def set_participation(*, workspace, actor, membership_id, value):
    require_manager(workspace, actor)
    Workspace.objects.select_for_update().get(pk=workspace.pk)
    if value not in {"inherit", "included", "exempt"}:
        raise ValidationError(_("Invalid participation setting."))
    if not Membership.objects.filter(workspace=workspace, id=membership_id).update(
        workload_participation=value
    ):
        raise ValidationError(_("Member not found in this workspace."))


@transaction.atomic
def configure(*, workspace, actor, data, setting=None):
    require_manager(workspace, actor)
    fields = [
        "workload_enabled",
        "workload_members_included",
        "workload_pms_included",
    ]
    if setting is not None:
        if setting not in fields or data.get(setting) not in {None, "on"}:
            raise ValidationError(_("Invalid workload setting."))
        fields = [setting]
    workspace = Workspace.objects.select_for_update().get(pk=workspace.pk)
    # A switch only changes its own field, never another switch's pending draft.
    for field in fields:
        setattr(workspace, field, data.get(field) == "on")
    workspace.save(update_fields=fields)
    created_categories = []
    if (
        workspace.workload_enabled
        and not WorkloadCategory.objects.filter(workspace=workspace).exists()
    ):
        for order, (name, projects) in enumerate(
            [
                (_("Maintenance"), False),
                (_("Project work"), True),
                (_("Meetings"), False),
            ]
        ):
            created_categories.append(
                WorkloadCategory.objects.create(
                    workspace=workspace,
                    name=name,
                    order=order,
                    supports_projects=projects,
                )
            )
    return created_categories


@transaction.atomic
def configure_category(*, workspace, actor, data):
    require_manager(workspace, actor)
    Workspace.objects.select_for_update().get(pk=workspace.pk)
    name = str(data.get("name", "")).strip()
    if not name or len(name) > 100:
        raise ValidationError(_("Category name must contain 1 to 100 characters."))
    category_id = data.get("category_id")
    category = (
        WorkloadCategory.objects.filter(workspace=workspace, pk=category_id).first()
        if category_id
        else None
    )
    if category_id and category is None:
        raise ValidationError(_("Category not found in this workspace."))
    duplicate = WorkloadCategory.objects.filter(workspace=workspace, name=name)
    if category:
        duplicate = duplicate.exclude(pk=category.pk)
    if duplicate.exists():
        raise ValidationError(_("A category with this name already exists."))
    category = category or WorkloadCategory(
        workspace=workspace,
        order=WorkloadCategory.objects.filter(workspace=workspace).count(),
    )
    category.name = name
    category.active = data.get("active") == "on"
    category.supports_projects = data.get("supports_projects") == "on"
    category.save()
    return category


@transaction.atomic
def delete_category(*, workspace, actor, category_id):
    require_manager(workspace, actor)
    Workspace.objects.select_for_update().get(pk=workspace.pk)
    category = (
        WorkloadCategory.objects.select_for_update()
        .filter(
            workspace=workspace,
            pk=category_id,
        )
        .first()
    )
    if category is None:
        return None
    # SET_NULL detaches the category without deleting snapshot allocations.
    category.delete()
    return category


def percentage(value):
    value = str(value or "0")
    if (
        len(value) > 3
        or not value.isascii()
        or not value.isdecimal()
        or not 0 <= int(value) <= 100
    ):
        raise ValidationError(_("Percentages must be whole numbers between 0 and 100."))
    return int(value)


@transaction.atomic
def submit(*, workspace, user, data=None, review=False):
    # Serialize with configuration changes and submissions for this workspace.
    workspace = Workspace.objects.select_for_update().get(pk=workspace.pk)
    membership = (
        Membership.objects.select_related("workspace")
        .filter(workspace=workspace, user=user)
        .first()
    )
    if not participates(membership):
        raise PermissionDenied
    if review:
        previous = (
            WorkloadReport.objects.filter(workspace=workspace, user=user)
            .prefetch_related("allocations__projects")
            .first()
        )
        if previous is None:
            raise ValidationError(_("Submit an estimate before reviewing it."))
        project_ids = {
            p.project_id
            for a in previous.allocations.all()
            for p in a.projects.all()
            if p.project_id is not None
        }
        available_ids = set(
            Project.objects.select_for_update()
            .filter(
                workspace=workspace,
                id__in=project_ids,
            )
            .values_list("id", flat=True)
        )
        report = WorkloadReport.objects.create(
            workspace=workspace, user=user, user_label=user.get_username()
        )
        for old in previous.allocations.all():
            allocation = WorkloadAllocation.objects.create(
                report=report,
                category_id=old.category_id,
                category_label=old.category_label,
                supports_projects=old.supports_projects,
                percentage=old.percentage,
            )
            for project in old.projects.all():
                WorkloadProjectAllocation.objects.create(
                    allocation=allocation,
                    project_id=project.project_id
                    if project.project_id in available_ids
                    else None,
                    project_label=project.project_label,
                    percentage=project.percentage,
                )
        return report

    data = data or {}
    categories = list(WorkloadCategory.objects.filter(workspace=workspace, active=True))
    projects = list(
        Project.objects.select_for_update().filter(
            workspace=workspace, completed_at__isnull=True
        )
    )
    allowed = {f"category_{c.id}" for c in categories}
    allowed.update(
        f"project_{c.id}_{p.id}"
        for c in categories
        if c.supports_projects
        for p in projects
    )
    if any(
        key.startswith(("category_", "project_")) and key not in allowed for key in data
    ):
        raise ValidationError(
            _(
                "Category or project is unavailable in this workspace. Reload and try again."
            )
        )
    values = {key: percentage(data.get(key)) for key in allowed}
    if sum(values[f"category_{c.id}"] for c in categories) != 100:
        raise ValidationError(_("Category allocations must total 100%."))
    for c in categories:
        if (
            c.supports_projects
            and sum(values[f"project_{c.id}_{p.id}"] for p in projects)
            > values[f"category_{c.id}"]
        ):
            raise ValidationError(
                _("Project allocations cannot exceed their category percentage.")
            )
    report = WorkloadReport.objects.create(
        workspace=workspace, user=user, user_label=user.get_username()
    )
    for c in categories:
        allocation = WorkloadAllocation.objects.create(
            report=report,
            category=c,
            category_label=c.name,
            supports_projects=c.supports_projects,
            percentage=values[f"category_{c.id}"],
        )
        if c.supports_projects:
            for p in projects:
                value = values[f"project_{c.id}_{p.id}"]
                if value:
                    WorkloadProjectAllocation.objects.create(
                        allocation=allocation,
                        project=p,
                        project_label=p.name,
                        percentage=value,
                    )
    return report
