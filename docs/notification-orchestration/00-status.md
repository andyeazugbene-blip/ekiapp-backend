# Notification Orchestration Spec v2 — Compliance Status

**Date:** 2026-10-27
**Author:** Mouad (with Claude Code assistance)
**Authoritative source:** the client supplied the Google Doc export on 2026-10-26. A byte-for-byte working copy is stored at [`Eki-Notification-Orchestration-Spec-v2.md`](Eki-Notification-Orchestration-Spec-v2.md). The document identifies itself as an implementation draft and says production event mapping and live QA are still required; each R01–R40 entry is proposed, not proof of an implemented backend event.

**Latest work:** Backend PRs #38 (R07–R09 activation alerts), #39 (R12/R21/R22 order alerts), #41 (shared candidate/preference/outcome contract), #42 (status documentation), and #43 (R30/R24) are merged into `main` at `c979a5a`. CI for #43 identified a missing `dispatchDueVendorTrialEnding` mock in the automation-detector suite; the follow-up review corrects that test double, adds shared-policy/outcome regression coverage, and is not merged. All new gates remain off pending runtime/device QA.

R06 now stops when the existing Stripe Identity session ID shows verification has started; R07/R08 use the real `requires_input`/`verified` webhook paths. The shared schema now carries rule/event/role/entity/task-episode, due/expiry, priority/category, template/variant, candidate lifecycle, preference, and outcome fields. The delivery worker applies role-scoped push consent, preference quiet hours, WhatsApp episode suppression when an eligible delivered log exists, expiry, and current-state checks. Authenticated notification opens record click outcomes; source-backed completion events record direct-task completion. R04 remains disabled. General support coverage uses the existing SUPPORT conversation/Message model.

**Completion status:** the full specification is not complete. The original 210-event legacy catalogue is still absent; many R01–R40 rules need reviewed event mappings and applicable QA. The shared data contract and send-time policy are implemented, but source-backed producers, provider integrations, sub-daily scheduler cadence, billing policy, and native device QA remain incomplete. Feature gates stay disabled where route/runtime or business evidence is outstanding. See `01-compliance-matrix.md`, `07-test-report.md`, and `08-outstanding-decisions.md`.

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
| 2 | Architecture report | Updated with shared candidate, preference, delivery, and outcome contract |
| 3 | FIRST_SALE report | Historical report — PR #6 is merged |
| 4 | Scheduler report | Done — daily cron confirmed, 4h claim corrected |
| 5 | Deep-link matrix | Done — verified against the actual mobile repo, not assumed |
| 6 | Database report | Existing migrations plus new additive candidate-contract migration |
| 7 | Test report | Updated with actual 2026-10-26 commands; full HTTP suite is sandbox-blocked |
| 8 | Changed-files summary | PRs #38, #39, #41 and #42 are merged; this follow-up's changes are on the review branch |
| 9 | Outstanding decisions | Done — 4 real decisions, not 40 |
| 10 | Release recommendation | #38/#39/#41/#42 are merged. No production migration, deployment, or gate enablement is included in this follow-up. |
