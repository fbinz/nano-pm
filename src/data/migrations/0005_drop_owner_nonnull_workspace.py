# Step 3: Drop owner FKs, make workspace non-null.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('data', '0004_populate_workspaces'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='person',
            name='owner',
        ),
        migrations.RemoveField(
            model_name='project',
            name='owner',
        ),
        migrations.AlterField(
            model_name='person',
            name='workspace',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='people', to='data.workspace'),
        ),
        migrations.AlterField(
            model_name='project',
            name='workspace',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='projects', to='data.workspace'),
        ),
    ]
