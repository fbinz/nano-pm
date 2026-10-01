"""Deterministic checks of lock classification and retry boundaries.

Actual competing SQLite connections are exercised by the Playwright worker tests.
"""

import sqlite3
from unittest.mock import Mock, patch

from django.db import OperationalError
from django.test import SimpleTestCase

from actions.teams_delivery import retry_sqlite_contention


def database_error(code):
    cause = sqlite3.OperationalError("must not be logged")
    cause.sqlite_errorcode = code
    error = OperationalError("must not be logged")
    error.__cause__ = cause
    return error


class TeamsContentionTests(SimpleTestCase):
    @patch("actions.teams_delivery.time.sleep")
    @patch("actions.teams_delivery.close_old_connections")
    def test_busy_and_locked_retry_with_capped_backoff(self, close, sleep):
        failures = [database_error(code) for code in [
            sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED,
            sqlite3.SQLITE_BUSY_SNAPSHOT, sqlite3.SQLITE_LOCKED_SHAREDCACHE,
            sqlite3.SQLITE_BUSY, sqlite3.SQLITE_BUSY, sqlite3.SQLITE_BUSY,
        ]]
        operation = Mock(side_effect=[*failures, "saved"])
        operation.__name__ = "record_result"
        with self.assertLogs("actions.teams_delivery", level="WARNING") as logs:
            self.assertEqual(retry_sqlite_contention(operation)(), "saved")
        self.assertEqual(operation.call_count, 8)
        self.assertEqual(close.call_count, 7)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.25, 0.5, 1, 2, 4, 5, 5])
        self.assertNotIn("must not be logged", " ".join(logs.output))

    @patch("actions.teams_delivery.time.sleep")
    def test_unrelated_database_errors_are_not_retried(self, sleep):
        for error in [database_error(sqlite3.SQLITE_READONLY), OperationalError("connection lost")]:
            with self.subTest(error=error):
                operation = Mock(side_effect=error)
                operation.__name__ = "record_result"
                with self.assertRaises(OperationalError) as raised:
                    retry_sqlite_contention(operation)()
                self.assertIs(raised.exception, error)
                operation.assert_called_once()
        sleep.assert_not_called()

    @patch("actions.teams_delivery.time.sleep")
    @patch("actions.teams_delivery.connection")
    def test_does_not_retry_inside_an_outer_transaction(self, connection, sleep):
        connection.in_atomic_block = True
        error = database_error(sqlite3.SQLITE_BUSY)
        operation = Mock(side_effect=error)
        operation.__name__ = "claim"
        with self.assertRaises(OperationalError):
            retry_sqlite_contention(operation)()
        operation.assert_called_once()
        sleep.assert_not_called()
