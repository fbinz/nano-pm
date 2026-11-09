"""PM-only workload charts. Snapshots describe a mix, never measured capacity."""

from datetime import datetime, timedelta
from hashlib import sha256
from urllib.parse import urlencode

from django.utils import timezone

from data.models import WorkloadCategory
from data.models.project import PROJECT_COLORS
from readers.workload import report_vm, reports


def month_start(now, offset):
    year, month = divmod(now.year * 12 + now.month - 1 + offset, 12)
    return datetime(year, month + 1, 1, tzinfo=now.tzinfo)


def category_key(allocation):
    key = allocation["key"]
    if isinstance(key, int):
        return f"category-{key}"
    return f"deleted-{sha256(str(key).encode()).hexdigest()[:16]}"


def dashboard(workspace, overview, sort=""):
    """Use current membership/team/participation for all historical cutoffs.

    Historical membership and participation changes are not recorded, so we must
    not present these charts as a reconstruction of historical team staffing.
    """
    now = timezone.localtime()
    members = overview["members"]
    user_ids = [row["membership"].user_id for row in members]
    snapshots = []
    categories = {}
    for category in WorkloadCategory.objects.filter(workspace=workspace, active=True):
        key = f"category-{category.pk}"
        categories[key] = {
            "key": key,
            "name": category.name,
            "color": PROJECT_COLORS[(category.pk - 1) % len(PROJECT_COLORS)],
        }
    # Read the retained history, not the overview's latest-20 activity preview.
    for report in (
        reports(workspace)
        .filter(user_id__in=user_ids, reviewed_at__lte=now)
        .order_by("reviewed_at", "id")
    ):
        vm = report_vm(report)
        allocations = {}
        for allocation in vm["allocations"]:
            key = category_key(allocation)
            categories.setdefault(
                key,
                {
                    "key": key,
                    "name": allocation["name"],
                    "color": allocation["color"],
                },
            )
            allocations[key] = allocation
        snapshots.append((report.user_id, vm, allocations))

    participating_ids = {
        row["membership"].user_id for row in members if row["included"]
    }
    months, latest, cursor = [], {}, 0
    for offset in range(-11, 1):
        start = month_start(now, offset)
        cutoff = (
            now
            if offset == 0
            else month_start(now, offset + 1) - timedelta(microseconds=1)
        )
        while cursor < len(snapshots) and snapshots[cursor][1]["reviewed_at"] <= cutoff:
            user_id, report, allocations = snapshots[cursor]
            latest[user_id] = (report, allocations)
            cursor += 1
        respondents = [
            latest[user_id] for user_id in participating_ids if user_id in latest
        ]
        totals = {}
        for _, allocations in respondents:
            for key, allocation in allocations.items():
                totals[key] = totals.get(key, 0) + allocation["percentage"]
        months.append(
            {
                "start": start,
                "current": offset == 0,
                "reported": len(respondents),
                "participating": len(participating_ids),
                "outdated": sum(
                    report["reviewed_at"] < cutoff - timedelta(days=90)
                    for report, _ in respondents
                ),
                "allocations": [
                    {
                        **category,
                        "percentage": round(totals.get(key, 0) / len(respondents), 6),
                    }
                    for key, category in categories.items()
                ]
                if respondents
                else [],
            }
        )

    heatmap = []
    for row in members:
        membership = row["membership"]
        report, allocations = latest.get(membership.user_id, (None, {}))
        heatmap.append(
            {
                **row,
                "report": report,
                "url": "?"
                + urlencode({"team": overview["team_id"], "person": membership.user_id})
                + "#workload-person-history",
                "cells": [
                    {
                        **category,
                        "percentage": allocations[key]["percentage"]
                        if key in allocations
                        else None,
                    }
                    for key, category in categories.items()
                ],
            }
        )
    if sort in categories:
        heatmap.sort(
            key=lambda row: next(
                (
                    cell["percentage"]
                    for cell in row["cells"]
                    if cell["key"] == sort and cell["percentage"] is not None
                ),
                -1,
            ),
            reverse=True,
        )
    else:
        sort = ""
    for key, category in categories.items():
        category["sort_url"] = (
            "?"
            + urlencode(
                {
                    "team": overview["team_id"],
                    "person": overview["user_id"],
                    "sort": key,
                }
            )
            + "#workload-heatmap"
        )

    return {
        "timeline": months,
        "dashboard_categories": list(categories.values()),
        "heatmap": heatmap,
        "heatmap_sort": sort,
        "person_history": [snapshot[1] for snapshot in reversed(snapshots)][0:20]
        if overview["user_id"]
        else [],
    }
