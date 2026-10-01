from django.db import migrations


def redact_webhook_secrets(apps, schema_editor):
    # No legacy configuration import. Keep the migration name for databases
    # that have already applied it; only historical secret cleanup is needed.
    ActivityEvent = apps.get_model("data", "ActivityEvent")

    def redact(value):
        if not isinstance(value, dict):
            return value
        return {
            key: {"changed": True} if key == "teams_webhook_url" else redact(item)
            for key, item in value.items()
        }

    for event in ActivityEvent.objects.all().iterator():
        cleaned = redact(event.changes)
        if cleaned != event.changes:
            event.changes = cleaned
            event.save(update_fields=["changes"])


class Migration(migrations.Migration):
    dependencies = [("data", "0020_membership_teams_upn_workspace_teams_notify_events_and_more")]
    operations = [migrations.RunPython(redact_webhook_secrets, migrations.RunPython.noop)]
