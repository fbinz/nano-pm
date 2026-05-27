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

# Seed/demo management commands create accounts with trivial passwords
# (username == password). Off by default — the commands refuse to run unless
# this flag is set. Decoupled from DEBUG so a misconfigured prod deploy can't
# silently materialise `demo/demo` just because DEBUG was left on.
ALLOW_INSECURE_SEED = _env_bool("DJANGO_ALLOW_INSECURE_SEED", False)

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django_cotton",
    "lucide",
    "data",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # Whitenoise serves collected static files in front of the WSGI app — must
    # come right after SecurityMiddleware. In DEBUG, runserver still serves
    # from STATICFILES_DIRS so this is a no-op locally.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "middleware.workspace.WorkspaceMiddleware",
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
            # Make {% lucide %} available without {% load lucide %} in every
            # template — the c-lucide Cotton wrapper renders it on every use.
            "builtins": [
                "lucide.templatetags.lucide",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# Database location. `DJANGO_DB_PATH` overrides for prod (point at a
# persistent volume — e.g. `/data/db.sqlite3` on CapRover). Default keeps the
# repo-root `db.sqlite3` that local dev + e2e use.
#
# SQLite tuning (`OPTIONS`):
#   * journal_mode=WAL     — readers don't block writers; persisted in the
#                            DB file header, so this is set permanently on
#                            first connection and re-asserted on each open.
#   * synchronous=NORMAL   — fsyncs at WAL checkpoints, not every commit.
#                            Durable enough with WAL; FULL is overkill here.
#   * busy_timeout=5000    — wait up to 5s for a lock before raising
#                            SQLITE_BUSY (vs. failing instantly).
#   * temp_store=MEMORY    — sorts/joins use RAM, not /tmp.
#   * mmap_size=128MiB     — memory-map reads for free perf on hot pages.
#   * cache_size=-64000    — 64 MiB page cache (negative = KiB).
#   * transaction_mode=IMMEDIATE (Django 5.1+) — acquire the write lock at
#     BEGIN so concurrent transactions queue cleanly instead of upgrading
#     mid-flight and racing into SQLITE_BUSY.
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.environ.get("DJANGO_DB_PATH") or str(BASE_DIR.parent / "db.sqlite3"),
        "OPTIONS": {
            "init_command": (
                "PRAGMA journal_mode = WAL;"
                "PRAGMA synchronous = NORMAL;"
                "PRAGMA busy_timeout = 5000;"
                "PRAGMA temp_store = MEMORY;"
                "PRAGMA mmap_size = 134217728;"
                "PRAGMA cache_size = -64000;"
            ),
            "transaction_mode": "IMMEDIATE",
        },
    }
}

# Password validators run on form-driven password changes (admin "set
# password", `PasswordChangeView`, etc.). `User.set_password()` — which the
# seed commands and `createsuperuser` use — bypasses them, so enabling these
# is safe for fixture loading. Set DJANGO_DISABLE_PASSWORD_VALIDATORS=true to
# turn them off in environments that need to set trivial passwords through
# forms (rare; usually a smell).
if _env_bool("DJANGO_DISABLE_PASSWORD_VALIDATORS", False):
    AUTH_PASSWORD_VALIDATORS = []
else:
    AUTH_PASSWORD_VALIDATORS = [
        {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
        {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
        {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
        {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
    ]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
# `collectstatic` writes here; whitenoise serves from this dir in prod.
# `DJANGO_STATIC_ROOT` lets the deploy point it at a writable location.
STATIC_ROOT = os.environ.get("DJANGO_STATIC_ROOT") or str(BASE_DIR.parent / "staticfiles")
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --------------------------------------------------------------------------- #
# HTTPS / proxy / cookie hardening                                            #
#                                                                             #
# These all default OFF so dev (HTTP localhost) keeps working. In prod, set:  #
#   DJANGO_BEHIND_TLS_PROXY=true     — CapRover terminates TLS at nginx and   #
#                                      forwards X-Forwarded-Proto.            #
#   DJANGO_SECURE_COOKIES=true       — session + CSRF cookies HTTPS-only.     #
#   DJANGO_SSL_REDIRECT=true         — Django itself sends 301 HTTP→HTTPS.    #
#                                      Usually unnecessary on CapRover (the  #
#                                      proxy already does this); turning it  #
#                                      on without proxy header set will make #
#                                      the app loop.                          #
#   DJANGO_HSTS_SECONDS=<n>          — emit Strict-Transport-Security. Start #
#                                      small (e.g. 3600) and ramp up only    #
#                                      once you're confident in TLS.          #
# --------------------------------------------------------------------------- #
if _env_bool("DJANGO_BEHIND_TLS_PROXY", False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

if _env_bool("DJANGO_SECURE_COOKIES", False):
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

SECURE_SSL_REDIRECT = _env_bool("DJANGO_SSL_REDIRECT", False)

try:
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS", "0"))
except ValueError:
    SECURE_HSTS_SECONDS = 0
if SECURE_HSTS_SECONDS:
    SECURE_HSTS_INCLUDE_SUBDOMAINS = _env_bool("DJANGO_HSTS_INCLUDE_SUBDOMAINS", False)
    SECURE_HSTS_PRELOAD = _env_bool("DJANGO_HSTS_PRELOAD", False)

# Always-on header hardening: no downsides, no env knob needed.
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"

# Auth
LOGIN_URL = "/accounts/login/"
LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/accounts/login/"

# Django-Cotton
COTTON_DIR = "components"
COTTON_SNAKE_CASED_NAMES = False

# --------------------------------------------------------------------------- #
# Sentry — error monitoring. No-op when SENTRY_DSN is unset.                   #
#                                                                             #
# Required env:                                                                #
#   SENTRY_DSN              — DSN from sentry.io project settings.             #
# Optional:                                                                    #
#   SENTRY_ENVIRONMENT      — `prod`, `staging`, etc. Defaults to `unknown`.   #
#   SENTRY_RELEASE          — git SHA or tag for release tracking.             #
#   SENTRY_TRACES_SAMPLE    — fraction (0.0–1.0) of perf-trace sampling.       #
#                              Defaults to 0 (errors only — cheaper).          #
#                                                                             #
# Sensitive data: send_default_pii=False keeps usernames/IPs out of events.    #
# Flip to True only if you've thought about the privacy implications.          #
# --------------------------------------------------------------------------- #
SENTRY_DSN = os.environ.get("SENTRY_DSN", "").strip()
if SENTRY_DSN:
    import sentry_sdk
    from sentry_sdk.integrations.django import DjangoIntegration

    try:
        _traces_rate = float(os.environ.get("SENTRY_TRACES_SAMPLE", "0"))
    except ValueError:
        _traces_rate = 0.0

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        integrations=[DjangoIntegration()],
        environment=os.environ.get("SENTRY_ENVIRONMENT", "unknown"),
        release=os.environ.get("SENTRY_RELEASE") or None,
        traces_sample_rate=_traces_rate,
        send_default_pii=False,
    )
