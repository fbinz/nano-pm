# Step 2: Create a workspace for each user who owns data, populate FKs.
#
# Handles two paths:
#   - Fresh: owner_id column still exists (new 0003 kept it) → use it.
#   - Already migrated: old 0003 already dropped owner_id → assign all
#     orphaned rows (workspace_id IS NULL) to a workspace per user.

from django.db import connection, migrations


def _column_exists(table, column):
    with connection.cursor() as c:
        c.execute(f"PRAGMA table_info({table})")
        return any(row[1] == column for row in c.fetchall())


def forward(apps, schema_editor):
    User = apps.get_model('auth', 'User')
    Workspace = apps.get_model('data', 'Workspace')
    Membership = apps.get_model('data', 'Membership')
    Project = apps.get_model('data', 'Project')
    Person = apps.get_model('data', 'Person')

    has_owner = _column_exists('data_project', 'owner_id')

    if has_owner:
        # Fresh migration path: owner_id still exists.
        owner_ids = set(
            Project.objects.values_list('owner_id', flat=True).distinct()
        ) | set(
            Person.objects.values_list('owner_id', flat=True).distinct()
        )
        for user_id in owner_ids:
            if user_id is None:
                continue
            user = User.objects.get(id=user_id)
            ws = Workspace.objects.create(name=f"{user.username}'s workspace")
            Membership.objects.create(user=user, workspace=ws, role='pm')
            Project.objects.filter(owner_id=user_id).update(workspace=ws)
            Person.objects.filter(owner_id=user_id).update(workspace=ws)
    else:
        # Old 0003 already dropped owner_id. Assign orphaned rows.
        orphaned_projects = Project.objects.filter(workspace__isnull=True).exists()
        orphaned_people = Person.objects.filter(workspace__isnull=True).exists()
        if not orphaned_projects and not orphaned_people:
            return
        # Create one workspace per existing user who doesn't have one yet.
        for user in User.objects.all():
            if Membership.objects.filter(user=user).exists():
                continue
            ws = Workspace.objects.create(name=f"{user.username}'s workspace")
            Membership.objects.create(user=user, workspace=ws, role='pm')
        # Assign orphaned rows to the first available workspace.
        ws = Workspace.objects.first()
        if ws:
            Project.objects.filter(workspace__isnull=True).update(workspace=ws)
            Person.objects.filter(workspace__isnull=True).update(workspace=ws)


class Migration(migrations.Migration):

    dependencies = [
        ('data', '0003_add_workspace_membership'),
    ]

    operations = [
        migrations.RunPython(forward, migrations.RunPython.noop),
    ]
