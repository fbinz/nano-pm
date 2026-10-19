"""Fast authentication for the isolated Playwright server, never normal app runs."""

import os

from django.core.exceptions import ImproperlyConfigured

from .settings import *  # noqa: F403
from .settings import ALLOW_INSECURE_SEED, DEBUG, ENABLE_TEST_RESET

if (
    not DEBUG
    or not ENABLE_TEST_RESET
    or not ALLOW_INSECURE_SEED
    or not os.environ.get("DJANGO_DB_PATH", "").endswith(".e2e.sqlite3")
):
    raise ImproperlyConfigured(
        "config.settings_e2e requires DEBUG, test reset, insecure seed opt-ins "
        "and an explicit DJANGO_DB_PATH ending in .e2e.sqlite3."
    )

# Exercise real password checks and validators without expensive PBKDF2 work
# for the five throwaway accounts recreated before every browser test.
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
