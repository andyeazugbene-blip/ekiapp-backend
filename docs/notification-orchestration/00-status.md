# Notification Orchestration Spec v2 — Compliance Status

**Date:** 2026-10-27
**Author:** Mouad (with Claude Code assistance)
**Authoritative source:** the client supplied the Google Doc export on 2026-10-26. A byte-for-byte working copy is stored at [`Eki-Notification-Orchestration-Spec-v2.md`](Eki-Notification-Orchestration-Spec-v2.md). The document identifies itself as an implementation draft and says production event mapping and live QA are still required; each R01–R40 entry is proposed, not proof of an implemented backend event.

**Latest verified backend base:** `origin/main` is `8243cb5` (PR #46 merged externally on 2026-10-27 at 15:05 UTC; its CI, Vercel preview, and preview comments passed). PR #46 added a shared scheduler endpoint runner that fails on missing credentials, transport errors, redirects, and non-2xx responses without logging response bodies. Backend PR #47 is open for fail-closed R13/R15 order reminders; its local tests pass and GitHub CI is pending. Mobile PR #5 remains open at `72355b0`; Vercel and preview-comment checks passed, and GitHub lists no CI test job for that PR. The type-only global CSS declaration fix passes the clean PR-worktree typecheck. All notification gates remain off pending runtime/device QA and required approvals.

R06 now stops when the existing Stripe Identity session ID shows verification has started; R07/R08 use the real `requires_input`/`verified` webhook paths. The shared schema now carries rule/event/role/entity/task-episode, due/expiry, priority/category, template/variant, candidate lifecycle, preference, and outcome fields. The delivery worker applies role-scoped push consent, preference quiet hours, expiry, and current-state checks. WhatsApp can suppress push only when a positive receipt for the exact task episode falls inside an explicitly configured cooldown; the default cooldown is zero, so suppression is disabled until a provider and policy are approved. Authenticated notification opens record click outcomes; source-backed completion events record direct-task completion. R04 remains disabled. General support coverage uses the existing SUPPORT conversation/Message model.

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
- `09-mobile-runtime-qa.md` — R40 staging/device QA steps and all semantic destinations.
- `210-event-reconciliation.md` — missing original catalogue evidence, validated blank worksheet, and handoff requirements.

## One-line status per deliverable (full detail in each file)

| # | Deliverable | Status |
|---|---|---|
| 1 | Compliance matrix (R01–R40) | Done this pass — built from direct repo inspection |
| 2 | Architecture report | Updated with shared candidate, preference, delivery, and outcome contract |
| 3 | FIRST_SALE report | Historical report — PR #6 is merged |
| 4 | Scheduler report | Updated — daily Vercel cron plus Actions 401/gaps verified; merged PR #46 fails visibly on transport and non-2xx responses; successful sub-daily execution remains unverified |
| 5 | Deep-link matrix | Done — verified against the actual mobile repo, not assumed |
| 6 | Database report | Existing migrations plus new additive candidate-contract migration |
| 7 | Test report | Updated with 2026-10-27 evidence; focused suites pass, full suite has 10 HTTP files blocked by sandbox EACCES |
| 8 | Changed-files summary | PRs #38, #39, #41, #42, #43, #44, #45 and #46 are merged; PR #47 and mobile PR #5 remain open |
| 9 | Outstanding decisions | Updated with scheduler secret verification, WhatsApp provider/cooldown, missing source, R39 billing, and native QA |
| 10 | Release recommendation | No production migration, deployment, or gate enablement is included in this follow-up. |
