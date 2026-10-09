"""Workspace-scoped, validated inputs for the full-page detail editors."""

from django import forms
from django.db.models import Q
from django.utils.translation import gettext_lazy as _

from data.models import Milestone, Person, Project
from data.models.project import PROJECT_COLORS


class DetailForm(forms.Form):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            if isinstance(field.widget, forms.CheckboxSelectMultiple):
                field.widget.attrs["class"] = "checkbox checkbox-sm"
            elif isinstance(field.widget, forms.Select):
                field.widget.attrs["class"] = "select w-full text-base"
            elif isinstance(field.widget, forms.Textarea):
                field.widget.attrs.update({"class": "textarea w-full text-base", "rows": 4})
            else:
                field.widget.attrs["class"] = "input w-full text-base"


class MilestoneChoiceField(forms.ModelChoiceField):
    def label_from_instance(self, milestone):
        return f"{milestone.project.name} — {milestone.title}"


class TaskDetailForm(DetailForm):
    title = forms.CharField(label=_("Title"), max_length=200)
    description = forms.CharField(label=_("Description"), required=False, strip=False, widget=forms.Textarea)
    start = forms.DateField(label=_("Start"), widget=forms.DateInput(format="%Y-%m-%d", attrs={"type": "date"}))
    end = forms.DateField(label=_("End (exclusive)"), widget=forms.DateInput(format="%Y-%m-%d", attrs={"type": "date"}))
    project_id = forms.ModelChoiceField(label=_("Project"), queryset=Project.objects.none(), empty_label=None)
    assignee_ids = forms.ModelMultipleChoiceField(
        label=_("Assignees"), queryset=Person.objects.none(), required=False,
        widget=forms.CheckboxSelectMultiple,
    )
    milestone_id = MilestoneChoiceField(
        label=_("Milestone"), queryset=Milestone.objects.none(), required=False,
        empty_label=_("No milestone"),
    )

    def __init__(self, *args, task, workspace, **kwargs):
        self.task = task
        milestone = getattr(task, "milestone", None)
        kwargs.setdefault("auto_id", "task-edit-%s")
        kwargs.setdefault("initial", {
            "title": task.title, "description": task.description,
            "start": task.start, "end": task.end, "project_id": task.project_id,
            "assignee_ids": [person.id for person in task.assignees.all()],
            "milestone_id": milestone.id if milestone else None,
        })
        super().__init__(*args, **kwargs)
        self.fields["project_id"].queryset = Project.objects.filter(workspace=workspace)
        self.fields["assignee_ids"].queryset = Person.objects.filter(workspace=workspace).order_by("name", "id")
        self.fields["milestone_id"].queryset = (
            Milestone.objects.filter(project__workspace=workspace)
            .filter(Q(task__isnull=True) | Q(task=task))
            .select_related("project").order_by("project__order", "date", "id")
        )

    def clean(self):
        data = super().clean()
        start, end = data.get("start"), data.get("end")
        if start and end and end <= start:
            self.add_error("end", _("End must be after start."))
        project, milestone = data.get("project_id"), data.get("milestone_id")
        if project and milestone and milestone.task_id != self.task.id and milestone.project_id != project.id:
            self.add_error("milestone_id", _("Choose a milestone from the selected project."))
        return data


class ProjectDetailForm(DetailForm):
    name = forms.CharField(label=_("Name"), max_length=200)
    description = forms.CharField(label=_("Description"), required=False, strip=False, widget=forms.Textarea)
    color = forms.ChoiceField(label=_("Color"), choices=[(color, color) for color in PROJECT_COLORS])
    responsible_person_ids = forms.ModelMultipleChoiceField(
        label=_("Responsible people"), queryset=Person.objects.none(), required=False,
        widget=forms.CheckboxSelectMultiple,
    )

    def __init__(self, *args, project, workspace, **kwargs):
        kwargs.setdefault("auto_id", "project-edit-%s")
        kwargs.setdefault("initial", {
            "name": project.name, "description": project.description, "color": project.color,
            "responsible_person_ids": list(project.responsible_people.values_list("id", flat=True)),
        })
        super().__init__(*args, **kwargs)
        self.fields["responsible_person_ids"].queryset = Person.objects.filter(workspace=workspace).order_by("name", "id")
