"""Teams webhook validation and durable, at-least-once outbox delivery."""

import hashlib
import json
import logging
import sqlite3
import time
from datetime import timedelta
from functools import wraps
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import URLValidator
from django.db import OperationalError, close_old_connections, connection, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext as _

from data.models import TeamsDelivery

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 5


def retry_sqlite_contention(operation):
    """Retry a DB-only operation after its transaction has unwound.

    Never decorate network I/O: retrying the result write must not repeat a
    webhook that Teams already accepted. Other database errors remain fatal.
    """
    @wraps(operation)
    def retry(*args, **kwargs):
        delay = 0.25
        while True:
            try:
                return operation(*args, **kwargs)
            except OperationalError as exc:
                cause = exc.__cause__
                code = getattr(cause, "sqlite_errorcode", 0)
                if (
                    not isinstance(cause, sqlite3.OperationalError)
                    or code & 0xFF not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}
                    or connection.in_atomic_block
                ):
                    raise
                # No error/SQL/argument strings: these may contain credentials.
                logger.warning(
                    "Teams worker SQLite contention during %s; retrying in %.2fs",
                    operation.__name__, delay,
                )
                close_old_connections()
                time.sleep(delay)
                delay = min(5.0, delay * 2)
    return retry


@retry_sqlite_contention
def prune_deliveries() -> None:
    # Bound retention, including failed payloads containing descriptions/UPNs.
    TeamsDelivery.objects.filter(created_at__lt=timezone.now() - timedelta(days=30)).delete()


@retry_sqlite_contention
def _record_result(delivery, **values) -> None:
    # A long lock wait might outlast the lease. Don't overwrite a newer claim.
    TeamsDelivery.objects.filter(
        pk=delivery.pk, status=TeamsDelivery.Status.SENDING, locked_until=delivery.locked_until,
    ).update(**values)


@retry_sqlite_contention
def _webhook_url(delivery) -> str:
    return delivery.workspace.teams_webhook_url


def validate_webhook_url(value: str) -> None:
    if not value:
        return
    try:
        URLValidator(schemes=["https", "http"])(value)
        url = urlsplit(value)
        host = (url.hostname or "").lower()
        test_receiver = (
            settings.ENABLE_TEST_RESET and url.scheme == "http"
            and host in {"localhost", "127.0.0.1"}
        )
        trusted_host = host == "outlook.office.com" or any(
            host.endswith(suffix) for suffix in (
                ".webhook.office.com", ".logic.azure.com", ".environment.api.powerplatform.com",
            )
        )
        if (
            len(value) > 2048 or url.username or url.password or url.fragment
            or not (test_receiver or (url.scheme == "https" and trusted_host and url.port in (None, 443)))
        ):
            raise ValueError
    except (ValidationError, ValueError):
        raise ValidationError(_("Use an HTTPS Microsoft Teams or Power Automate webhook URL.")) from None


def destination_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _post_teams_message(webhook_url: str, payload: dict) -> None:
    validate_webhook_url(webhook_url)
    request = Request(
        webhook_url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"}, method="POST",
    )
    # Never follow redirects with the card or log secret URLs / response bodies.
    with build_opener(_NoRedirect).open(request, timeout=3.0) as response:
        if not 200 <= response.status < 300:
            raise ValueError("Unexpected HTTP status")


@retry_sqlite_contention
@transaction.atomic
def _claim() -> TeamsDelivery | None:
    now = timezone.now()
    TeamsDelivery.objects.filter(
        status=TeamsDelivery.Status.SENDING, locked_until__lte=now, attempts__gte=MAX_ATTEMPTS,
    ).update(status=TeamsDelivery.Status.FAILED, last_error="Worker interrupted", locked_until=None)
    delivery = TeamsDelivery.objects.select_for_update().filter(
        Q(status=TeamsDelivery.Status.PENDING, available_at__lte=now)
        | Q(status=TeamsDelivery.Status.SENDING, locked_until__lte=now)
    ).first()
    if delivery is None:
        return None
    delivery.status = TeamsDelivery.Status.SENDING
    delivery.attempts += 1
    delivery.locked_until = now + timedelta(minutes=5)
    delivery.save(update_fields=["status", "attempts", "locked_until"])
    return delivery


def deliver_next() -> bool:
    """Claim one due job, release the DB lock, then do network I/O."""
    delivery = _claim()
    if delivery is None:
        return False
    url = _webhook_url(delivery)
    if not url or destination_hash(url) != delivery.destination_hash:
        _record_result(delivery,
            status=TeamsDelivery.Status.CANCELLED, locked_until=None, payload={},
        )
        return True

    error = ""
    retry = False
    delay = min(3600, 30 * 2 ** min(delivery.attempts - 1, 7))
    try:
        _post_teams_message(url, delivery.payload)
    except HTTPError as exc:
        error = f"HTTP {exc.code}"
        retry = exc.code in {408, 429} or exc.code >= 500
        if exc.code == 429:
            try:
                delay = max(1, min(86400, int(exc.headers.get("Retry-After", delay))))
            except (TypeError, ValueError):
                pass
        exc.close()
    except (URLError, TimeoutError, OSError, HTTPException):
        error, retry = "Network error", True
    except (ValidationError, ValueError):
        error = "Invalid webhook configuration"

    now = timezone.now()
    if error:
        status = (
            TeamsDelivery.Status.PENDING if retry and delivery.attempts < MAX_ATTEMPTS
            else TeamsDelivery.Status.FAILED
        )
        _record_result(delivery,
            status=status, last_error=error, available_at=now + timedelta(seconds=delay),
            locked_until=None,
        )
        logger.warning("Teams delivery %s: %s (%s)", delivery.pk, status, error)
    else:
        _record_result(delivery,
            status=TeamsDelivery.Status.SENT, sent_at=now, last_error="", locked_until=None,
            payload={},  # Do not retain descriptions or UPNs after delivery.
        )
        logger.info("Teams delivery %s accepted", delivery.pk)
    return True
