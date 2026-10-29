"""Run separately from web processes; --once is suitable for cron and tests."""

import signal
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from actions.gitlab_sync import sync_connection
from data.models import GitLabConnection


class Command(BaseCommand):
    help = "Poll configured GitLab sources (or synchronize once)."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")

    def handle(self, *args, **options):
        stopping = False

        def stop(*_args):
            nonlocal stopping
            stopping = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        while not stopping:
            close_old_connections()
            for pk in GitLabConnection.objects.filter(enabled=True).values_list("pk", flat=True):
                if stopping:
                    break
                sync_connection(pk, force=options["once"])
            if options["once"]:
                return
            for _ in range(10):
                if stopping:
                    break
                time.sleep(1)
