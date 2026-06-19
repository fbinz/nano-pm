from django.db import models


class Workspace(models.Model):
    name = models.CharField(max_length=200)
    public_roadmap_enabled = models.BooleanField(default=False)
    public_roadmap_token = models.SlugField(max_length=50, unique=True, null=True, blank=True)
    public_roadmap_title = models.CharField(max_length=200, blank=True, default="")
    public_roadmap_description = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return self.name

    @property
    def public_roadmap_display_title(self) -> str:
        return self.public_roadmap_title.strip() or f"{self.name} Roadmap"
