# E2E test-purpose audit — first slow-test pass

## Scope and method

Reviewed the **40 slowest cases** from the measured 302-test, four-worker run
(2 min 17 s wall time). These cases account for 188 s of the run's 528 s of
summed test durations; summed durations are **not** wall time. This is not an
audit of all 302 cases: faster cases were not systematically reviewed. The
related login and placeholder tests were also inspected while tracing overlap.

For each case, check:

- Is there one behavior/failure mode, or unrelated work hidden under one title?
- Do related state transitions actually need to stay in the same test?
- Which other test already exercises its setup, UI, or assertions?
- Can assertions move into an existing scenario without masking a distinct bug?
- Is a delay reproducing a real race, rather than just waiting unnecessarily?

A small test count is not the goal. In particular, do not merge distinct
security boundaries, input paths, or SQLite failure phases simply because their
setup looks similar. Splitting every assertion into another test also repeats
fixture work and makes coherent state-transition regressions harder to express.

## Changes made

### Anonymous browser ownership vs delivery

The old **“anonymous roadmap followers use allowed Teams domains and private
browser-owned subscriptions”** case mixed domain validation, browser ownership,
CSRF, three notification deliveries, recipient deduplication, and login behavior.

It now focuses on **browser ownership, including after login**: following
persists, a repeated follow is idempotent, another browser cannot unsubscribe
it by knowing the address, CSRF remains mandatory, and the owning browser can
still unsubscribe after authenticating.

Coverage moved, not removed:

- Exact-domain rejection (`evilmycompany.com`, `sub.mycompany.com`, and
  `mycompany.com.evil.net`) and domain-list normalization live in **“anonymous
  following works by default and optional domains restrict new mentions”**.
  The real follow endpoint must reject all those addresses. Existing cached-email
  and remember-email tests retain browser validation/error-display coverage.
- Authenticated + anonymous subscriptions sharing one address are tested in the
  existing **direct/task-driven follower delivery** scenario. Its existing
  second delivery now checks this deduplication; no extra worker drain is needed.
  Both subscriptions are removed before its existing no-mention assertion.
- Anonymous-only delivery remains in the optional-domain-policy scenario;
  authenticated-only delivery remains the first direct delivery. This avoids
  one subscription type masking a broken recipient query for the other.

### Actor formatting vs profile editing

The old actor-name case edited and reloaded the profile and started a delivery
worker four times to check a deterministic name-formatting table.

- Full/first-only/last-only/empty/whitespace name cases now live in the existing
  pure `SimpleTestCase` payload suite at
  `src/data/tests/test_teams_payload.py`. Unsaved `User`/`Project` objects are
  sufficient; the test cannot access the database. This is the deterministic
  serialization exception to the usual browser-first testing rule.
- One browser integration still verifies profile → milestone action → queued
  payload → real webhook delivery. It additionally changes the actor's name
  after enqueueing and verifies the delivered card retains the original name.
- Browser username-fallback coverage also remains in the selected-events and
  description-notification cases. Clearing optional first/last names and checking
  persistence after reload now accompanies clearing Teams email in the existing
  profile-edit test, rather than being lost with the removed name-formatting loop.

### Exact duplicates and unrelated preliminaries

- Removed **“Teams notifications skip placeholder milestone creation”** as an
  exact subset of the creation/lifecycle scenario. The retained scenario now
  also enables `milestone.updated` and checks the placeholder title, preserving
  the removed test's unique configuration and assertion.
- Merged three login-form presentation tests into one test of the same initial
  view. Visibility, labels, legend, input classes, fieldset class, and readable
  font size are all retained. Authentication submission/redirect tests remain
  separate.
- Removed destination-validation steps from the pending-delivery cancellation
  test. Its exact error-message assertion now belongs to the existing webhook
  validation/unchanged-connection test. Cancellation now has one purpose.
- The previous-value button test creates its required `40/60/0` estimate once,
  rather than first saving `30/60/10` and editing it. The geometry/language matrix
  still shares that fixture; splitting it into six tests would repeat setup.

### Assertions that were not checking anything

Four workload checks referred to the obsolete `#workload-current` element, which
no longer exists in the app. Replaced them with real `[data-workload-history]`
row counts for unsaved drafts, rejected submissions, and another user's empty
history. The draft test also checks that a successful save creates one row.
The workload screenshot now checks one actual saved history row too.

The existing `src/data/tests/test_teams_contention.py` was also compared with
the slow SQLite cases. It mocks failures and sleep to check classification and
retry boundaries; it does not exercise competing connections or an already
accepted HTTP request. Those fast checks do **not** replace the two real-lock
browser/worker integrations.

## Runtime-ordered review

