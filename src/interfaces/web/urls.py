"""URL routing for the Gantt chart."""

from django.urls import path

from .pages import index, zoom_set, sidebar_width_set
from .tasks import (
    task_popover, task_update, task_move, task_move_many,
    task_resize_start, task_resize_end, task_create, task_delete_view,
)
from .milestones import (
    milestone_popover, milestone_update_view, milestone_delete_view,
    milestone_move, milestone_create,
)
from .dependencies import dep_add, dep_delete
from .projects import (
    project_create, project_popover, project_update, project_move,
    project_move_workspace, project_delete, project_toggle_collapse, set_all_collapsed,
    project_toggle_completed, toggle_show_completed,
)
from .resources import (
    resource_index, person_toggle_collapse, set_all_people_collapsed,
    toggle_status_filter, toggle_team_filter, clear_team_filter,
)
from .people import (
    people_page, people_invite_link, people_create, people_update, people_delete,
    person_role_update, person_teams_update, team_create, team_update, team_delete,
)
from .ideas import (
    ideas_page, idea_create, idea_detail, idea_update, idea_status,
    idea_convert_project, idea_create_task, idea_delete,
)
from .workspaces import (
    workspace_switch, workspace_create, workspace_rename,
    public_roadmap, public_roadmap_update, public_roadmap_regenerate,
)
from .activity import activity_page

urlpatterns = [
    path("", index, name="gantt_index"),
    path("roadmap/<slug:token>/", public_roadmap, name="public_roadmap"),
    path("zoom/", zoom_set, name="zoom_set"),
    path("ui/sidebar-width/", sidebar_width_set, name="sidebar_width_set"),
    # Tasks
    path("tasks/<int:task_id>/popover/",       task_popover,        name="task_popover"),
    path("tasks/<int:task_id>/update/",        task_update,         name="task_update"),
    path("tasks/<int:task_id>/move/",          task_move,           name="task_move"),
    path("tasks/move-many/",                    task_move_many,      name="task_move_many"),
    path("tasks/<int:task_id>/resize/start/",  task_resize_start,   name="task_resize_start"),
    path("tasks/<int:task_id>/resize/end/",    task_resize_end,     name="task_resize_end"),
    path("tasks/create/",                       task_create,         name="task_create"),
    path("tasks/<int:task_id>/delete/",        task_delete_view,    name="task_delete"),
    # Milestones
    path("milestones/<int:milestone_id>/popover/", milestone_popover,     name="milestone_popover"),
    path("milestones/<int:milestone_id>/update/",  milestone_update_view, name="milestone_update"),
    path("milestones/<int:milestone_id>/delete/",  milestone_delete_view, name="milestone_delete"),
    path("milestones/<int:milestone_id>/move/",    milestone_move,        name="milestone_move"),
    path("projects/<int:project_id>/milestones/",  milestone_create,      name="milestone_create"),
    # Dependencies
    path("dependencies/",                                            dep_add,    name="dep_add"),
    path("dependencies/<int:predecessor_id>/<int:successor_id>/delete/",
                                                                     dep_delete, name="dep_delete"),
    # Projects
    path("projects/",                                project_create,   name="project_create"),
    path("projects/<int:project_id>/popover/",       project_popover,  name="project_popover"),
    path("projects/<int:project_id>/update/",        project_update,   name="project_update"),
    path("projects/<int:project_id>/move/",          project_move,     name="project_move"),
    path("projects/<int:project_id>/move-workspace/", project_move_workspace, name="project_move_workspace"),
    path("projects/<int:project_id>/delete/",        project_delete,   name="project_delete"),
    path("projects/<int:project_id>/set-completed/",  project_toggle_completed, name="project_set_completed"),
    path("projects/toggle-completed/",               toggle_show_completed,  name="toggle_show_completed"),
    path("projects/<int:project_id>/toggle-collapse/",
                                                     project_toggle_collapse, name="project_toggle_collapse"),
    path("projects/set-collapsed/",                  set_all_collapsed,       name="set_all_collapsed"),
    # Resource view
    path("resources/",                               resource_index,          name="resource_index"),
    path("resources/people/<int:person_id>/toggle-collapse/",
                                                     person_toggle_collapse,  name="person_toggle_collapse"),
    path("resources/people/set-collapsed/",          set_all_people_collapsed, name="set_all_people_collapsed"),
    path("resources/toggle-status/",                 toggle_status_filter,     name="toggle_status_filter"),
    # Ideas
    path("ideas/",                                  ideas_page,       name="ideas_page"),
    path("ideas/create/",                           idea_create,      name="idea_create"),
    path("ideas/<int:idea_id>/",                    idea_detail,      name="idea_detail"),
    path("ideas/<int:idea_id>/update/",             idea_update,      name="idea_update"),
    path("ideas/<int:idea_id>/status/<str:status>/", idea_status,     name="idea_status"),
    path("ideas/<int:idea_id>/convert/project/",    idea_convert_project, name="idea_convert_project"),
    path("ideas/<int:idea_id>/create-task/",        idea_create_task, name="idea_create_task"),
    path("ideas/<int:idea_id>/delete/",             idea_delete,      name="idea_delete"),
    # People
    path("people/",                                  people_page,      name="people_page"),
    path("activity/",                                activity_page,    name="activity_page"),
    path("people/create/",                           people_create,    name="people_create"),
    path("people/<int:person_id>/invite-link/",      people_invite_link, name="people_invite_link"),
    path("people/<int:person_id>/update/",           people_update,    name="people_update"),
    path("people/<int:person_id>/role/",             person_role_update, name="person_role_update"),
    path("people/<int:person_id>/teams/",            person_teams_update, name="person_teams_update"),
    path("people/<int:person_id>/delete/",           people_delete,    name="people_delete"),
    # Teams
    path("teams/toggle-filter/",                     toggle_team_filter, name="toggle_team_filter"),
    path("teams/clear-filter/",                      clear_team_filter, name="clear_team_filter"),
    path("teams/create/",                            team_create,      name="team_create"),
    path("teams/<int:team_id>/update/",              team_update,      name="team_update"),
    path("teams/<int:team_id>/delete/",              team_delete,      name="team_delete"),
    # Workspaces
    path("workspaces/",                              workspace_create, name="workspace_create"),
    path("workspaces/rename/",                       workspace_rename, name="workspace_rename"),
    path("workspaces/<int:workspace_id>/switch/",    workspace_switch, name="workspace_switch"),
    path("workspaces/public-roadmap/",               public_roadmap_update, name="public_roadmap_update"),
    path("workspaces/public-roadmap/regenerate/",    public_roadmap_regenerate, name="public_roadmap_regenerate"),
]
