from django.urls import path

from . import oauth

app_name = "django_mcpz_oauth"
urlpatterns = [
    path("authorize", oauth.authorize, name="authorize"),
    path("token", oauth.token, name="token"),
    path("register", oauth.register, name="register"),
    path("revoke", oauth.revoke, name="revoke"),
]
