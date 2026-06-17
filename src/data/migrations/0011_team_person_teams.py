# Generated manually for nano-pm team support.

import django.db.models.deletion
import django.db.models.functions.text
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("data", "0010_remove_task_status_and_taskorder"),
    ]

    operations = [
        migrations.CreateModel(
            name="Team",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=100)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="teams",
                        to="data.workspace",
                    ),
                ),
            ],
            options={
                "ordering": ["name", "id"],
            },
        ),
        migrations.AddField(
            model_name="person",
            name="teams",
            field=models.ManyToManyField(blank=True, related_name="people", to="data.team"),
        ),
        migrations.AddConstraint(
            model_name="team",
            constraint=models.UniqueConstraint(
                django.db.models.functions.text.Lower("name"),
                models.F("workspace"),
                name="unique_team_name_per_workspace_ci",
            ),
        ),
    ]
