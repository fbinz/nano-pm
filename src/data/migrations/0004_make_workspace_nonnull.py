import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('data', '0003_add_workspace_membership'),
    ]

    operations = [
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
