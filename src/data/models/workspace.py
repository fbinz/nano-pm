from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from data.models.project import default_teams_notify_events


class Workspace(models.Model):
    name = models.CharField(max_length=200)
    prompt_milestone_move_reason = models.BooleanField(default=True)
    workload_enabled = models.BooleanField(default=False)
    workload_checkin_enabled = models.BooleanField(default=True)
    workload_checkin_interval_days = models.PositiveSmallIntegerField(
        default=7, validators=[MinValueValidator(1), MaxValueValidator(365)]
    )
    workload_members_included = models.BooleanField(default=True)
    workload_pms_included = models.BooleanField(default=False)
    teams_webhook_url = models.URLField(max_length=2048, blank=True, default="")
    teams_notify_events = models.JSONField(default=default_teams_notify_events, blank=True)
    teams_public_subscriber_domains = models.JSONField(default=list, blank=True)
    public_roadmap_enabled = models.BooleanField(default=False)
    public_roadmap_token = models.SlugField(max_length=50, unique=True, null=True, blank=True)
    public_roadmap_title = models.CharField(max_length=200, blank=True, default="")
    public_roadmap_description = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(workload_checkin_interval_days__gte=1)
                & models.Q(workload_checkin_interval_days__lte=365),
                name="workload_checkin_interval_range",
            ),
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def public_roadmap_display_title(self) -> str:
        return self.public_roadmap_title.strip() or f"{self.name} Roadmap"
