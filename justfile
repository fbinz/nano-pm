# nano-pm — Django + Datastar Gantt PM tool
#
# Settings read DJANGO_DEBUG / DJANGO_SECRET_KEY / DJANGO_ALLOWED_HOSTS from
# the env. The recipes below set safe dev values; production deploys must set
# their own (see PRODUCTION_READINESS.md).

export DJANGO_DEBUG := "true"
export DJANGO_ALLOWED_HOSTS := "localhost,127.0.0.1"
# Lets `seed` / `populate` / `reset` materialise dev users with trivial
# passwords (demo/demo, alice/alice, bob/bob). MUST stay unset in production.
export DJANGO_ALLOW_INSECURE_SEED := "true"

# Run the development server (optionally specify port, default 8000)
run port="8000":
    cd src && uv run python manage.py runserver {{port}}

# Run migrations
migrate:
    cd src && uv run python manage.py migrate

# Make migrations
makemigrations:
    cd src && uv run python manage.py makemigrations

# Create a superuser
createsuperuser:
    cd src && uv run python manage.py createsuperuser

# Seed example data (under the default 'demo' user; password 'demo')
seed:
    cd src && uv run python manage.py seed_data

# Populate the local DB with realistic demo data for users 'alice' and 'bob'
populate:
    cd src && uv run python manage.py populate_demo

# Reset database and start fresh
reset:
    rm -f db.sqlite3
    cd src && uv run python manage.py migrate
    cd src && uv run python manage.py seed_data

# Run the Django test suite
test:
    cd src && uv run python manage.py test

# Run the Playwright end-to-end suite
e2e *args:
    cd e2e && npx playwright test {{args}}

# Fetch the Tailwind v4 standalone CLI + DaisyUI plugin into bin/.
# Idempotent: skip-if-exists, run again to upgrade.
css-deps:
    mkdir -p bin
    [ -x bin/tailwindcss ] || curl -fsSL -o bin/tailwindcss https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-linux-x64
    chmod +x bin/tailwindcss
    [ -f bin/daisyui.js ] || curl -fsSL -o bin/daisyui.js https://github.com/saadeghi/daisyui/releases/latest/download/daisyui.js
    [ -f bin/daisyui-theme.js ] || curl -fsSL -o bin/daisyui-theme.js https://github.com/saadeghi/daisyui/releases/latest/download/daisyui-theme.js

# Build src/static/css/app.css from src/css/input.css (minified).
# Source lives outside src/static/ so whitenoise's collectstatic doesn't
# try to parse it as a deliverable CSS file.
css: css-deps
    ./bin/tailwindcss -i src/css/input.css -o src/static/css/app.css --minify

# Watch input.css and rebuild on change.
css-watch: css-deps
    ./bin/tailwindcss -i src/css/input.css -o src/static/css/app.css --watch
