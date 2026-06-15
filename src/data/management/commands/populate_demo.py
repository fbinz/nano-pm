"""Populate the local DB with realistic demo data for manual exploration.

Creates two PM personas alongside the e2e-fixture `demo` user:

    alice / alice  — startup PM, 4 projects, smaller team, near-term horizon
    bob   / bob    — corporate PM, 5 projects, larger team, multi-quarter horizon

Both are idempotent: running this command again wipes only those users'
projects/people and rebuilds them. The `demo` user (used by the Playwright
suite) is left untouched.
"""

from datetime import date, timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from data.models import (
    Dependency, Membership, Milestone, Person, Project, Task,
    Workspace, WorkspaceRole,
)


class Command(BaseCommand):
    help = "Populate the local DB with realistic demo data for users 'alice' and 'bob'."

    @transaction.atomic
    def handle(self, *args, **opts):
        if not settings.ALLOW_INSECURE_SEED:
            raise CommandError(
                "populate_demo creates users 'alice' and 'bob' with passwords "
                "matching their usernames. Refusing to run because "
                "DJANGO_ALLOW_INSECURE_SEED is not set. Set "
                "DJANGO_ALLOW_INSECURE_SEED=true in dev/CI environments only."
            )
        User = get_user_model()
        today = date.today()

        for username, builder in [("alice", build_alice), ("bob", build_bob)]:
            user, created = User.objects.get_or_create(username=username)
            if created or not user.has_usable_password():
                user.set_password(username)
                user.save()
                self.stdout.write(self.style.SUCCESS(
                    f"Created user '{username}' (password '{username}')."
                ))
            # Wipe this user's data only — leave 'demo' (and any other users) alone.
            Workspace.objects.filter(memberships__user=user).delete()
            ws = Workspace.objects.create(name=f"{username}'s workspace")
            Membership.objects.create(user=user, workspace=ws, role=WorkspaceRole.PM)

            stats = builder(ws, today)
            self.stdout.write(self.style.SUCCESS(
                f"  Populated '{username}': "
                f"{stats['projects']} projects, "
                f"{stats['tasks']} tasks, "
                f"{stats['milestones']} milestones, "
                f"{stats['deps']} dependencies, "
                f"{stats['people']} team members."
            ))


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def _D(today: date, n: int) -> date:
    return today + timedelta(days=n)


def _make_task(project, title, start_offset, duration, assignees, today):
    t = Task.objects.create(
        project=project,
        title=title,
        start=_D(today, start_offset),
        end=_D(today, start_offset + duration),
    )
    if assignees:
        t.assignees.set(assignees)
    return t


# --------------------------------------------------------------------------- #
# Persona: Alice (startup PM)                                                 #
# --------------------------------------------------------------------------- #

