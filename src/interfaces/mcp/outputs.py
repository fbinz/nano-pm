"""Advertised and runtime-validated output envelopes and explicit DTO schemas."""

from typing import Any, Generic, NotRequired, TypeVar, TypedDict

T = TypeVar("T")


class Revision(TypedDict):
    revision: str


class Workspace(Revision):
    id: int
    name: str
    prompt_milestone_move_reason: bool
    role: NotRequired[str]


class Project(Revision):
    id: int
    workspace_id: int
    name: str
    color: str
    order: float
    completed_at: str | None
    responsible_person_ids: list[int]
    description: NotRequired[str]


class Task(Revision):
    id: int
    project_id: int
    title: str
    start: str
    end: str
    status: str
    assignee_ids: list[int]
    milestone_id: int | None
    predecessor_ids: list[int]
    successor_ids: list[int]
    description: NotRequired[str]


class Milestone(Revision):
    id: int
    project_id: int
    task_id: int | None
    title: str
    date: str
    require_move_reason: bool
    description: NotRequired[str]


class Dependency(Revision):
    id: int
    predecessor_id: int
    successor_id: int


class Person(Revision):
    id: int
    name: str
    linked: bool
    team_ids: list[int]


class Team(Revision):
    id: int
    name: str
    member_ids: list[int]
    member_count: int


class Membership(Revision):
    id: int
    role: str
    workload_participation: str
    user_label: str


class Idea(Revision):
    id: int
    title: str
    body: NotRequired[str]
    status: str
    tags: str
    creator_id: int | None
    converted_project_id: int | None
    converted_task_id: int | None


class Activity(TypedDict):
    id: int
    action: str
    entity_type: str
    entity_id: int | None
    actor_id: int | None
    created_at: str
    changes: dict[str, Any]


class Effect(TypedDict):
    changed_ids: list[int]
    deleted_ids: list[int]
    changed_count: int
    deleted_count: int
    truncated: bool


class Effects(TypedDict):
    tasks: Effect
    milestones: Effect
    read_tools: list[str]


class Item(TypedDict, Generic[T]):
    item: T
    effects: NotRequired[Effects]


class Page(TypedDict, Generic[T]):
    items: list[T]
    next_cursor: str | None
    revision: NotRequired[str]
    effects: NotRequired[Effects]


class Deleted(TypedDict):
    deleted_ids: list[int]
    effects: NotRequired[Effects]
    assignment_count: NotRequired[int]
    responsibility_count: NotRequired[int]
    detached_people_count: NotRequired[int]


class Identity(TypedDict):
    id: int
    username: str
    capabilities: list[str]


class Workspaces(TypedDict):
    items: list[Workspace]


class WorkspaceResult(Item[Workspace]):
    role: NotRequired[str]


class Transfer(Item[Project]):
    target_workspace_id: int
    consequences: list[str]


class Schedule(Page[dict[str, Any]]):
    today: str


class IdeaConversion(Item[Idea]):
    project: NotRequired[Project]
    task: NotRequired[Task]


class Category(Revision):
    id: int
    name: str
    active: bool
    supports_projects: bool
    order: int


class ProjectAllocation(TypedDict):
    project_id: int | None
    project_label: str
    percentage: int


class Allocation(TypedDict):
    category_id: int | None
    category_label: str
    supports_projects: bool
    percentage: int
    projects: list[ProjectAllocation]


class Report(Revision):
    id: int
    user_id: int | None
    user_label: str
    reviewed_at: str
    allocations: list[Allocation]


class WorkloadSettings(Revision):
    workload_enabled: bool
    workload_checkin_enabled: bool
    workload_checkin_interval_days: int
    workload_members_included: bool
    workload_pms_included: bool


class MyWorkload(Revision):
    latest: Report | None
    categories: list[Category]
    projects: list[Project]
    projects_truncated: bool
    snoozed_until: str | None
    settings: WorkloadSettings


class Submitted(Item[Report]):
    state: MyWorkload


