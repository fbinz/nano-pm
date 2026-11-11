from django.db import models
from django.utils.translation import gettext_lazy as _


PROJECT_COLORS = [
    "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899",
    "#06b6d4", "#ef4444", "#84cc16", "#f97316", "#0ea5e9",
]

TEAMS_NOTIFY_EVENT_CHOICES = [
    ("milestone.created", _("Milestone created")),
    ("milestone.moved", _("Milestone date changed")),
    ("milestone.updated", _("Milestone details changed")),
    ("milestone.project_changed", _("Milestone moved between projects")),
    ("milestone.deleted", _("Milestone deleted")),
]
TEAMS_NOTIFY_EVENT_KEYS = {key for key, _label in TEAMS_NOTIFY_EVENT_CHOICES}
DEFAULT_TEAMS_NOTIFY_EVENTS = ["milestone.moved", "milestone.updated"]


def default_teams_notify_events() -> list[str]:
    return list(DEFAULT_TEAMS_NOTIFY_EVENTS)


class ProjectPhase(models.TextChoices):
    IDEA = "idea", _("Idea")
    DISCOVERY = "discovery", _("Discovery")
    SHAPING = "shaping", _("Shaping")
    PLANNED = "planned", _("Planned")
    DELIVERY = "delivery", _("Delivery")
    REVIEW = "review", _("Review")
    COMPLETED = "completed", _("Completed")
    PARKED = "parked", _("Parked")
    DROPPED = "dropped", _("Dropped")


class Project(models.Model):
    """A workspace-scoped project, from its first idea through delivery and review."""

    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="projects",
    )
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    phase = models.CharField(max_length=20, choices=ProjectPhase.choices, default=ProjectPhase.IDEA)
    outcome = models.TextField(blank=True, default="")
    scope = models.TextField(blank=True, default="")
    constraints = models.TextField(blank=True, default="")
    checkpoint = models.CharField(max_length=500, blank=True, default="")
    checkpoint_date = models.DateField(null=True, blank=True)
    public_roadmap_visible = models.BooleanField(default=False)
    responsible_people = models.ManyToManyField(
        "data.Person",
        related_name="responsible_projects",
        blank=True,
    )
    color = models.CharField(max_length=9, default=PROJECT_COLORS[0])
    # Historical configuration retained for migration compatibility only.
    # Delivery and settings use Workspace configuration exclusively.
    teams_webhook_url = models.URLField(blank=True, default="")
    teams_notify_events = models.JSONField(default=default_teams_notify_events, blank=True)
    # Float ordering keeps re-order cheap (insert between any two by averaging).
    order = models.FloatField(default=0)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self) -> str:
        return self.name

    @property
    def is_completed(self) -> bool:
        return self.completed_at is not None
