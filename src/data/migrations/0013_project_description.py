from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("data", "0012_workspace_public_roadmap"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="description",
            field=models.TextField(blank=True, default=""),
        ),
    ]
