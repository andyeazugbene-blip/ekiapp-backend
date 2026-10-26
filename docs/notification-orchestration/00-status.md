# Notification Orchestration Spec v2 — Compliance Status

**Date:** 2026-10-26
**Author:** Mouad (with Claude Code assistance)
**Authoritative source:** the client supplied the Google Doc export on 2026-10-26. A byte-for-byte working copy is stored at [`Eki-Notification-Orchestration-Spec-v2.md`](Eki-Notification-Orchestration-Spec-v2.md). The document identifies itself as an implementation draft and says production event mapping and live QA are still required; each R01–R40 entry is proposed, not proof of an implemented backend event.

**Latest work:** R28 now covers both Community Buy cases and general Eki Support threads. General replies flow through a transactional v1 outbox event, exact-copy idempotent notification candidate, send-time thread/recipient/read checks, bounded push retry, CommunicationLog, and Expo receipt outcomes; mobile uses the v2 `support_case` destination with authenticated role routing. R04 remains fail-closed. Backend focused tests/build and mobile typecheck pass; native device QA is not evidenced. Backend PR #23 (outbox producer/consumer) and stacked PR #24 (durable push delivery) are open; mobile PR #5 is open. Backend PR #21 and #22 were both merged externally; current backend `main` is `3019527c784beccbd8ccd8938c75d9b72110d433`. The existing uncommitted `android/app/src/main/AndroidManifest.xml` change remains untouched.

R06 now stops when the existing Stripe Identity session ID shows verification has started; R07/R08 were verified against the real `requires_input`/`verified` webhook paths and tests. R04's existing `Product.DRAFT` state and exact copy are implemented but remain disabled. General support coverage uses the existing SUPPORT conversation/Message model; the handler only targets an authenticated thread participant and suppresses notifications for internal, read, or closed-thread replies.

**Completion status:** the full specification is not complete. The original 210-event legacy catalogue is still absent; most R01–R40 rules still need implementation/mapping work and applicable QA. R28 is the first end-to-end rule path on the shared outbox/candidate/delivery architecture; other rules have not yet been migrated through it. Sub-daily scheduling, WhatsApp coordination, unverified policies/signals, and native device QA remain outstanding. See `07-test-report.md` and `08-outstanding-decisions.md`.

## How to read the other files in this directory

- `01-compliance-matrix.md` — all 40 rules (R01–R40), evidence-based status.
- `02-architecture-report.md` — the target pipeline vs. what exists, gap by gap.
- `03-first-sale-report.md` — rule-by-rule audit of the five onboarding rules (R01/R03/R05/R06/R11).
- `04-scheduler-report.md` — actual cron config, achievable cadence, the daily-cron-vs-4h-target gap.
- `05-deeplink-matrix.md` — all 15 destination keys, verified against the actual mobile repo.
- `06-database-report.md` — schema changes made, migration safety, rollback.
- `07-test-report.md` — exact commands run, exact output, nothing fabricated.
- `08-outstanding-decisions.md` — the handful of things only the client can decide.

## One-line status per deliverable (full detail in each file)

| # | Deliverable | Status |
|---|---|---|
| 1 | Compliance matrix (R01–R40) | Done this pass — built from direct repo inspection |
| 2 | Architecture report | Done — matches the ADR already shared with the client |
| 3 | FIRST_SALE report | Historical report — PR #6 is merged |
| 4 | Scheduler report | Done — daily cron confirmed, 4h claim corrected |
| 5 | Deep-link matrix | Done — verified against the actual mobile repo, not assumed |
| 6 | Database report | Done — two additive migrations, rollback documented |
| 7 | Test report | Updated with actual 2026-10-26 commands; full HTTP suite is sandbox-blocked |
| 8 | Changed-files summary | Backend commit `f9dcce9`; mobile commit `ff87a48` (local branch only) |
| 9 | Outstanding decisions | Done — 4 real decisions, not 40 |
| 10 | Release recommendation | R10 backend update is on open PR #8. Mobile change is committed locally but awaits trusted authorization to push. No production deployment or merge was performed. |
