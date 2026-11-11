"""Typed, bounded wire inputs. UNSET distinguishes omission from explicit null."""

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

import msgspec

Date = date
ID = Annotated[int, msgspec.Meta(ge=1)]
Name = Annotated[str, msgspec.Meta(min_length=1, max_length=200)]
PersonName = Annotated[str, msgspec.Meta(min_length=1, max_length=100)]
Text = Annotated[str, msgspec.Meta(max_length=20000)]
Search = Annotated[str, msgspec.Meta(max_length=200)]
IDs = Annotated[list[ID], msgspec.Meta(max_length=100)]
Revision = Annotated[str, msgspec.Meta(min_length=64, max_length=64)]
UNSET = msgspec.UNSET


class Empty(msgspec.Struct, forbid_unknown_fields=True, kw_only=True):
    pass


class WorkspaceParams(Empty, kw_only=True):
    workspace_id: ID


class Page(WorkspaceParams, kw_only=True):
    limit: Annotated[int, msgspec.Meta(ge=1, le=100)] = 25
    cursor: Annotated[str, msgspec.Meta(max_length=4096)] | None = None


class SearchPage(Page, kw_only=True):
    search: Search = ""


class ObjectParams(WorkspaceParams, kw_only=True):
    id: ID


class Mutation(WorkspaceParams, kw_only=True):
    operation_id: UUID


class Change(Mutation, kw_only=True):
    if_match: Revision


class ObjectChange(Change, kw_only=True):
    id: ID


class WorkspaceCreate(Empty, kw_only=True):
    operation_id: UUID
    name: Name


class WorkspaceUpdate(Change, kw_only=True):
    name: Name = UNSET
    prompt_milestone_move_reason: bool = UNSET


ProjectPhase = Literal["idea", "discovery", "shaping", "planned", "delivery", "review", "completed", "parked", "dropped"]


class ProjectPage(SearchPage, kw_only=True):
    phase: ProjectPhase | None = None
    completed: bool | None = None
    responsible_person_id: ID | None = None
    team_id: ID | None = None