def build_alice(ws, today):
    # Team
    maya = Person.objects.create(workspace=ws, name="Maya Patel")
    ravi = Person.objects.create(workspace=ws, name="Ravi Kumar")
    jordan = Person.objects.create(workspace=ws, name="Jordan Reyes")
    olivia = Person.objects.create(workspace=ws, name="Olivia Brandt")

    n_tasks = n_deps = n_ms = 0

    # 1. Mobile App v2
    p1 = Project.objects.create(workspace=ws, name="Mobile App v2", color="#3b82f6", order=1)
    spike = _make_task(p1, "Architectural spike", -45, 14, [maya], today)
    core = _make_task(p1, "Core API rebuild", -30, 25, [ravi, jordan], today)
    ios = _make_task(p1, "iOS UI rebuild", -10, 30, [maya], today)
    android = _make_task(p1, "Android UI rebuild", 0, 35, [olivia], today)
    beta = _make_task(p1, "Beta build + TestFlight", 36, 7, [maya], today)
    release = _make_task(p1, "Public v2 release", 45, 3, [maya], today)
    Milestone.objects.create(project=p1, title="Beta open", date=_D(today, 36))
    Milestone.objects.create(project=p1, title="v2 launch", date=_D(today, 50))
    n_tasks += 6
    n_ms += 2
    Dependency.objects.create(predecessor=spike, successor=core)
    n_deps += 1
    Dependency.objects.create(predecessor=core, successor=ios)
    n_deps += 1
    Dependency.objects.create(predecessor=ios, successor=beta)
    n_deps += 1
    Dependency.objects.create(predecessor=android, successor=beta)
    n_deps += 1
    Dependency.objects.create(predecessor=beta, successor=release)
    n_deps += 1

    # 2. Customer Onboarding
    p2 = Project.objects.create(workspace=ws, name="Customer Onboarding", color="#10b981", order=2)
    research = _make_task(p2, "User research interviews", -75, 20, [olivia], today)
    design = _make_task(p2, "Tutorial v2 design", -50, 18, [olivia, maya], today)
    build = _make_task(p2, "Tutorial v2 build", -28, 21, [maya, ravi], today)
    abtest = _make_task(p2, "A/B test setup", -6, 14, [olivia], today)
    rollout = _make_task(p2, "Onboarding rollout", 9, 5, [olivia], today)
    Milestone.objects.create(project=p2, title="Onboarding GA", date=_D(today, 15))
    n_tasks += 5
    n_ms += 1
    Dependency.objects.create(predecessor=research, successor=design)
    n_deps += 1
    Dependency.objects.create(predecessor=design, successor=build)
    n_deps += 1
    Dependency.objects.create(predecessor=build, successor=abtest)
    n_deps += 1
    Dependency.objects.create(predecessor=abtest, successor=rollout)
    n_deps += 1

    # 3. Pricing Page Redesign
    p3 = Project.objects.create(workspace=ws, name="Pricing Page Redesign", color="#f59e0b", order=3)
    copy = _make_task(p3, "Copy + visual design", 5, 10, [jordan], today)
    impl = _make_task(p3, "Implementation", 16, 8, [ravi], today)
    launch = _make_task(p3, "Launch + analytics", 25, 2, [jordan], today)
    n_tasks += 3
    Dependency.objects.create(predecessor=copy, successor=impl)
    n_deps += 1
    Dependency.objects.create(predecessor=impl, successor=launch)
    n_deps += 1

    # 4. Data Pipeline
    p4 = Project.objects.create(workspace=ws, name="Data Pipeline", color="#8b5cf6", order=4)
    soc2 = _make_task(p4, "SOC2 compliance review", -10, 30, [ravi], today)
    pipeline = _make_task(p4, "Pipeline rewrite", 21, 30, [ravi], today)
    Milestone.objects.create(project=p4, title="Pipeline cutover", date=_D(today, 55))
    n_tasks += 2
    n_ms += 1
    Dependency.objects.create(predecessor=soc2, successor=pipeline)
    n_deps += 1

    # Cross-project: tutorial build feeds into mobile beta
    Dependency.objects.create(predecessor=build, successor=beta)
    n_deps += 1

    return {
        "projects": 4, "tasks": n_tasks, "milestones": n_ms, "deps": n_deps, "people": 4,
    }


# --------------------------------------------------------------------------- #
# Persona: Bob (corporate PM)                                                 #
# --------------------------------------------------------------------------- #

