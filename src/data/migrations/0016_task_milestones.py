# Generated manually for task-linked milestones and exclusive task ends.

from datetime import timedelta

from django.db import migrations, models
import django.db.models.deletion


def forwards(apps, schema_editor):
    Task = apps.get_model("data", "Task")
    Milestone = apps.get_model("data", "Milestone")

    linked_task_ids = set()
    for milestone in Milestone.objects.order_by("date", "id"):
        # Existing databases used inclusive task ends, while milestones were
        # zero-duration markers at the start of a day. A milestone that
        # visually coincided with a task's right edge therefore has the date
        # immediately after the stored task end. Only those milestones become
        # task-owned; all other stand-alone milestones remain free.
        task = (
            Task.objects.filter(
                project_id=milestone.project_id,
                end=milestone.date - timedelta(days=1),
            )
            .exclude(id__in=linked_task_ids)
            .order_by("start", "id")
            .first()
        )
        if task is None:
            continue
        milestone.task_id = task.id
        milestone.save(update_fields=["task", "updated_at"])
        linked_task_ids.add(task.id)

    # Switch task end dates from inclusive to exclusive without changing the
    # existing visual schedule. Linked milestones already sit at the new
    # exclusive end date because of the matching rule above.
    for task in Task.objects.all().iterator():
        task.end = task.end + timedelta(days=1)
        task.save(update_fields=["end"])


def backwards(apps, schema_editor):
    Task = apps.get_model("data", "Task")
    for task in Task.objects.all().iterator():
        task.end = task.end - timedelta(days=1)
        if task.end < task.start:
            task.end = task.start
        task.save(update_fields=["end"])


class Migration(migrations.Migration):

    dependencies = [
        ("data", "0015_activity_event"),
    ]

    operations = [
        migrations.AddField(
            model_name="milestone",
            name="task",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="milestone",
                to="data.task",
            ),
        ),
        migrations.RunPython(forwards, backwards),
    ]
