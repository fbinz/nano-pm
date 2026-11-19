from django.contrib import admin

from data.models import Membership


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("user", "workspace", "role", "created_at")
    list_filter = ("workspace", "role")
    search_fields = ("user__username", "user__email", "workspace__name")
    list_select_related = ("user", "workspace")
    autocomplete_fields = ("user",)
    readonly_fields = ("created_at",)
