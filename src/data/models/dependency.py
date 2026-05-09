from django.db import models


class Dependency(models.Model):
    """Finish-to-start dependency. predecessor.end + 1 must be <= successor.start."""

    predecessor = models.ForeignKey(
        "data.Task",
        on_delete=models.CASCADE,
        related_name="successor_links",
    )
    successor = models.ForeignKey(
        "data.Task",
        on_delete=models.CASCADE,
        related_name="predecessor_links",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["predecessor", "successor"], name="unique_dep_edge"
            ),
            models.CheckConstraint(
                condition=~models.Q(predecessor=models.F("successor")),
                name="dep_not_self",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.predecessor_id} → {self.successor_id}"