class ProjectCreate(Mutation, kw_only=True):
    name: Name
    description: Text = ""
    color: (
        Annotated[str, msgspec.Meta(pattern=r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")]
        | None
    ) = None
    responsible_person_ids: IDs = []
    public_roadmap_visible: bool = False


class ProjectUpdate(ObjectChange, kw_only=True):
    outcome: Text = UNSET
    scope: Text = UNSET
    constraints: Text = UNSET
    checkpoint: Annotated[str, msgspec.Meta(max_length=500)] = UNSET
    checkpoint_date: date | None = UNSET
    name: Name = UNSET
    description: Text = UNSET
    color: Annotated[
        str, msgspec.Meta(pattern=r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
    ] = UNSET
    responsible_person_ids: IDs = UNSET
    public_roadmap_visible: bool = UNSET


class PhaseChange(ObjectChange, kw_only=True):
    phase: ProjectPhase
    reason: Text = ""


class Completed(ObjectChange, kw_only=True):
    completed: bool


class Reorder(Change, kw_only=True):
    project_ids: Annotated[list[ID], msgspec.Meta(min_length=2, max_length=100)]


class TransferProject(ObjectChange, kw_only=True):
    target_workspace_id: ID


class TaskPage(SearchPage, kw_only=True):
    project_id: ID | None = None
    assignee_id: ID | None = None
    team_id: ID | None = None
    status: Literal["planned", "in-progress", "done"] | None = None
    start: date | None = None
    end: date | None = None


class TaskCreate(Mutation, kw_only=True):
    project_id: ID
    title: Name
    start: date
    end: date
    description: Text = ""
    assignee_ids: IDs = []
    milestone_id: ID | None = None


class TaskUpdate(ObjectChange, kw_only=True):
    title: Name = UNSET
    description: Text = UNSET
    start: date = UNSET
    end: date = UNSET
    project_id: ID = UNSET
    assignee_ids: IDs = UNSET
    milestone_id: ID | None = UNSET


class MoveTask(ObjectChange, kw_only=True):
    new_start: date


class Target(Empty, kw_only=True):
    id: ID
    if_match: Revision


class MoveTasks(Mutation, kw_only=True):
    targets: Annotated[list[Target], msgspec.Meta(min_length=1, max_length=100)]
    delta_days: Annotated[int, msgspec.Meta(ge=-3650, le=3650)]


class MilestonePage(Page, kw_only=True):
    project_id: ID | None = None
    task_id: ID | None = None
    linked: bool | None = None
    start: date | None = None
    end: date | None = None


class MilestoneCreate(Mutation, kw_only=True):
    project_id: ID
    title: Name
    date: Date
    description: Text = ""
    task_id: ID | None = None
    require_move_reason: bool = False


class MilestoneUpdate(ObjectChange, kw_only=True):
    title: Name = UNSET
    description: Text = UNSET
    date: Date = UNSET
    project_id: ID = UNSET
    task_id: ID | None = UNSET
    require_move_reason: bool = UNSET
    move_reason: Annotated[str, msgspec.Meta(max_length=500)] = ""


class DependencyPage(Page, kw_only=True):
    project_id: ID | None = None
    task_id: ID | None = None


class DependencyCreate(Mutation, kw_only=True):
    predecessor_id: ID
    successor_id: ID
    predecessor_revision: Revision
    successor_revision: Revision


class DependencyDelete(Change, kw_only=True):
    predecessor_id: ID
    successor_id: ID


class PeoplePage(SearchPage, kw_only=True):
    team_id: ID | None = None
    linked: bool | None = None


class PersonCreate(Mutation, kw_only=True):
    name: PersonName
    team_ids: IDs = []


class PersonUpdate(ObjectChange, kw_only=True):
    name: PersonName = UNSET
    team_ids: IDs = UNSET


class TeamCreate(Mutation, kw_only=True):
    name: PersonName


class TeamUpdate(ObjectChange, kw_only=True):
    name: PersonName


class RoleUpdate(ObjectChange, kw_only=True):
    role: Literal["pm", "member"]


class ActivityPage(Page, kw_only=True):
    entity_type: (
        Literal[
            "workspace",
            "project",
            "task",
            "tasks",
            "milestone",
            "dependency",
            "person",
            "team",
        ]
        | None
    ) = None
    entity_id: ID | None = None
    actor_id: ID | None = None
    start: date | None = None
    end: date | None = None


class SchedulePage(Page, kw_only=True):
    start: date
    end: date
    project_ids: IDs = []


class WorkloadSettings(Change, kw_only=True):
    workload_enabled: bool = UNSET
    workload_checkin_enabled: bool = UNSET
    workload_members_included: bool = UNSET
    workload_pms_included: bool = UNSET
    workload_checkin_interval_days: Annotated[int, msgspec.Meta(ge=1, le=365)] = UNSET


class CategoryCreate(Mutation, kw_only=True):
    name: PersonName
    active: bool = True
    supports_projects: bool = False


class CategoryUpdate(ObjectChange, kw_only=True):
    name: PersonName = UNSET
    active: bool = UNSET
    supports_projects: bool = UNSET


class Participation(ObjectChange, kw_only=True):
    value: Literal["inherit", "included", "exempt"]


Percentage = Annotated[int, msgspec.Meta(ge=0, le=100)]


class ProjectAllocation(Empty, kw_only=True):
    project_id: ID
    percentage: Percentage


class Allocation(Empty, kw_only=True):
    category_id: ID
    percentage: Percentage
    projects: Annotated[list[ProjectAllocation], msgspec.Meta(max_length=100)] = []


class WorkloadSubmit(Change, kw_only=True):
    allocations: Annotated[list[Allocation], msgspec.Meta(min_length=1, max_length=100)]
    checkin: bool = False


class ReportPage(Page, kw_only=True):
    membership_id: ID | None = None
    team_id: ID | None = None
    start: date | None = None
    end: date | None = None


class GitLabPage(SearchPage, kw_only=True):
    project_id: ID | None = None
    state: Literal["unclassified", "not-started", "in-progress", "done"] | None = None


class BindingUpdate(ObjectChange, kw_only=True):
    prefix: Name = UNSET
    collect: bool = UNSET


class IssueTransfer(ObjectChange, kw_only=True):
    project_id: ID


Labels = Annotated[list[Name], msgspec.Meta(max_length=100)]


class WorkflowUpdate(Change, kw_only=True):
    in_progress_labels: Labels
    done_labels: Labels
    not_started_labels: Labels
    fallback: Literal["unclassified", "not-started", "in-progress", "done"]


class NotificationUpdate(Change, kw_only=True):
    events: Annotated[
        list[
            Literal[
                "milestone.created",
                "milestone.moved",
                "milestone.updated",
                "milestone.project_changed",
                "milestone.deleted",
            ]
        ],
        msgspec.Meta(max_length=5),
    ] = UNSET
    subscriber_domains: Annotated[list[Search], msgspec.Meta(max_length=100)] = UNSET


class DeliveryPage(Page, kw_only=True):
    status: Literal["pending", "sending", "sent", "failed", "cancelled"] | None = None
    start: date | None = None
    end: date | None = None


class SubscriptionChange(ObjectChange, kw_only=True):
    subscribed: bool


class RoadmapUpdate(Change, kw_only=True):
    enabled: bool = UNSET
    title: Name = UNSET
    description: Text = UNSET
