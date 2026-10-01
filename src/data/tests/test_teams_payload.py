"""Pure serialization/security checks; browser flows live in Playwright."""

import json

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, override_settings

from actions.teams_delivery import validate_webhook_url
from actions.teams_notifications import MILESTONE_UPDATED, _teams_payload, _with_mentions
from data.models import Project, Workspace


class TeamsPayloadTests(SimpleTestCase):
    def test_many_mentions_preserve_every_recipient_and_card_size(self):
        payload = _teams_payload(
            project=Project(name="😀" * 200, workspace=Workspace(name="Test")),
            milestone_title="😀" * 200,
            event_names={MILESTONE_UPDATED},
            milestone_description="😀" * 10000,
            changes={
                "description": {"changed": True},
                "title": {"from": "😀" * 500, "to": "😀" * 500},
                "project": {"from": "😀" * 500, "to": "😀" * 500},
                "task": {"from": "😀" * 500, "to": "😀" * 500},
            },
        )
        upns = [f"user-{index}@example.com" for index in range(500)]
        cards = list(_with_mentions(payload, upns))
        self.assertGreater(len(cards), 1)
        received = []
        for item in cards:
            self.assertLessEqual(len(json.dumps(item, ensure_ascii=False).encode()), 28000)
            card = item["attachments"][0]["content"]
            for entity in card["msteams"]["entities"]:
                self.assertIn(entity["text"], card["body"][-1]["text"])
                received.append(entity["mentioned"]["id"])
        self.assertEqual(received, upns)
        self.assertNotIn("msteams", payload["attachments"][0]["content"])

    @override_settings(ENABLE_TEST_RESET=False)
    def test_only_https_microsoft_webhook_hosts_are_allowed(self):
        allowed = [
            "https://tenant.environment.api.powerplatform.com:443/powerautomate/test?sig=example",
            "https://tenant.webhook.office.com/webhookb2/example",
            "https://region.logic.azure.com/workflows/example",
            "https://outlook.office.com/webhook/example",
        ]
        for url in allowed:
            with self.subTest(url=url):
                validate_webhook_url(url)
        rejected = [
            "http://127.0.0.1:12345", "http://tenant.webhook.office.com/example",
            "https://127.0.0.1", "file:///etc/passwd",
            "https://tenant.webhook.office.com.evil.example/test",
            "https://evilwebhook.office.com/test",
            "https://user:pass@tenant.webhook.office.com/test",
            "https://tenant.webhook.office.com:12345/test",
            "https://tenant.webhook.office.com/test#fragment",
        ]
        for url in rejected:
            with self.subTest(url=url), self.assertRaises(ValidationError):
                validate_webhook_url(url)

    @override_settings(ENABLE_TEST_RESET=True)
    def test_loopback_is_allowed_only_for_test_receivers(self):
        validate_webhook_url("http://127.0.0.1:12345/receiver")
        with self.assertRaises(ValidationError):
            validate_webhook_url("http://192.168.1.1/receiver")