def build_bob(ws, today):
    taylor = Person.objects.create(workspace=ws, name="Taylor Singh")
    lin = Person.objects.create(workspace=ws, name="Lin Hayashi")
    nia = Person.objects.create(workspace=ws, name="Nia Okafor")
    dev = Person.objects.create(workspace=ws, name="Dev Alvarez")
    robin = Person.objects.create(workspace=ws, name="Robin Hartley")
    casey = Person.objects.create(workspace=ws, name="Casey Mensah")

    n_tasks = n_deps = n_ms = 0

    # 1. Q3 Platform Migration
    p1 = Project.objects.create(workspace=ws, name="Q3 Platform Migration", color="#06b6d4", order=1)
    capacity = _make_task(p1, "Capacity planning", -60, 14, [taylor], today)
    schema = _make_task(p1, "Schema migration", -40, 25, [lin, dev], today)
    phase1 = _make_task(p1, "Service migration phase 1", -12, 20, [lin, dev, casey], today)
    phase2 = _make_task(p1, "Service migration phase 2", 10, 25, [lin, dev], today)
    perfval = _make_task(p1, "Performance validation", 38, 14, [taylor], today)
    cutover = _make_task(p1, "Cutover", 55, 5, [taylor, lin], today)
    Milestone.objects.create(project=p1, title="Phase 1 complete", date=_D(today, 10))
    Milestone.objects.create(project=p1, title="Cutover live", date=_D(today, 62))
    n_tasks += 6
    n_ms += 2
    Dependency.objects.create(predecessor=capacity, successor=schema)
    n_deps += 1
    Dependency.objects.create(predecessor=schema, successor=phase1)
    n_deps += 1
    Dependency.objects.create(predecessor=phase1, successor=phase2)
    n_deps += 1
    Dependency.objects.create(predecessor=phase2, successor=perfval)
    n_deps += 1
    Dependency.objects.create(predecessor=perfval, successor=cutover)
    n_deps += 1

    # 2. Compliance Audit
    p2 = Project.objects.create(workspace=ws, name="Compliance Audit", color="#ef4444", order=2)
    prep = _make_task(p2, "Pre-audit prep", -90, 30, [nia], today)
    audit = _make_task(p2, "SOC2 audit window", -55, 21, [nia, robin], today)
    remed = _make_task(p2, "Remediation", -30, 14, [robin], today)
    finalrep = _make_task(p2, "Final report", -12, 7, [nia], today)
    Milestone.objects.create(project=p2, title="Audit closed", date=_D(today, 1))
    n_tasks += 4
    n_ms += 1
    Dependency.objects.create(predecessor=prep, successor=audit)
    n_deps += 1
    Dependency.objects.create(predecessor=audit, successor=remed)
    n_deps += 1
    Dependency.objects.create(predecessor=remed, successor=finalrep)
    n_deps += 1

    # 3. Regional Expansion
    p3 = Project.objects.create(workspace=ws, name="Regional Expansion", color="#84cc16", order=3)
    market = _make_task(p3, "Market research", 15, 28, [casey], today)
    regul = _make_task(p3, "Regulatory review", 25, 35, [nia], today)
    locale = _make_task(p3, "Localisation design", 50, 21, [robin], today)
    pilot = _make_task(p3, "Pilot launch", 80, 14, [casey, robin], today)
    Milestone.objects.create(project=p3, title="Pilot live", date=_D(today, 95))
    n_tasks += 4
    n_ms += 1
    Dependency.objects.create(predecessor=market, successor=regul)
    n_deps += 1
    Dependency.objects.create(predecessor=regul, successor=locale)
    n_deps += 1
    Dependency.objects.create(predecessor=locale, successor=pilot)
    n_deps += 1

    # 4. API v3
    p4 = Project.objects.create(workspace=ws, name="API v3", color="#0ea5e9", order=4)
    spec = _make_task(p4, "Spec drafting", 28, 14, [dev], today)
    refimpl = _make_task(p4, "Reference implementation", 44, 28, [lin, dev], today)
    sdk = _make_task(p4, "SDK rollout", 75, 14, [lin], today)
    pubbeta = _make_task(p4, "Public beta", 95, 7, [lin, dev], today)
    Milestone.objects.create(project=p4, title="API v3 GA", date=_D(today, 110))
    n_tasks += 4
    n_ms += 1
    Dependency.objects.create(predecessor=spec, successor=refimpl)
    n_deps += 1
    Dependency.objects.create(predecessor=refimpl, successor=sdk)
    n_deps += 1
    Dependency.objects.create(predecessor=sdk, successor=pubbeta)
    n_deps += 1

    # 5. Performance Hardening
    p5 = Project.objects.create(workspace=ws, name="Performance Hardening", color="#ec4899", order=5)
    profiling = _make_task(p5, "Profiling sweep", -20, 14, [taylor], today)
    opts = _make_task(p5, "Critical-path opts", -5, 18, [taylor, casey], today)
    caching = _make_task(p5, "Caching layer", 15, 28, [taylor], today)
    n_tasks += 3
    Dependency.objects.create(predecessor=profiling, successor=opts)
    n_deps += 1
    Dependency.objects.create(predecessor=opts, successor=caching)
    n_deps += 1

    # Cross-project: profiling has to land before phase 2
    Dependency.objects.create(predecessor=profiling, successor=phase2)
    n_deps += 1

    return {
        "projects": 5, "tasks": n_tasks, "milestones": n_ms, "deps": n_deps, "people": 6,
    }
