"""Seed example data for nano-pm. Mirrors the demo dataset from legacy/nano-pm.html.

Creates a 'demo' user (password 'demo') if missing, then 3 projects, 3 people,
8 tasks (with multi-assignee + every status), 6 dependencies (incl. one
cross-project), and 2 milestones — all dated relative to today.
"""

from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from data.models import Project, Person, Task, TaskStatus, Dependency, Milestone


class Command(BaseCommand):
    help = "Seed example data under user 'demo' (password 'demo')."

    @transaction.atomic
    def handle(self, *args, **options):
        User = get_user_model()
        user, created = User.objects.get_or_create(username="demo")
        if created or not user.has_usable_password():
            user.set_password("demo")
            user.save()
            self.stdout.write(self.style.SUCCESS("Created user 'demo' (password 'demo')."))

        # Wipe existing demo data for idempotency
        Project.objects.filter(owner=user).delete()
        Person.objects.filter(owner=user).delete()

        today = date.today()

        def D(offset: int) -> date:
            return today + timedelta(days=offset)

        alex = Person.objects.create(owner=user, name="Alex Chen")
        sam = Person.objects.create(owner=user, name="Sam Patel")
        riley = Person.objects.create(owner=user, name="Riley Wong")

        p1 = Project.objects.create(owner=user, name="API Migration", color="#3b82f6", order=1)
        p2 = Project.objects.create(owner=user, name="Onboarding revamp", color="#10b981", order=2)
        p3 = Project.objects.create(owner=user, name="Infra hardening", color="#f59e0b", order=3)

        # Project 1: API Migration
        t1 = Task.objects.create(
            project=p1, title="Spike on auth changes",
            start=D(-12), end=D(-3), status=TaskStatus.DONE,
        )
        t1.assignees.set([alex])
        t2 = Task.objects.create(
            project=p1, title="Migrate /users endpoints",
            start=D(-1), end=D(10), status=TaskStatus.IN_PROGRESS,
        )
        t2.assignees.set([alex, sam])
        t3 = Task.objects.create(
            project=p1, title="Cutover and deprecation",
            start=D(11), end=D(20), status=TaskStatus.PLANNED,
        )
        t3.assignees.set([sam])
        Milestone.objects.create(project=p1, title="v2 API beta", date=D(22))

        # Project 2: Onboarding revamp
        t4 = Task.objects.create(
            project=p2, title="User research interviews",
            start=D(-7), end=D(2), status=TaskStatus.IN_PROGRESS,
        )
        t4.assignees.set([riley])
        t5 = Task.objects.create(
            project=p2, title="Tutorial flow v2",
            start=D(3), end=D(18), status=TaskStatus.PLANNED,
        )
        t5.assignees.set([riley, sam])
        t6 = Task.objects.create(
            project=p2, title="A/B test setup",
            start=D(19), end=D(26), status=TaskStatus.PLANNED,
        )
        t6.assignees.set([riley])
        Milestone.objects.create(project=p2, title="Soft launch", date=D(28))

        # Project 3: Infra hardening
        t7 = Task.objects.create(
            project=p3, title="Audit IAM policies",
            start=D(-4), end=D(4), status=TaskStatus.BLOCKED,
        )
        t7.assignees.set([alex])
        t8 = Task.objects.create(
            project=p3, title="Terraform module rewrites",
            start=D(5), end=D(16), status=TaskStatus.PLANNED,
        )
        t8.assignees.set([alex, riley])

        # Dependencies (incl. one cross-project: t1 → t5)
        Dependency.objects.create(predecessor=t1, successor=t2)
        Dependency.objects.create(predecessor=t2, successor=t3)
        Dependency.objects.create(predecessor=t4, successor=t5)
        Dependency.objects.create(predecessor=t5, successor=t6)
        Dependency.objects.create(predecessor=t7, successor=t8)
        Dependency.objects.create(predecessor=t1, successor=t5)

        self.stdout.write(self.style.SUCCESS(
            f"Seeded 3 projects, 3 people, 8 tasks, 2 milestones, 6 deps for user 'demo'."
        ))
