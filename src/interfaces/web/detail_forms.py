"""Workspace-scoped, validated inputs for the full-page detail editors."""

from django import forms
from django.db.models import Q
from django.utils.translation import gettext_lazy as _

from data.models import Milestone, Person, Project, ProjectPhase, JournalKind
from data.models.project import PROJECT_COLORS


class ColorSwatchSelect(forms.RadioSelect):
    is_color_picker = True


class DetailForm(forms.Form):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            if isinstance(field.widget, ColorSwatchSelect):
                field.widget.attrs["class"] = "color-picker-input"
            elif isinstance(field.widget, (forms.CheckboxInput, forms.CheckboxSelectMultiple)):
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
    public_roadmap_visible = forms.BooleanField(label=_("Visible in public roadmap"), required=False)
    name = forms.CharField(label=_("Name"), max_length=200)
    description = forms.CharField(label=_("Description"), required=False, strip=False, widget=forms.Textarea)
    color = forms.ChoiceField(
        label=_("Color"),
        choices=list(zip(PROJECT_COLORS, [
            _("Blue"), _("Green"), _("Amber"), _("Violet"), _("Pink"),
            _("Cyan"), _("Red"), _("Lime"), _("Orange"), _("Sky blue"),
        ], strict=True)),
        widget=ColorSwatchSelect,
    )
    responsible_person_ids = forms.ModelMultipleChoiceField(
        label=_("Responsible people"), queryset=Person.objects.none(), required=False,
        widget=forms.CheckboxSelectMultiple,
    )

    def __init__(self, *args, project, workspace, **kwargs):
        kwargs.setdefault("auto_id", "project-edit-%s")
        kwargs.setdefault("initial", {
            "name": project.name, "description": project.description, "color": project.color,
            "public_roadmap_visible": project.public_roadmap_visible,
            "responsible_person_ids": list(project.responsible_people.values_list("id", flat=True)),
        })
        super().__init__(*args, **kwargs)
        self.fields["responsible_person_ids"].queryset = Person.objects.filter(workspace=workspace).order_by("name", "id")


class ProjectCreateForm(DetailForm):
    name = forms.CharField(label=_("Project name"), max_length=200)


class ProjectPhaseForm(DetailForm):
    phase = forms.ChoiceField(label=_("Project phase"), choices=ProjectPhase.choices)
    reason = forms.CharField(label=_("Reason for phase change"), required=False, max_length=20000, widget=forms.Textarea)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["reason"].widget.attrs["rows"] = 2


class JournalEntryForm(DetailForm):
    kind = forms.ChoiceField(label=_("Entry type"), choices=[choice for choice in JournalKind.choices if choice[0] != JournalKind.PHASE])
    body = forms.CharField(label=_("Journal entry"), max_length=20000, widget=forms.Textarea(attrs={"placeholder": _("A thought, a conversation, something worth remembering…")}))

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["kind"].widget.attrs["class"] = "select select-sm w-auto text-xs"
        self.fields["body"].widget.attrs["rows"] = 2


class JournalReplyForm(DetailForm):
    body = forms.CharField(label=_("Reply"), max_length=20000, widget=forms.Textarea)
