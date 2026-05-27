# Step 3: Drop owner FKs (if they still exist), make workspace non-null.

import django.db.models.deletion
from django.conf import settings
from django.db import connection, migrations, models


def _column_exists(table, column):
    with connection.cursor() as c:
        c.execute(f"PRAGMA table_info({table})")
        return any(row[1] == column for row in c.fetchall())


class ConditionalRemoveField(migrations.RemoveField):
    """RemoveField that silently no-ops if the column is already gone."""

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        table = from_state.apps.get_model(app_label, self.model_name)._meta.db_table
        if _column_exists(table, self.name + '_id'):
            super().database_forwards(app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):

    dependencies = [
        ('data', '0004_populate_workspaces'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        ConditionalRemoveField(
            model_name='person',
            name='owner',
        ),
        ConditionalRemoveField(
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
