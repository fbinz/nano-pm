"""Explicit wire DTOs. Never serialize model dictionaries or credential fields."""

import hashlib
import json
from urllib.parse import urlsplit

from django.core.serializers.json import DjangoJSONEncoder
from django.utils import timezone

from data.models import (
    Dependency,
    Milestone,
    Project,
    Task,
    WorkloadCategory,
    WorkloadReport,
)
from data.models.task import status_for_dates


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(
            value, cls=DjangoJSONEncoder, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def fields(obj, names):
    return {name: getattr(obj, name) for name in names.split()}


def dto(data, extra=None):
    # Canonical JSON primitives also make the transaction receipt replay identical.
    clean = json.loads(json.dumps(data, cls=DjangoJSONEncoder))
    return {**clean, "revision": fingerprint([clean, extra])}


def workspace(obj):
    return dto(fields(obj, "id name prompt_milestone_move_reason"))


def ordering(workspace):
    return fingerprint(
        list(
            Project.objects.filter(workspace=workspace)
            .order_by("order", "id")
            .values_list("id", "order")
        )
    )


def project(obj, detail=True):
    data = fields(obj, "id workspace_id name color order phase completed_at public_roadmap_visible")
    data["responsible_person_ids"] = list(
        obj.responsible_people.order_by("id").values_list("id", flat=True)
    )
    if detail:
        data["description"] = obj.description
    # A project deletion/transfer acts on these children as well. Invalidate its
    # revision when those relationships change, including m2m-only updates.
    children = [
        list(
            obj.tasks.order_by("id").values_list(
                "id", "title", "description", "start", "end", "assignees__id"
            )
        ),
        list(
            obj.milestones.order_by("id").values_list(
                "id", "date", "task_id", "require_move_reason"
            )
        ),
        list(obj.journal.order_by("id").values_list("id", "resolved_at")),
    ]
    brief = fields(obj, "description outcome scope constraints checkpoint checkpoint_date")
    revision_data = {**data, **brief}
    result = dto(revision_data, children)
    if not detail:
        for field in brief:
            result.pop(field)
    return result


def task(obj, detail=True):
    data = fields(obj, "id project_id title start end")
    data["assignee_ids"] = list(
        obj.assignees.order_by("id").values_list("id", flat=True)
    )
    data["status"] = status_for_dates(obj.start, obj.end, timezone.localdate())
    linked = Milestone.objects.filter(task=obj).first()
    data["milestone_id"] = linked.pk if linked else None
    dependencies = list(
        Dependency.objects.filter(predecessor=obj).values_list(
            "successor_id", flat=True
        )
    )
    predecessors = list(
        Dependency.objects.filter(successor=obj).values_list(
            "predecessor_id", flat=True
        )
    )
    data["predecessor_ids"], data["successor_ids"] = (
        sorted(predecessors),
        sorted(dependencies),
    )
    full = {**data, "description": obj.description}
    result = dto(full, [linked.require_move_reason, linked.date] if linked else None)
    if not detail:
        result.pop("description")
    return result


def milestone(obj, detail=True):
    result = dto(
        fields(obj, "id project_id task_id title description date require_move_reason")
    )
    if not detail:
        result.pop("description")
    return result


def dependency(obj):
    return dto(fields(obj, "id predecessor_id successor_id"))


def person(obj):
    return dto(
        {
            **fields(obj, "id name"),
            "linked": obj.user_id is not None,
            "team_ids": list(obj.teams.order_by("id").values_list("id", flat=True)),
        },
        [
            list(obj.tasks.order_by("id").values_list("id", flat=True)),
            list(obj.responsible_projects.order_by("id").values_list("id", flat=True)),
        ],
    )


def team(obj):
    ids = list(obj.people.order_by("id").values_list("id", flat=True))
    return dto(
        {**fields(obj, "id name"), "member_ids": ids[:100], "member_count": len(ids)},
        ids,
    )


def membership(obj):
    return dto(
        {
            **fields(obj, "id role workload_participation"),
            "user_label": obj.user.get_username(),
        }
    )


def category(obj):
    return dto(fields(obj, "id name active supports_projects order"))


def report(obj):
    allocations = []
    for allocation in obj.allocations.order_by("id"):
        allocations.append(
            {
                **fields(
                    allocation,
                    "category_id category_label supports_projects percentage",
                ),
                "projects": [
                    fields(p, "project_id project_label percentage")
                    for p in allocation.projects.order_by("id")
                ],
            }
        )
    return dto(
        {**fields(obj, "id user_id user_label reviewed_at"), "allocations": allocations}
    )


def workload_settings(obj):
    return dto(
        fields(
            obj,
            "workload_enabled workload_checkin_enabled workload_checkin_interval_days workload_members_included workload_pms_included",
        )
    )


def my_workload(workspace, membership):
    latest = WorkloadReport.objects.filter(
        workspace=workspace, user_id=membership.user_id
    ).first()
    categories = [
        category(c)
        for c in WorkloadCategory.objects.filter(workspace=workspace, active=True)
    ]
    projects = [
        project(p, detail=False)
        for p in Project.objects.filter(workspace=workspace, completed_at__isnull=True)[
            :100
        ]
    ]
    data = {
        "latest": report(latest) if latest else None,
        "categories": categories,
        "projects": projects,
        "projects_truncated": Project.objects.filter(
            workspace=workspace, completed_at__isnull=True
        ).count()
        > 100,
        "snoozed_until": membership.workload_snoozed_until,
        "settings": workload_settings(workspace),
    }
    return dto(data)


def connection(obj):
    if obj is None:
        return dto({"configured": False})
    return dto(
        {
            "configured": True,
            **fields(obj, "enabled project_ids group_ids workflow last_success"),
            "sync_status": str(obj.sync_status),
            "stale": obj.is_stale,
        },
        [obj.revision, obj.next_run],
    )


def binding(obj, project_id):
    return dto(
        {
            "project_id": project_id,
            "prefix": obj.prefix if obj else None,
            "collect": obj.collect if obj else False,
        }
    )


def issue(obj, detail=True):
    data = fields(
        obj, "id gitlab_project_id iid title owner_id state source_state unavailable"
    )
    # Detail and list revisions describe the same underlying state.
    url, origin = urlsplit(obj.web_url), urlsplit(obj.connection.instance_url)
    data["url"] = (
        obj.web_url
        if url.scheme == "https" and url.netloc == origin.netloc and not url.username
        else None
    )
    data["labels"], data["intervals"] = obj.labels, obj.intervals
    result = dto(data)
    if not detail:
        for key in ("url", "labels", "intervals"):
            result.pop(key)
    return result


def notification_settings(obj):
    return dto(
        {
            "events": obj.teams_notify_events,
            "subscriber_domains": obj.teams_public_subscriber_domains,
            "configured": bool(obj.teams_webhook_url),
        }
    )


def roadmap_settings(obj):
    return dto(
        {
            "enabled": obj.public_roadmap_enabled,
            "title": obj.public_roadmap_title,
            "description": obj.public_roadmap_description,
        },
        fingerprint(obj.public_roadmap_token),
    )


def delivery(obj):
    # Raw payload and error messages are deliberately absent.
    return fields(obj, "id status attempts created_at available_at")


def activity(obj):
    # Audit records predate this API and can contain URLs, addresses or secrets.
    # Only known scheduling fields are exposed, not arbitrary snapshots/metadata.
    allowed = {
        "start",
        "end",
        "date",
        "completed_at",
        "order",
        "require_move_reason",
        "prompt_milestone_move_reason",
    }
    changes = {k: v for k, v in obj.changes.items() if k in allowed}
    return {
        **fields(obj, "id action entity_type entity_id created_at"),
        "actor_id": obj.actor_id,
        "changes": changes,
    }


def schedule_state(workspace):
    return {
        "tasks": {
            row[0]: row[1:]
            for row in Task.objects.filter(project__workspace=workspace).values_list(
                "id", "start", "end", "project_id"
            )
        },
        "milestones": {
            row[0]: row[1:]
            for row in Milestone.objects.filter(
                project__workspace=workspace
            ).values_list("id", "date", "task_id", "project_id")
        },
    }


def schedule_effects(before, after):
    result = {}
    for kind in before:
        changed = sorted(
            k for k in after[kind] if before[kind].get(k) != after[kind][k]
        )
        removed = sorted(set(before[kind]) - set(after[kind]))
        result[kind] = {
            "changed_ids": changed[:100],
            "deleted_ids": removed[:100],
            "changed_count": len(changed),
            "deleted_count": len(removed),
            "truncated": len(changed) > 100 or len(removed) > 100,
        }
    result["read_tools"] = ["list_tasks", "list_milestones"]
    return result
