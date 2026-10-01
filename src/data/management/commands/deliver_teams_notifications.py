import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from actions.teams_delivery import deliver_next, prune_deliveries


class Command(BaseCommand):
    help = "Deliver the Teams outbox, retrying transient failures. Run separately from the web server."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Drain currently due entries and exit.")

    def handle(self, *args, **options):
        try:
            while True:
                close_old_connections()
                prune_deliveries()
                if deliver_next():
                    continue
                if options["once"]:
                    break
                time.sleep(2)
        except KeyboardInterrupt:
            pass
