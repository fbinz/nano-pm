# Generated manually for public roadmap support.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("data", "0011_team_person_teams"),
    ]

    operations = [
        migrations.AddField(
            model_name="workspace",
            name="public_roadmap_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="workspace",
            name="public_roadmap_token",
            field=models.SlugField(blank=True, max_length=50, null=True, unique=True),
        ),
        migrations.AddField(
            model_name="workspace",
            name="public_roadmap_title",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="workspace",
            name="public_roadmap_description",
            field=models.TextField(blank=True, default=""),
        ),
    ]
