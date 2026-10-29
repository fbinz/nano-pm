"""Container supervisor: web server and integration workers share one SQLite volume.

Exit if any service stops so the container platform can restart all services. Never
start the worker inside a Django/Gunicorn process (or during migrations/tests).
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    commands = [
        [sys.executable, "-m", "gunicorn", "config.wsgi:application",
         "--bind", f"0.0.0.0:{os.environ.get('PORT', '80')}",
         "--workers", "2", "--threads", "4", "--access-logfile", "-", "--error-logfile", "-"],
        [sys.executable, "manage.py", "deliver_teams_notifications"],
        [sys.executable, "manage.py", "sync_gitlab"],
    ]
    children = []
    try:
        for command in commands:
            children.append(subprocess.Popen(command, cwd=Path(__file__).parent))
        while not stopping:
            if any(child.poll() is not None for child in children):
                return 1
            time.sleep(0.5)
        return 0
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    sys.exit(main())
