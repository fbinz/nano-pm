from django.test import SimpleTestCase

from actions.activity import change_set, created_changes, deleted_changes, redact_long_text_changes


class ActivityChangeRedactionTests(SimpleTestCase):
    def test_long_text_changes_are_not_stored(self):
        old = "old idea description " * 20
        new = "new idea description " * 20

        changes = change_set({"body": old, "title": "Old"}, {"body": new, "title": "New"})

        self.assertEqual(changes["body"], {"changed": True})
        self.assertEqual(changes["title"], {"from": "Old", "to": "New"})
        self.assertNotIn(old, str(changes))
        self.assertNotIn(new, str(changes))

    def test_long_text_create_and_delete_values_are_not_stored(self):
        text = "long description " * 20

        self.assertEqual(created_changes({"description": text}), {"description": {"changed": True}})
        self.assertEqual(deleted_changes({"description": text}), {"description": {"changed": True}})
        self.assertEqual(created_changes({"description": ""}), {})

    def test_log_activity_redaction_catches_manual_changes(self):
        text = "public roadmap text " * 20

        changes = redact_long_text_changes({"public_roadmap_description": {"from": "", "to": text}})

        self.assertEqual(changes, {"public_roadmap_description": {"changed": True}})
        self.assertNotIn(text, str(changes))
