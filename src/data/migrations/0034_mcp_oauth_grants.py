from django.db import migrations, models
import django.db.models.deletion


def bind_receipts(apps, schema_editor):
    Policy = apps.get_model("data", "MCPAccessPolicy")
    Receipt = apps.get_model("data", "MCPMutationReceipt")
    using = schema_editor.connection.alias
    for receipt in Receipt.objects.using(using).all().iterator():
        policy, _ = Policy.objects.using(using).get_or_create(token_id=receipt.token_id)
        Receipt.objects.using(using).filter(pk=receipt.pk).update(policy_id=policy.pk)


def restore_bearer_receipts(apps, schema_editor):
    Policy = apps.get_model("data", "MCPAccessPolicy")
    Receipt = apps.get_model("data", "MCPMutationReceipt")
    using = schema_editor.connection.alias
    # OAuth receipts have no legacy bearer owner and cannot survive downgrade.
    Receipt.objects.using(using).filter(policy__token__isnull=True).delete()
    for receipt in Receipt.objects.using(using).all().iterator():
        token_id = Policy.objects.using(using).get(pk=receipt.policy_id).token_id
        Receipt.objects.using(using).filter(pk=receipt.pk).update(token_id=token_id)
    Policy.objects.using(using).filter(token__isnull=True).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("data", "0033_mcpaccesspolicy_mcpmutationreceipt"),
        ("django_mcpz_oauth", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="mcpaccesspolicy",
            name="token",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="nano_policy",
                to="django_mcpz_bearer_tokens.token",
            ),
        ),
        migrations.AddField(
            model_name="mcpaccesspolicy",
            name="oauth_code",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="nano_policy",
                to="django_mcpz_oauth.authorizationcode",
            ),
        ),
        migrations.AddField(
            model_name="mcpaccesspolicy",
            name="revoked_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="mcpmutationreceipt",
            name="policy",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                to="data.mcpaccesspolicy",
            ),
        ),
        # Nullable here also makes reversal safe: populate token before enforcing NOT NULL.
        migrations.AlterField(
            model_name="mcpmutationreceipt",
            name="token",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                to="django_mcpz_bearer_tokens.token",
            ),
        ),
        migrations.RunPython(bind_receipts, restore_bearer_receipts),
        migrations.RemoveConstraint(
            model_name="mcpmutationreceipt", name="unique_mcp_operation"
        ),
        migrations.RemoveField(model_name="mcpmutationreceipt", name="token"),
        migrations.AlterField(
            model_name="mcpmutationreceipt",
            name="policy",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE, to="data.mcpaccesspolicy"
            ),
        ),
        migrations.AddConstraint(
            model_name="mcpmutationreceipt",
            constraint=models.UniqueConstraint(
                fields=("policy", "tool", "workspace_key", "operation_id"),
                name="unique_mcp_operation",
            ),
        ),
        migrations.AddConstraint(
            model_name="mcpaccesspolicy",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(token__isnull=False, oauth_code__isnull=True)
                    | models.Q(token__isnull=True, oauth_code__isnull=False)
                ),
                name="mcp_policy_one_credential",
            ),
        ),
    ]