Times below are from the original four-worker baseline, not post-change serial
measurements. Unless noted, cases are in `e2e/tests/nano-pm.spec.js`.

| Rank | Time | Case | Assessment / decision |
| ---: | ---: | --- | --- |
| 1 | 9.94 s | SQLite contention after HTTP acceptance | **Keep.** Must cross SQLite's busy timeout and prove accepted HTTP is not resent after a persistence conflict. |
| 2 | 9.45 s | SQLite contention before delivery | **Keep separately.** A different failure phase: acquiring work before making the HTTP request. The seven-second lock is intentional. |
| 3 | 8.77 s | Anonymous domains / private subscriptions | **Narrowed.** Browser ownership is independent of delivery and domain-policy matrices; assertion destinations are mapped above. |
| 4 | 6.47 s | Project transfers mention both projects' followers | **Mixed, retained for now.** The union of old/new followers and cross-project deduplication belong together. Trailing changes to shared/empty identities are candidates for a focused recipient-normalization scenario, not more transfer UI. |
| 5 | 6.46 s | Anonymous following and optional-domain restrictions | **Keep the transition.** Unrestricted → restricted → unrestricted proves delivery reevaluates existing subscriptions. Now also owns exact-domain/normalization checks. |
| 6 | 6.08 s | Followers notified by direct and task-driven changes | **Keep integration.** Task propagation and direct edits are distinct producers. Reused the second delivery for cross-type recipient deduplication. |
| 7 | 5.99 s | Workload archival, disabling, and coverage filtering | **Mixed; next-pass candidate.** Team-filter assertions should belong to a focused overview-filter scenario; historical preservation should remain a lifecycle test. Do not confuse archived categories with deleted/moved project references. |
| 8 | 5.83 s | Previous-value buttons | **Targeted, setup reduced.** Geometry, keyboard activation, copied zero, focus, and no implicit submit all describe this control. Avoid six fresh app setups for its viewport/language matrix. |
| 9 | 5.78 s | Actor full/partial/fallback names | **Narrowed.** Pure name matrix + one browser snapshot integration instead of four profile/delivery cycles. |
| 10 | 5.70 s | Worker/server/database isolation | **Keep.** Its second server is the behavior under test, not removable setup. Bidirectional resets must leave the other server's session/data intact. |
| 11 | 5.33 s | Placeholder → real creation → no-op → deletion notification | **Keep coherent lifecycle; duplicate absorbed.** The separate placeholder-only test repeated the first half. |
| 12 | 5.28 s | Webhook configure/replace independent of event settings | **Mixed; next-pass candidate.** Routing to old/new receiver belongs together. Cancel/Escape/focus restoration can move into a dedicated discard-dialog case; do not re-test two receivers there. |
| 13 | 5.21 s | Workload cadence configuration | **Mostly targeted.** Due/not-due transitions require one estimate. Invalid-value/authorization matrices could move into settings-validation coverage; keep real UI cadence persistence and renewal gating. |
| 14 | 5.17 s | Workload history when projects move/delete | **Keep.** Cross-workspace references and deleted FK labels differ from category archival. Initial report creation is necessary, not another form-validation test. |
| 15 | 4.80 s | Average donut / per-user history bars | **Broad component test; keep for now.** Two initial + revised reports prove latest-per-person aggregation, not an average of historical snapshots. Do not remove those initial saves as “duplicate setup”. |
| 16 | 4.54 s | Reminder setting scoped to workspace / manual estimates | **Some overlap.** Cadence retention is also checked by the hide/show test. Keep cross-workspace isolation, manual reporting while off, and re-enable behavior; avoid adding more generic settings-validation cases here. |
| 17 | 4.48 s | Desktop workload screenshot gallery | **Diagnostic gallery, not a focused behavioral test.** Its repeated workflows create specific visual states. Future improvement: split settings vs personal/overview galleries for clearer failures, retaining screenshots/viewport assertions. |
| 18 | 4.44 s | Very small averaged project shares | **Keep.** A 1/3% segment catches rounding/arc-disappearance bugs that the 30.5% average case does not. |
| 19 | 4.42 s | Delivery retry / throttling / no resend | **Keep.** Pending → retry → sent plus payload identity is one retry lifecycle. Do not remove the backoff or final extra drain. |
| 20 | 4.18 s | Mobile workload screenshot gallery | **Keep separate viewport.** Same gallery concern as desktop, but responsive controls have different geometry. It is not redundant with desktop. |
| 21 | 3.98 s | Empty check-in → fresh saved estimate | **Keep.** Persistence/no prefill is different from per-value copying; don't combine it with the previous-value control test. |
| 22 | 3.95 s | Idea CRUD model permissions and PM access | **Mixed; next-pass candidate.** Role/permission matrix, PM bypass, and delete confirmation should be identifiable subcases. Reuse real endpoint setup, but keep an end-to-end permitted CRUD path. |
| 23 | 3.95 s | Category deletion preserves snapshot labels/projects | **Keep lifecycle.** Escaped confirmation text, cancellation, persisted deletion, retained historical references, and a subsequent valid report exercise consequences of the same destructive operation. |
| 24 | 3.93 s | Webhook validation preserves connection | **Keep negative-path integration.** Now also owns the destination error-copy assertion removed from cancellation. Secret redaction and retained receiver are linked to rejecting the replacement. |
| 25 | 3.84 s | Selected milestone notification events | **Keep.** A moved-but-disabled event followed by an enabled update demonstrates filtering, not merely successful card serialization. |
| 26 | 3.66 s | German anonymous-follow mobile screenshot | **Keep viewport/language coverage.** Mobile dialog/menu anchoring differs from desktop. Cookie-attribute assertions could move to ownership coverage later, but cost virtually nothing. |
| 27 | 3.63 s | German anonymous-follow desktop screenshot | **Keep.** Same widget, distinct responsive geometry. Do not replace both with one happy-path follow assertion. |
| 28 | 3.60 s | Remember validated anonymous email | **Keep.** Local-storage validation, remembered next-project follow, and changing address differ from server-side browser ownership. The other context checks local-storage isolation specifically. |
| 29 | 3.56 s | Move reason delivered via editor | **Keep parameterized pair.** Editor submission has a different event/payload path from dragging. |
| 30 | 3.45 s | Workload exempt/foreign references | **Mixed; next-pass candidate.** Trailing immutable-history and fresh-user assertions don't belong under access-control rejection. Fixed ineffective history assertions now; a later split should preserve those unique checks explicitly. |
| 31 | 3.43 s | Move reason delivered via drag | **Keep separately from editor.** Same output does not imply the gesture's commit bridge is covered by the editor case. |
| 32 | 3.43 s | Workspace optional vs milestone-required reasons | **Keep precedence transition.** Required milestone policy must still override disabled optional workspace prompting. |
| 33 | 3.43 s | Profile workload participation and legacy redirects | **Mixed, small opportunity.** Legacy URL routing can be checked alongside profile navigation. Keep exempt-read/write rejection together. Not worth weakening permission coverage to remove one login. |
| 34 | 3.31 s | Destination validation and pending cancellation | **Narrowed.** Now cancellation only; validation message integrated into the existing validation case. |
| 35 | 3.31 s | Self-service subscription and workspace membership | **Keep boundary distinctions.** Authenticated non-members use public-address flow; members can subscribe but cannot configure PM webhook settings. Other profile tests don't prove subscription routing. |
| 36 | 3.26 s | Participation radios validate/edit/permissions | **Keep mutation policy.** Invalid values, foreign identifiers, and non-PM denial protect this endpoint; visual radio interaction alone is insufficient. |
| 37 | 3.14 s | Workload percentage + project breakdown persistence | **Keep core integration.** Browser validation, total/category constraints, and server snapshots interact here. Other donut-preview tests don't prove persistence. |
| 38 | 3.11 s | Production hashed Datastar runtime | **Keep.** Real collectstatic + WhiteNoise + module identity + SSE catches deployment behavior absent from debug-server tests. |
| 39 | 3.09 s | Anonymous subscription token/workspace scope | **Keep.** Foreign token, project transfer, and disabled roadmap invalidate access independently of browser-cookie ownership. |
| 40 | 3.08 s | Workload percentage input readability at 1024 px | **Keep breakpoint matrix.** Personal editor/container sizing differs from the reminder modal; positive width/spinner/overflow checks are not replaced by previous-value button placement. |

## Measurement and next pass

For the first consolidation batch, the same selected behavior set run serially
went from **10 browser tests / 34.9 s** to **7 browser tests / 26.4 s**, including
startup. The pure payload module passes all six tests in about 0.1 s. This is a
controlled subset result, not a claim of a 24% improvement to the entire suite.
The destination/cancellation cleanup and history-assertion fixes were applied
after that subset measurement.

Regression validation: **299 browser tests passed**, plus **9 deterministic
Python tests**. The browser run remained around 2 min 18 s; this pass does not
claim a measurable overall parallel wall-time improvement. Purpose, assertion
quality, and reduced repeated work matter even when scheduling/noise dominate
the complete run.

Next review candidates are ranks 7, 12, 13, 16, 22, 30, and 33 above, followed by
the next 40 measured cases. Use the coverage mapping before removing any more
assertions. In particular, don't hide remaining mixed-purpose tests behind a
large shared helper and label that a refactor.
