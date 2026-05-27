# Step 2: Create a workspace for each user who owns data, populate FKs.

from django.db import migrations


def forward(apps, schema_editor):
    User = apps.get_model('auth', 'User')
    Workspace = apps.get_model('data', 'Workspace')
    Membership = apps.get_model('data', 'Membership')
    Project = apps.get_model('data', 'Project')
    Person = apps.get_model('data', 'Person')

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


class Migration(migrations.Migration):

    dependencies = [
        ('data', '0003_add_workspace_membership'),
    ]

    operations = [
        migrations.RunPython(forward, migrations.RunPython.noop),
    ]
