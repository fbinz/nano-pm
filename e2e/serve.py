"""Playwright's threaded Django dev server, bound atomically to a free port."""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings_e2e")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.contrib.staticfiles.handlers import StaticFilesHandler  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.core.servers.basehttp import (  # noqa: E402
    ThreadedWSGIServer,
    WSGIRequestHandler,
    get_internal_wsgi_application,
)

parser = argparse.ArgumentParser()
parser.add_argument("--serve-only", action="store_true")
args = parser.parse_args()
if not args.serve_only:
    call_command("migrate", verbosity=0, stdout=sys.stderr)
    call_command("seed_data", stdout=sys.stderr)

application = get_internal_wsgi_application()
if settings.DEBUG:
    application = StaticFilesHandler(application)

# Let the OS allocate the port while binding, rather than closing a temporary
# reservation and racing another worker to re-bind it. Match runserver's
# threaded WSGI and static-file handlers (production mode uses WhiteNoise).
with ThreadedWSGIServer(("127.0.0.1", 0), WSGIRequestHandler) as server:
    server.set_app(application)
    print("NANO_E2E_READY " + json.dumps({"url": f"http://localhost:{server.server_port}"}), flush=True)
    server.serve_forever()