class OverviewMember(TypedDict):
    membership: Membership
    included: bool
    report: Report | None


class Overview(Page[OverviewMember]):
    participating: int
    reported: int
    averages: list[dict[str, Any]]


class Connection(Revision):
    configured: bool
    enabled: NotRequired[bool]
    project_ids: NotRequired[list[int]]
    group_ids: NotRequired[list[int]]
    workflow: NotRequired[dict[str, Any]]
    last_success: NotRequired[str | None]
    sync_status: NotRequired[str]
    stale: NotRequired[bool]


class Binding(Revision):
    project_id: int
    prefix: str | None
    collect: bool


class Issue(Revision):
    id: int
    gitlab_project_id: int
    iid: int
    title: str
    owner_id: int | None
    state: str
    source_state: str
    unavailable: bool
    url: NotRequired[str | None]
    labels: NotRequired[list[str]]
    intervals: NotRequired[list[dict[str, Any]]]


class NotificationSettings(Revision):
    events: list[str]
    subscriber_domains: list[str]
    configured: bool


class Delivery(TypedDict):
    id: int
    status: str
    attempts: int
    created_at: str
    available_at: str


class Subscription(Revision):
    project_id: int
    subscribed: bool


class Roadmap(Revision):
    enabled: bool
    title: str
    description: str


class Link(TypedDict):
    url: str


OUTPUTS = {}


def register(names, output):
    for name in names.split():
        OUTPUTS[name] = output


register("get_me", Identity)
register("list_workspaces", Workspaces)
register("get_workspace create_workspace update_workspace", WorkspaceResult)
register("list_activity", Page[Activity])
register("get_schedule", Schedule)
register("list_projects", Page[Project])
register(
    "get_project create_project update_project claim_project set_project_completed",
    Item[Project],
)
register("reorder_projects", Revision)
register("move_project_to_workspace", Transfer)
register("list_tasks move_tasks", Page[Task])
register("get_task create_task update_task claim_task move_task", Item[Task])
register("list_milestones", Page[Milestone])
register("get_milestone create_milestone update_milestone", Item[Milestone])
register("list_dependencies", Page[Dependency])
register("add_dependency", Item[Dependency])
register("list_people", Page[Person])
register("get_person create_person update_person", Item[Person])
register("list_teams", Page[Team])
register("create_team update_team", Item[Team])
register("list_memberships", Page[Membership])
register("set_member_role set_workload_participation", Item[Membership])
register("list_ideas", Page[Idea])
register("get_idea create_idea update_idea", Item[Idea])
register("convert_idea_to_project convert_idea_to_task", IdeaConversion)
register("get_my_workload snooze_my_workload_checkin", Item[MyWorkload])
register("submit_my_workload review_my_workload", Submitted)
register("get_workload_overview", Overview)
register("list_workload_reports", Page[Report])
register("get_workload_report", Item[Report])
register("get_workload_settings update_workload_settings", Item[WorkloadSettings])
register("list_workload_categories", Page[Category])
register("create_workload_category update_workload_category", Item[Category])
register(
    "get_gitlab_connection request_gitlab_sync update_gitlab_workflow", Item[Connection]
)
register("list_gitlab_issues", Page[Issue])
register("get_gitlab_issue transfer_gitlab_issue", Item[Issue])
register("get_project_gitlab_binding update_project_gitlab_binding", Item[Binding])
register(
    "get_notification_settings update_notification_settings", Item[NotificationSettings]
)
register("list_notification_deliveries", Page[Delivery])
register("list_my_project_subscriptions", Page[Subscription])
register("set_my_project_subscription", Subscription)
register("get_public_roadmap_settings update_public_roadmap_settings", Item[Roadmap])
register(
    "get_public_roadmap_link rotate_public_roadmap_link create_person_invite", Link
)
register(
    "delete_project delete_task delete_milestone delete_dependency delete_person delete_team delete_idea delete_workload_category",
    Deleted,
)
