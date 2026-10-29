"""Read-only, origin-bound GitLab API client. Never log credentials or bodies."""

import http.client
import ipaddress
import json
import socket
import ssl
from urllib.parse import urlencode, urlsplit

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import URLValidator
from django.views.decorators.debug import sensitive_variables
from django.utils.translation import gettext_lazy as _


class GitLabError(Exception):
    def __init__(self, code, retry_after=0):
        self.code = code
        self.retry_after = retry_after
        super().__init__(code)


def cipher():
    key = getattr(settings, "GITLAB_ENCRYPTION_KEY", "")
    try:
        return Fernet(key)
    except (ValueError, TypeError):
        raise ValidationError(_("Configure DJANGO_GITLAB_ENCRYPTION_KEY before connecting GitLab.")) from None


@sensitive_variables("token")
def encrypt_token(token):
    return cipher().encrypt(token.encode()).decode()


def decrypt_token(value):
    try:
        return cipher().decrypt(value.encode()).decode()
    except (InvalidToken, ValidationError, ValueError):
        raise GitLabError("credential-unavailable") from None


def validate_origin(value):
    try:
        URLValidator(schemes=["https", "http"])(value.strip())
        parsed = urlsplit(value.strip())
    except (ValueError, ValidationError):
        raise ValidationError(_("Enter a valid GitLab origin.")) from None
    test_local = settings.ENABLE_TEST_RESET and parsed.hostname in ("127.0.0.1", "localhost")
    if (
        not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
        or parsed.path not in ("", "/")
        or parsed.scheme != "https" and not (test_local and parsed.scheme == "http")
    ):
        raise ValidationError(_("Enter an HTTPS GitLab origin without a path or credentials."))
    try:
        port = parsed.port
    except ValueError:
        raise ValidationError(_("Enter a valid GitLab port.")) from None
    if port is not None and not 1 <= port <= 65535:
        raise ValidationError(_("Enter a valid GitLab port."))
    host = parsed.hostname.encode("idna").decode().lower()
    authority = f"[{host}]" if ":" in host else host
    if port and port != (443 if parsed.scheme == "https" else 80):
        authority += f":{port}"
    return f"{parsed.scheme}://{authority}"


def issue_url(origin, source):
    # API web_url normally contains the namespace path. Accept only same-origin
    # links, otherwise use GitLab's numeric-project redirect.
    fallback = f"{origin}/-/project/{source['project_id']}/issues/{source['iid']}"
    try:
        parsed = urlsplit(source.get("web_url", ""))
        if parsed.username or parsed.password or not parsed.path.startswith("/"):
            return fallback
        if validate_origin(f"{parsed.scheme}://{parsed.netloc}") == origin:
            return parsed._replace(fragment="").geturl()
    except (ValueError, TypeError, ValidationError):
        pass
    return fallback


def addresses(origin):
    parsed = urlsplit(origin)
    allowed_private = parsed.hostname in getattr(settings, "GITLAB_PRIVATE_HOSTS", [])
    test_local = settings.ENABLE_TEST_RESET and parsed.hostname in ("localhost", "127.0.0.1")
    try:
        results = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80),
                                     type=socket.SOCK_STREAM)
        ips = list(dict.fromkeys(item[4][0] for item in results))
        if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips) and not (allowed_private or test_local):
            raise GitLabError("address-not-allowed")
        return ips
    except OSError:
        raise GitLabError("connection-failed") from None


class Client:
    def __init__(self, connection, heartbeat=lambda: None):
        try:
            self.origin = validate_origin(connection.instance_url)
        except ValidationError:
            raise GitLabError("invalid-origin") from None
        self.token = decrypt_token(connection.token_ciphertext)
        self.heartbeat = heartbeat

    def get(self, path, **query):
        self.heartbeat()
        parsed = urlsplit(self.origin)
        ips = addresses(self.origin)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        kwargs = {"context": ssl.create_default_context()} if parsed.scheme == "https" else {}
        connection = cls(parsed.hostname, port=port, timeout=20, **kwargs)
        # Pin the validated address; preserve the hostname for TLS SNI and Host.
        # No proxy environment, redirect following, or second DNS lookup.
        connection._create_connection = lambda address, timeout, source_address=None: socket.create_connection(
            (ips[0], port), timeout, source_address,
        )
        try:
            connection.request("GET", "/api/v4" + path + ("?" + urlencode(query) if query else ""),
                               headers={"PRIVATE-TOKEN": self.token, "Accept": "application/json"})
            response = connection.getresponse()
            status = response.status
            if status != 200:
                code = {401: "authentication-failed", 403: "access-denied", 404: "not-found",
                        429: "rate-limited"}.get(status, "server-error" if status >= 500 else "request-failed")
                retry = response.getheader("Retry-After", "")
                raise GitLabError(code, min(int(retry), 86400) if retry.isdigit() else 0)
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise GitLabError("response-too-large")
            data = json.loads(body)
            return data, response.getheader("X-Next-Page", "")
        except (OSError, http.client.HTTPException):
            raise GitLabError("connection-failed") from None
        except (ValueError, UnicodeError):
            raise GitLabError("invalid-response") from None
        finally:
            connection.close()

    def pages(self, path, **query):
        page = 1
        for _page_number in range(10000):
            data, next_page = self.get(path, **query, per_page=100, page=page)
            if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
                raise GitLabError("invalid-response")
            yield from data
            if not next_page:
                return
            if not next_page.isdigit() or int(next_page) <= page:
                raise GitLabError("invalid-pagination")
            page = int(next_page)
        raise GitLabError("pagination-limit")
