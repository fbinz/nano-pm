from django.db import models


class TaskOrder(models.Model):
    """A task's user-defined position within one column of one board grouping.

    Order only has meaning inside a single column of a particular grouping, so
    it's keyed by (dimension, group_key, task) rather than stored on the task:

      - `dimension` — how the board is grouped, e.g. "status" (today) or
        "assignee"/"project" (future views).
      - `group_key` — which column within that grouping, e.g. "in-progress",
        or a person/project id as a string.
      - `rank` — a lexicographic fractional index (see actions.lexorank); rows
        in a column sort by plain string comparison on this field.

    Because the key includes the column, a single task can hold independent
    ranks in different views — and, where a grouping is many-to-many (a task
    with several assignees shows in several columns), a distinct rank per
    column. Rows cascade-delete with their task.
    """

    task = models.ForeignKey(
        "data.Task",
        on_delete=models.CASCADE,
        related_name="orderings",
    )
    dimension = models.CharField(max_length=20)
    group_key = models.CharField(max_length=64)
    rank = models.CharField(max_length=128)

    class Meta:
        unique_together = ("task", "dimension", "group_key")
        indexes = [models.Index(fields=["dimension", "group_key", "rank"])]

    def __str__(self) -> str:
        return f"{self.dimension}/{self.group_key}: task {self.task_id} @ {self.rank}"
