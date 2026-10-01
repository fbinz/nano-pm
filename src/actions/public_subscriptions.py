"""Domain policy for self-declared public Teams followers (not identity verification)."""

import re

from django.core.exceptions import ValidationError
from django.core.validators import DomainNameValidator, validate_email
from django.utils.translation import gettext_lazy as _


def normalize_domain(value: str) -> str:
    try:
        domain = value.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise ValidationError(_("Enter domain names such as mycompany.com, without URLs, @ signs or wildcards.")) from None
    DomainNameValidator(accept_idna=False)(domain)
    return domain


def normalize_domains(value: str) -> list[str]:
    domains = sorted({normalize_domain(part) for part in re.split(r"[,\s]+", value.strip()) if part})
    if len(domains) > 20:
        raise ValidationError(_("Enter no more than 20 domains."))
    return domains


def public_email_allowed(address: str, domains: list[str]) -> bool:
    # Exact match only: subdomains must be explicitly listed too.
    return not domains or address.rpartition("@")[2].lower() in domains


def validate_public_email(value: str, domains: list[str]) -> str:
    address = value.strip().lower()
    validate_email(address)
    if any(char in address for char in '<>&"'):
        raise ValidationError(_("Enter a valid Microsoft sign-in address."))
    local, domain = address.rsplit("@", 1)
    address = f"{local}@{normalize_domain(domain)}"
    if len(address) > 254 or not public_email_allowed(address, domains):
        raise ValidationError(_("Use a Teams email address from an allowed domain."))
    return address
