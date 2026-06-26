from django.conf import settings
from django.db import models
from django.utils.translation import gettext as _


class ActivityEvent(models.Model):
    """A durable, workspace-scoped audit/event trail entry."""

    workspace = models.ForeignKey(
        "data.Workspace",
        on_delete=models.CASCADE,
        related_name="activity_events",
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="activity_events",
    )
    action = models.CharField(max_length=80)
    entity_type = models.CharField(max_length=80)
    entity_id = models.PositiveIntegerField(null=True, blank=True)
    entity_label = models.CharField(max_length=255, blank=True, default="")
    changes = models.JSONField(default=dict, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["workspace", "-created_at"]),
            models.Index(fields=["workspace", "entity_type", "entity_id"]),
            models.Index(fields=["workspace", "action"]),
        ]

    def __str__(self) -> str:
        return self.summary

    @property
    def actor_name(self) -> str:
        if self.actor_id and self.actor is not None:
            return self.actor.get_username()
        return _("Someone")

    @property
    def entity_display(self) -> str:
        return self.entity_label or self.entity_type.replace("_", " ")

    @property
    def verb(self) -> str:
        verbs = {
            "created": _("created"),
            "updated": _("updated"),
            "deleted": _("deleted"),
            "moved": _("moved"),
            "resized": _("resized"),
            "bulk_moved": _("moved"),
            "completed": _("completed"),
            "reopened": _("reopened"),
            "converted": _("converted"),
            "enabled": _("enabled"),
            "disabled": _("disabled"),
            "regenerated": _("regenerated"),
            "invited": _("created an invite for"),
        }
        suffix = self.action.rsplit(".", 1)[-1]
        return verbs.get(suffix, suffix.replace("_", " "))

    @property
    def entity_name(self) -> str:
        names = {
            "dependency": _("dependency"),
            "idea": _("idea"),
            "milestone": _("milestone"),
            "person": _("person"),
            "project": _("project"),
            "task": _("task"),
            "team": _("team"),
            "workspace": _("workspace"),
            "tasks": _("tasks"),
        }
        return names.get(self.entity_type, self.entity_type.replace("_", " "))

    @property
    def summary_without_actor(self) -> str:
        if self.action == "tasks.bulk_moved":
            count = self.metadata.get("count") or len(self.metadata.get("task_ids", []))
            return _("moved %(count)s tasks") % {"count": count}
        if self.action == "task.resized":
            return _("changed duration of task %(label)s") % {
                "label": self.entity_display,
            }
        return _("%(verb)s %(entity)s %(label)s") % {
            "verb": self.verb,
            "entity": self.entity_name,
            "label": self.entity_display,
        }

    @property
    def summary(self) -> str:
        if self.action == "tasks.bulk_moved":
            count = self.metadata.get("count") or len(self.metadata.get("task_ids", []))
            return _("%(actor)s moved %(count)s tasks") % {
                "actor": self.actor_name,
                "count": count,
            }
        if self.action == "task.resized":
            return _("%(actor)s changed duration of task %(label)s") % {
                "actor": self.actor_name,
                "label": self.entity_display,
            }
        return _("%(actor)s %(verb)s %(entity)s %(label)s") % {
            "actor": self.actor_name,
            "verb": self.verb,
            "entity": self.entity_name,
            "label": self.entity_display,
        }

    def _format_change_value(self, value) -> str:
        if value is None or value == "":
            return "—"
        if isinstance(value, (list, tuple, set)):
            return ", ".join(str(item) for item in value) or "—"
        return str(value)

    def _field_label(self, field: str) -> str:
        labels = {
            "assignees": _("Assignees"),
            "body": _("Body"),
            "color": _("Color"),
            "completed_at": _("Completed at"),
            "converted_project": _("Converted project"),
            "converted_task": _("Converted task"),
            "date": _("Date"),
            "description": _("Description"),
            "end": _("End"),
            "name": _("Name"),
            "order": _("Order"),
            "predecessor": _("Predecessor"),
            "project": _("Project"),
            "public_roadmap_description": _("Public roadmap description"),
            "public_roadmap_enabled": _("Public roadmap enabled"),
            "public_roadmap_title": _("Public roadmap title"),
            "public_roadmap_token": _("Public roadmap token"),
            "start": _("Start"),
            "status": _("Status"),
            "successor": _("Successor"),
            "tags": _("Tags"),
            "teams": _("Teams"),
            "title": _("Title"),
            "workspace": _("Workspace"),
        }
        return labels.get(field, field.replace("_", " ").title())

    def _is_long_text_field(self, field: str) -> bool:
        return field in {
            "body",
            "description",
            "public_roadmap_description",
        }

    @property
    def change_items(self) -> list[dict[str, str]]:
        items = []
        for field, change in (self.changes or {}).items():
            label = self._field_label(field)
            if self._is_long_text_field(field) or (isinstance(change, dict) and change.get("changed")):
                detail = _("changed")
            elif isinstance(change, dict) and "from" in change and "to" in change:
                before = self._format_change_value(change.get("from"))
                after = self._format_change_value(change.get("to"))
                detail = _("%(before)s → %(after)s") % {
                    "before": before,
                    "after": after,
                }
            elif isinstance(change, dict) and "to" in change:
                detail = self._format_change_value(change.get("to"))
            elif isinstance(change, dict) and "deleted" in change:
                detail = self._format_change_value(change.get("deleted"))
            else:
                detail = self._format_change_value(change)
            items.append({"label": label, "detail": detail})
        return items

    @property
    def change_lines(self) -> list[str]:
        return [
            _("%(label)s: %(value)s") % {
                "label": item["label"],
                "value": item["detail"],
            }
            for item in self.change_items
        ]
