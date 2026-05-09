import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


# DEBUG defaults to False — production-safe by default. Set DJANGO_DEBUG=true
# in dev (the justfile and Playwright's webServer do this for you).
DEBUG = _env_bool("DJANGO_DEBUG", False)

# SECRET_KEY must come from the environment in production. In DEBUG we fall
# back to an obvious-insecure default so `just run` works out of the box.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or (
    "django-insecure-dev-only-DO-NOT-USE-IN-PROD" if DEBUG else None
)
if not SECRET_KEY:
    raise ImproperlyConfigured(
        "DJANGO_SECRET_KEY is required when DEBUG=False. "
        "Generate one with `python -c \"import secrets; print(secrets.token_urlsafe(50))\"` "
        "and set it in the environment."
    )

# ALLOWED_HOSTS comes from a comma-separated env var. Defaults to localhost
# only — wildcards (`*`) are intentionally NOT supported, even in DEBUG.
ALLOWED_HOSTS = [
    h.strip()
    for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if h.strip()
]

# Test-only data-reset endpoint (`/__reset__/`). Off by default; enabled
# explicitly in CI/local-test environments. Decoupled from DEBUG so a deploy
# that accidentally leaves DEBUG on still doesn't expose a database wipe.
ENABLE_TEST_RESET = _env_bool("DJANGO_ENABLE_TEST_RESET", False)

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django_cotton",
    "data",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR.parent / "db.sqlite3",
    }
}

AUTH_PASSWORD_VALIDATORS = []

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Auth
LOGIN_URL = "/accounts/login/"
LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/accounts/login/"

# Django-Cotton
COTTON_DIR = "components"
COTTON_SNAKE_CASED_NAMES = False
