from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("data", "0018_project_responsible_people"),
    ]

    operations = [
        migrations.AddField(
            model_name="milestone",
            name="require_move_reason",
            field=models.BooleanField(default=False),
        ),
    ]
