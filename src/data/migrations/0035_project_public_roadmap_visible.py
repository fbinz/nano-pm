from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("data", "0034_mcp_oauth_grants"),
    ]

    operations = [
        # Preserve visibility for existing projects, but require new ones to opt in.
        migrations.AddField(
            model_name="project",
            name="public_roadmap_visible",
            field=models.BooleanField(default=True),
        ),
        migrations.AlterField(
            model_name="project",
            name="public_roadmap_visible",
            field=models.BooleanField(default=False),
        ),
    ]
