"""Seed example data for nano-pm.

Creates a 'demo' user (password 'demo') with a workspace containing 3 projects,
3 people, 3 teams, 8 tasks (with multi-assignee + date-derived statuses),
6 dependencies (incl. one cross-project), and 2 milestones — all dated relative to today.

Also creates a second user 'pm2' (password 'pm2') with an empty workspace,
for multi-tenancy testing.
"""

from datetime import date, timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from data.models import (
    Workspace, Membership, WorkspaceRole,
    Project, Team, Person, Task, Dependency, Milestone,
)


class Command(BaseCommand):
    help = "Seed example data under user 'demo' (password 'demo')."

    @transaction.atomic
    def handle(self, *args, **options):
        if not settings.ALLOW_INSECURE_SEED:
            raise CommandError(
                "seed_data creates user 'demo' with password 'demo'. Refusing "
                "to run because DJANGO_ALLOW_INSECURE_SEED is not set. Set "
                "DJANGO_ALLOW_INSECURE_SEED=true in dev/CI environments only."
            )
        User = get_user_model()

        # Wipe all non-superuser accounts for a clean slate
        User.objects.filter(is_superuser=False).delete()
        Workspace.objects.all().delete()

        # --- demo user + workspace ---
        user, created = User.objects.get_or_create(username="demo")
        if created or not user.has_usable_password():
            user.set_password("demo")
            user.save()
            self.stdout.write(self.style.SUCCESS("Created user 'demo' (password 'demo')."))

        # Wipe existing demo data for idempotency
        Workspace.objects.filter(memberships__user=user).delete()

        ws = Workspace.objects.create(name="demo's workspace")
        Membership.objects.create(user=user, workspace=ws, role=WorkspaceRole.PM)

        today = date.today()

        def D(offset: int) -> date:
            return today + timedelta(days=offset)

        backend = Team.objects.create(workspace=ws, name="Backend")
        design = Team.objects.create(workspace=ws, name="Design")
        infra = Team.objects.create(workspace=ws, name="Infrastructure")

        alex = Person.objects.create(workspace=ws, name="Alex Chen")
        alex.teams.set([backend, infra])
        sam = Person.objects.create(workspace=ws, name="Sam Patel")
        sam.teams.set([backend])
        riley = Person.objects.create(workspace=ws, name="Riley Wong")
        riley.teams.set([design, infra])

        p1 = Project.objects.create(workspace=ws, name="API Migration", color="#3b82f6", order=1)
        p2 = Project.objects.create(workspace=ws, name="Onboarding revamp", color="#10b981", order=2)
        p3 = Project.objects.create(workspace=ws, name="Infra hardening", color="#f59e0b", order=3)

        # Project 1: API Migration
        t1 = Task.objects.create(
            project=p1, title="Spike on auth changes",
            start=D(-12), end=D(-3),
        )
        t1.assignees.set([alex])
        t2 = Task.objects.create(
            project=p1, title="Migrate /users endpoints",
            start=D(-1), end=D(10),
        )
        t2.assignees.set([alex, sam])
        t3 = Task.objects.create(
            project=p1, title="Cutover and deprecation",
            start=D(11), end=D(20),
        )
        t3.assignees.set([sam])
        Milestone.objects.create(project=p1, title="v2 API beta", date=D(22))

        # Project 2: Onboarding revamp
        t4 = Task.objects.create(
            project=p2, title="User research interviews",
            start=D(-7), end=D(2),
        )
        t4.assignees.set([riley])
        t5 = Task.objects.create(
            project=p2, title="Tutorial flow v2",
            start=D(3), end=D(18),
        )
        t5.assignees.set([riley, sam])
        t6 = Task.objects.create(
            project=p2, title="A/B test setup",
            start=D(19), end=D(26),
        )
        t6.assignees.set([riley])
        Milestone.objects.create(project=p2, title="Soft launch", date=D(28))

        # Project 3: Infra hardening
        t7 = Task.objects.create(
            project=p3, title="Audit IAM policies",
            start=D(-4), end=D(4),
        )
        t7.assignees.set([alex])
        t8 = Task.objects.create(
            project=p3, title="Terraform module rewrites",
            start=D(5), end=D(16),
        )
        t8.assignees.set([alex, riley])

        # Dependencies (incl. one cross-project: t1 → t5)
        Dependency.objects.create(predecessor=t1, successor=t2)
        Dependency.objects.create(predecessor=t2, successor=t3)
        Dependency.objects.create(predecessor=t4, successor=t5)
        Dependency.objects.create(predecessor=t5, successor=t6)
        Dependency.objects.create(predecessor=t7, successor=t8)
        Dependency.objects.create(predecessor=t1, successor=t5)

        # --- member1 user linked to Alex Chen ---
        member1, created = User.objects.get_or_create(username="member1")
        if created or not member1.has_usable_password():
            member1.set_password("member1")
            member1.save()
        Membership.objects.create(user=member1, workspace=ws, role=WorkspaceRole.MEMBER)
        alex.user = member1
        alex.save()

        self.stdout.write(self.style.SUCCESS(
            "Seeded 3 projects, 3 people, 3 teams, 8 tasks, 2 milestones, 6 deps for user 'demo'."
        ))

        # --- pm2 user + empty workspace (for isolation tests) ---
        pm2, created = User.objects.get_or_create(username="pm2")
        if created or not pm2.has_usable_password():
            pm2.set_password("pm2")
            pm2.save()
        Workspace.objects.filter(memberships__user=pm2).delete()
        ws2 = Workspace.objects.create(name="pm2's workspace")
        Membership.objects.create(user=pm2, workspace=ws2, role=WorkspaceRole.PM)

        self.stdout.write(self.style.SUCCESS("Seeded empty workspace for user 'pm2'."))

        # --- multi1 user: member of both workspaces (for switcher tests) ---
        multi1, created = User.objects.get_or_create(username="multi1")
        if created or not multi1.has_usable_password():
            multi1.set_password("multi1")
            multi1.save()
        Membership.objects.filter(user=multi1).delete()
        Membership.objects.create(user=multi1, workspace=ws, role=WorkspaceRole.MEMBER)
        Membership.objects.create(user=multi1, workspace=ws2, role=WorkspaceRole.MEMBER)
