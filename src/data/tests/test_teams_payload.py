"""Pure serialization/security checks; browser flows live in Playwright."""

import json

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, override_settings

from actions.teams_delivery import validate_webhook_url
from actions.teams_notifications import MILESTONE_MOVED, MILESTONE_UPDATED, _teams_payload, _with_mentions
from data.models import Project, Workspace


class TeamsPayloadTests(SimpleTestCase):
    def test_compact_move_dates_and_direction(self):
        cases = [
            ("2026-10-06", "2026-10-05", "Jetzt **5. Okt. 2026** — 1 Tag früher"),
            ("2026-10-05", "2026-10-06", "Jetzt **6. Okt. 2026** — 1 Tag später"),
            ("2026-10-05", "2026-10-03", "Jetzt **3. Okt. 2026** — 2 Tage früher"),
            ("2026-10-05", "2026-10-12", "Jetzt **12. Okt. 2026** — 1 Woche später"),
            ("2026-10-12", "2026-10-05", "Jetzt **5. Okt. 2026** — 1 Woche früher"),
            ("2026-10-05", "2026-10-19", "Jetzt **19. Okt. 2026** — 2 Wochen später"),
            ("2026-01-01", "2025-12-31", "Jetzt **31. Dez. 2025** — 1 Tag früher"),
            ("2026-12-31", "2027-01-01", "Jetzt **1. Jan. 2027** — 1 Tag später"),
        ]
        for before, after, expected in cases:
            with self.subTest(before=before, after=after):
                payload = _teams_payload(
                    project=Project(name="HR Automatisierungen"),
                    milestone_title="Neue Verträge",
                    event_names={MILESTONE_MOVED},
                    changes={"date": {"from": before, "to": after}},
                    move_reason="  ",
                )
                card = payload["attachments"][0]["content"]
                self.assertEqual(card["body"][3]["text"], expected)
                self.assertEqual(len(card["body"]), 4)  # No empty reason or actor footer.
                self.assertEqual(list(_with_mentions(payload, [])), [payload])

    def test_move_date_and_reason_survive_a_long_description_update(self):
        payload = _teams_payload(
            project=Project(name="HR Automatisierungen"),
            milestone_title="Neue Verträge",
            event_names={MILESTONE_MOVED, MILESTONE_UPDATED},
            changes={
                "description": {"changed": True},
                "date": {"from": "2026-10-06", "to": "2026-10-05"},
            },
            milestone_description="Details " * 1000,
            move_reason="  Datenschutz  ",
            actor=User(username="Philipp"),
        )
        body = payload["attachments"][0]["content"]["body"]
        self.assertTrue(body[3]["text"].startswith("Jetzt **5. Okt. 2026** — 1 Tag früher"))
        self.assertEqual(len(body[3]["text"]), 2000)
        self.assertEqual(body[4]["text"], "**Grund:** Datenschutz")
        self.assertEqual(body[5]["text"], "Philipp")

    def test_many_mentions_preserve_every_recipient_and_card_size(self):
        payload = _teams_payload(
            project=Project(name="😀" * 200, workspace=Workspace(name="Test")),
            milestone_title="😀" * 200,
            event_names={MILESTONE_MOVED, MILESTONE_UPDATED},
            milestone_description="😀" * 10000,
            move_reason="😀" * 500,
            actor=User(username="Philipp"),
            changes={
                "date": {"from": "2026-10-06", "to": "2026-10-05"},
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
            self.assertTrue(card["body"][-1]["text"].startswith("Philipp · <at>"))
            for entity in card["msteams"]["entities"]:
                self.assertIn(entity["text"], card["body"][-1]["text"])
                received.append(entity["mentioned"]["id"])
        self.assertEqual(received, upns)
        self.assertNotIn("msteams", payload["attachments"][0]["content"])
        self.assertEqual(payload["attachments"][0]["content"]["body"][-1]["text"], "Philipp")

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
