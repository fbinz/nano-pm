"""Safe Markdown rendering for project journal entries and replies."""

import mistune
from django import template
from django.utils.safestring import mark_safe

register = template.Library()

_render = mistune.create_markdown(
    escape=True,
    hard_wrap=True,
    plugins=["url", "strikethrough"],
)


@register.filter
def journal_markdown(value):
    # Raw HTML is escaped and Mistune sanitizes link/image URL schemes.
    return mark_safe(_render(str(value or "")))
