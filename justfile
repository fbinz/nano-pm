# nano-pm — Django + Datastar Gantt PM tool
#
# Settings read DJANGO_DEBUG / DJANGO_SECRET_KEY / DJANGO_ALLOWED_HOSTS from
# the env. The recipes below set safe dev values; production deploys must set
# their own (see PRODUCTION_READINESS.md).

export DJANGO_DEBUG := "true"
export DJANGO_ALLOWED_HOSTS := "localhost,127.0.0.1"

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
