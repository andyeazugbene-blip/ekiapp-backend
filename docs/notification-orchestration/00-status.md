# Notification Orchestration Spec v2 — Compliance Status

**Date:** 2026-10-27 (verification completed at 2026-10-27 18:40 UTC)
**Author:** Mouad (with Claude Code assistance)
**Authoritative source:** the client supplied the Google Doc export on 2026-10-26. A byte-for-byte working copy is stored at [`Eki-Notification-Orchestration-Spec-v2.md`](Eki-Notification-Orchestration-Spec-v2.md). The document identifies itself as an implementation draft and says production event mapping and live QA are still required; each R01–R40 entry is proposed, not proof of an implemented backend event.

**Latest verified backend main:** `45b5e1578edc2803aec59d40d59c487f48ec9ff3`, merged 2026-10-27 17:24 UTC. PR #47 is merged; its GitHub test job passed ([40529302921](https://github.com/andyeazugbene-blip/ekiapp-backend/actions/runs/40529302921)), as did Vercel preview and preview comments. Its R13/R15 sweeps now fail closed on main. Current main CI passed ([40550238299](https://github.com/andyeazugbene-blip/ekiapp-backend/actions/runs/40550238299)). Backend has no open PRs at this check. Mobile PR #5 remains open at `72355b0675e0788fc263f977cbc73ba9bdc27708`, based on mobile main `ac1cf5e8e27d71f53fc7abe290219a07fd835a5c`; it is clean/mergeable, has no reviews, Vercel and preview-comment checks pass, and GitHub lists no test job. Clean-checkout typecheck and three repository checks pass; domain checks cannot reach the remote sites in this environment. Source gates remain required for mapped rules pending approvals and runtime/device evidence; effective production gate values were not inspected.

R06 now stops when the existing Stripe Identity session ID shows verification has started; R07/R08 use the real `requires_input`/`verified` webhook paths. The shared schema now carries rule/event/role/entity/task-episode, due/expiry, priority/category, template/variant, candidate lifecycle, preference, and outcome fields. The delivery worker applies role-scoped push consent, preference quiet hours, expiry, and current-state checks. WhatsApp suppression requires a positive receipt for the exact task episode and an explicitly configured cooldown; the default cooldown is zero. Authenticated notification opens record click outcomes; source-backed completion events record direct-task completion. R04 remains blocked from activation. General support coverage uses the existing SUPPORT conversation/Message model. These are source findings; current production values for feature-gate environment settings were not observable in this pass.

**Completion status:** the full specification is not complete. The original 210-event legacy catalogue is still absent; some R01–R40 rules lack authoritative source events, approved timing/policy, or applicable QA. The shared data contract and send-time policy exist, but source-backed producers, provider integrations, sub-daily scheduler cadence, billing policy, and native device QA remain incomplete. Source defaults and PR state do not prove effective production gate values; those were not inspected. See `01-compliance-matrix.md`, `07-test-report.md`, `08-outstanding-decisions.md`, and `11-final-verification-2026-10-27.md`.

## How to read the other files in this directory

- `01-compliance-matrix.md` — all 40 rules (R01–R40), evidence-based status.
- `02-architecture-report.md` — the target pipeline vs. what exists, gap by gap.
- `03-first-sale-report.md` — rule-by-rule audit of the five onboarding rules (R01/R03/R05/R06/R11).
- `04-scheduler-report.md` — actual cron config, achievable cadence, the daily-cron-vs-4h-target gap.
- `05-deeplink-matrix.md` — all 15 destination keys, verified against the actual mobile repo.
- `06-database-report.md` — schema changes made, migration safety, rollback.
- `07-test-report.md` — exact commands run, exact output, nothing fabricated.
- `08-outstanding-decisions.md` — the handful of things only the client can decide.
- `09-mobile-runtime-qa.md` — R40 staging/device QA steps and all semantic destinations.
- `210-event-reconciliation.md` — missing original catalogue evidence, validated blank worksheet, and handoff requirements.
- `11-final-verification-2026-10-27.md` — live repository/PR/CI evidence, current status counts, exact client decisions, and client-ready handoff.
- `12-release-recommendation.md` — release/activation recommendation based on evidence.
- `13-evidence-log.json` — machine-readable commands, SHAs, PR checks, test results, and protected-file hash.

## One-line status per deliverable (full detail in each file)

| # | Deliverable | Status |
|---|---|---|
| 1 | Compliance matrix (R01–R40) | Done this pass — built from direct repo inspection |
| 2 | Architecture report | Updated with shared candidate, preference, delivery, and outcome contract |
| 3 | FIRST_SALE report | Historical report — PR #6 is merged |
| 4 | Scheduler report | Updated — daily Vercel cron plus Actions 401/gaps verified; merged PR #46 fails visibly on transport and non-2xx responses; successful sub-daily execution remains unverified |
| 5 | Deep-link matrix | Done — verified against the actual mobile repo, not assumed |
| 6 | Database report | Existing migrations plus new additive candidate-contract migration |
| 7 | Test report | Updated with current-main focused tests and checks; full suite attempted in this pass (result recorded in final verification report) |
| 8 | Changed-files summary | Backend PRs #38, #39, #41–#47 are merged; no backend PR is open; mobile PR #5 remains open |
| 9 | Outstanding decisions | Updated with scheduler secret verification, WhatsApp provider/cooldown, missing source, R39 billing, and native QA |
| 10 | Release recommendation | See `12-release-recommendation.md`; production deployment and native device QA are not verified; gates remain off. |
| 11 | Final verification | See `11-final-verification-2026-10-27.md` and machine-readable `13-evidence-log.json`. |
