# nano-pm production image — used by CapRover (see captain-definition).
#
# Written for the classic Docker builder (CapRover default). No BuildKit-only
# features: no `RUN --mount=type=cache`, no syntax pragma. If you switch to
# BuildKit you'll get a free uv-cache speedup by adding the mounts back.
#
# Two stages:
#   1. builder  — installs deps with uv into a relocatable venv at /opt/venv.
#   2. runtime  — copies the venv + source, runs collectstatic at build time,
#                 starts gunicorn at container start.
#
# Required env at runtime (provide via CapRover "App Configs" → "Environmental
# Variables"):
#
#   DJANGO_SECRET_KEY        — long random string. REQUIRED.
#   DJANGO_ALLOWED_HOSTS     — comma-separated, e.g. `nano-pm.example.com`.
#                              REQUIRED.
#   DJANGO_BEHIND_TLS_PROXY  — `true`. CapRover terminates TLS at nginx and
#                              forwards X-Forwarded-Proto.
#   DJANGO_SECURE_COOKIES    — `true` once the domain is HTTPS-only.
#   DJANGO_HSTS_SECONDS      — start small (e.g. 3600); ramp up only when
#                              you're confident the cert won't lapse.
#
# Persistent state: SQLite lives at /data/db.sqlite3 (DJANGO_DB_PATH).
# CapRover users MUST attach a persistent directory to /data via "App Configs"
# → "Persistent Directories" before the first deploy — otherwise the DB lives
# in the writable container layer and is wiped on every redeploy.

# --------------------------------------------------------------------------- #
# Builder                                                                      #
# --------------------------------------------------------------------------- #
FROM python:3.12-slim-bookworm AS builder

# Pin uv via the official distroless image — single static binary, no apt.
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /usr/local/bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /app

# Install deps first (better layer caching: deps change less often than code).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY src ./src
RUN uv sync --frozen --no-dev

# --------------------------------------------------------------------------- #
# Runtime                                                                      #
# --------------------------------------------------------------------------- #
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    DJANGO_SETTINGS_MODULE=config.settings \
    DJANGO_DB_PATH=/data/db.sqlite3 \
    PORT=80

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY src ./src

# Pre-bake static assets so the image ships ready-to-serve. DJANGO_DEBUG=true
# lets settings.py accept the throwaway SECRET_KEY; neither value is used by
# collectstatic itself.
RUN DJANGO_DEBUG=true DJANGO_SECRET_KEY=collectstatic-only \
    python src/manage.py collectstatic --noinput --clear

# Persistent volume mount-point. CapRover bind-mounts the host dir here.
RUN mkdir -p /data
VOLUME /data

EXPOSE 80

# Migrate every start (idempotent; fast when up-to-date), then exec gunicorn.
# 2 workers × 4 threads is sized for a small SQLite app — bump only when the
# DB stops being the bottleneck (i.e. after switching off SQLite).
CMD ["sh", "-c", "python src/manage.py migrate --noinput && exec gunicorn config.wsgi:application --chdir src --bind 0.0.0.0:${PORT} --workers 2 --threads 4 --access-logfile - --error-logfile -"]
