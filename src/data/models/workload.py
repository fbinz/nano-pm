"""Self-reported percentage estimates; never hours or task scheduling data."""

from django.conf import settings
from django.db import models


class WorkloadCategory(models.Model):
    workspace = models.ForeignKey("data.Workspace", on_delete=models.CASCADE)
    name = models.CharField(max_length=100)
    order = models.PositiveIntegerField(default=0)
    active = models.BooleanField(default=True)
    supports_projects = models.BooleanField(default=False)

    class Meta:
        ordering = ["order", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "name"], name="unique_workload_category"
            )
        ]


class WorkloadReport(models.Model):
    workspace = models.ForeignKey("data.Workspace", on_delete=models.CASCADE)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL
    )
    user_label = models.CharField(max_length=150)
    reviewed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        indexes = [models.Index(fields=["workspace", "user", "id"])]


class WorkloadAllocation(models.Model):
    report = models.ForeignKey(
        WorkloadReport, related_name="allocations", on_delete=models.CASCADE
    )
    category = models.ForeignKey(WorkloadCategory, null=True, on_delete=models.SET_NULL)
    category_label = models.CharField(max_length=100)
    supports_projects = models.BooleanField(default=False)
    percentage = models.PositiveSmallIntegerField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(percentage__lte=100), name="workload_percentage_max"
            ),
            models.UniqueConstraint(
                fields=["report", "category"], name="unique_report_category"
            ),
        ]


class WorkloadProjectAllocation(models.Model):
    allocation = models.ForeignKey(
        WorkloadAllocation, related_name="projects", on_delete=models.CASCADE
    )
    project = models.ForeignKey("data.Project", null=True, on_delete=models.SET_NULL)
    project_label = models.CharField(max_length=200)
    percentage = models.PositiveSmallIntegerField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(percentage__lte=100),
                name="workload_project_percentage_max",
            ),
            models.UniqueConstraint(
                fields=["allocation", "project"], name="unique_allocation_project"
            ),
        ]
