# Test Report

## Latest verification — 2026-10-26 R28 specification alignment

### Follow-up verification — general support outbox and durable push (PRs #23/#24)

- Backend focused `core-event-handlers.test.ts`, `notification-delivery.test.ts`, and `event-outbox.test.ts`: **16 tests passed**. Coverage includes exact R28 copy and recipient, suppression for read/closed/internal/non-support messages, delivery send-time rechecks, no-token retry, provider receipt success, and receipt-failure retry.
- Backend `npm run build`: **passed**.
- `npx prisma validate`: **passed**; `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` generated SQL for the new delivery table.
- Full migration-directory diff was **not validated**: Prisma requires a configured shadow database for `--from-migrations`, and none is configured in this environment. No migration was applied to any database.
- Mobile `npm run typecheck`: **passed** after mapping the v2 `support_case` destination to authenticated general support messages and Community Buy reporter-owned cases.
- No device QA or full backend test suite was run for this slice. PR #23 and PR #24 CI/preview results are reported from the live GitHub check state, not inferred from local runs.

### CI regression correction — 2026-10-26 follow-up branch

- Live GitHub CI for merged PR #23 failed 9 tests in `messages-service.test.ts`: each failure was the stale test mock trying to iterate a Prisma callback transaction as an array. Updated the test transaction mock to support both callback and array forms, and changed the support-reply assertion to verify atomic outbox enqueue.
- Backend `src/tests/messages-service.test.ts`: **36 tests passed** after the correction.
- Backend `npm run build` and `npx prisma validate`: **passed**.
- PR #23 was merged externally despite its failed `test` job; PR #24 was merged externally after Vercel checks passed and had no GitHub `test` check on its head. A follow-up branch carries the callback-mock correction and aligns R28's merged payload with the v2 `support_case` destination used by mobile PR #5.

- Backend `src/tests/community-buy-support-case.test.ts` and `src/tests/notifications-dedupe.test.ts`: **27 tests passed**. Coverage includes exact R28 copy, reporter recipient, stable response-version dedupe, no notification for a closed case, notification row ID in push data, and existing duplicate push suppression.
- Backend `npm run build`: **passed**.
- Mobile `npm run typecheck`: **passed** after adding case-specific R28 routing, own-case verification before expansion, and read acknowledgement after authentication restoration.
- No schema or migration changes were made. No native device QA or full backend suite was run for this slice.
- Backend PR #21 was published, then GitHub reports it merged by `andyeazugbene-blip` at 2026-10-26 12:05:48 UTC; I did not perform the merge. At the latest check its `test` job was still IN_PROGRESS and Vercel was PENDING, so CI success is not established. Mobile PR #5 remains open; its Vercel and preview-comment checks passed after the R28 mobile commit.

## Follow-up verification — 2026-10-26 R04 source alignment

- Backend `src/tests/automation-detectors.test.ts` and `src/tests/automation-rule-approval.test.ts`: **51 tests passed**. The detector assertions now check the exact v2 title/body and the gate rejects activation even when the old approval environment flag is set.
- Backend build and mobile typecheck passed in the R28 verification above; no mobile source changed in this R04 slice.
- R04 remains disabled because the active scheduler is daily, Acquisition WhatsApp coordination is not implemented/verified, and native route QA is unavailable.

## Historical verification — 2026-10-26 R10 changes

- Backend `npx tsc --noEmit`: **passed**.
- Backend `npm run build`: **passed**.
- Backend `npx prisma validate`: **passed**; no schema or migration was added in this slice.
- Focused backend `automation-detectors.test.ts`, `event-emission-extras.test.ts`, `stripe-identity.test.ts`, and `community-buy-support-case.test.ts`: **92 tests passed**. This includes R06 session-stop, R07/R08 Stripe Identity outcomes, R10 event authorization/readiness timing, and R28 reporter ownership.
- Mobile `npm run typecheck`: **passed**.
- Backend full suite, `npx vitest run --pool=forks --maxWorkers=1`: **188/198 files passed; 2,813 tests passed and 308 failed**. All 10 failing suites are HTTP tests that could not connect to their local test servers (`connect EACCES 127.0.0.1`). This environment restriction prevents a full CI-equivalent result; it does not establish whether those tests pass outside this sandbox.
- `git diff --check`: **passed** in both repositories.

No mobile device runtime test, production deployment, or external provider test was performed.

## Historical verification — 2026-10-25 PR #6 branch

All commands below were run against the `feat/notification-spec-v2-onboarding-rules` branch on 2026-10-25. These results are retained as historical evidence and are not a substitute for the latest run above.

## TypeScript

```
$ npx tsc --noEmit -p .
(no output — clean)
```
**PASSED.**

## Production build

```
$ npm run build
> marketplace-payments-backend@1.3.0 build
> tsc -p tsconfig.json
(no output — clean)
```
**PASSED.**

## Full test suite

```
$ npx vitest run
 Test Files  198 passed (198)
      Tests  3109 passed (3109)
   Start at  23:17:44
   Duration  98.32s
```
**PASSED.** Includes the rewritten `automation-detectors.test.ts` (5 rule-specific suites for R01/R03/R05/R06/R11, plus new P2-cadence tests) and the updated `automation.test.ts` exhaustiveness check.

## Scaffolding phrase check

```
$ npm run check:scaffolding
Found 1 risky phrase(s):
  src/modules/communications/comms-utils.ts:53 — "placeholder"
    /** Placeholders in `text` that a broadcast cannot fill. */
❌ FAIL — 1 scaffolding phrases detected
```
**FAILED — pre-existing, not a regression.** Confirmed by running this exact check against `main` directly (checked out `main`, ran the script, identical output, byte-for-byte, before this pass's work existed on that branch) and by reading the file's git history (introduced at commit `dd91b3c`, over two weeks before this work started). Reproduced again in PR #6's actual GitHub Actions run (`gh run view 40239716370 --log-failed`) — same file, same line, same phrase.

## Lint

No lint script exists in this repo's `package.json` — **not applicable**, not skipped.

## Migration validation

`npx prisma migrate status` against the production Neon database (credentials supplied directly by the client in this session, used only for this read and the backfill writes already authorized and applied last week) returned "Database schema is up to date" before PR #6's migration was written — confirming the migration file syntax matches the established pattern and the enum-add approach works against this exact database. PR #6's migration has **not yet been run against production** (correctly — the PR hasn't merged).

## Tests explicitly marked BLOCKED, not fabricated

The spec's test-requirements list (section 11) includes items this pass could not exercise and makes no false claim about:

- **Cross-channel WhatsApp/push suppression** — blocked, no WhatsApp integration exists to test against.
- **Invalid device tokens / transient provider failures** — not newly tested this pass; existing coverage (if any) predates this work and was not re-audited.
- **Deep-link authentication and fallback behavior** — blocked on the mobile-repo gaps documented in `05-deeplink-matrix.md`; most destinations have no route to test a fallback for yet.
- **Transactional outbox recovery after a process failure** — not applicable; no outbox consumer exists yet to recover.
- **Community Buy minimum/goal/maximum handling** — not re-tested this pass; existing `community-buy` test suites were not touched or re-verified.
- **R12–R40 individually** — per `01-compliance-matrix.md`, 16 of those 40 rules were not confirmed implemented-or-not this pass, so no test claim is made about them either way.

## What this report does NOT claim

- It does not claim CI is green — PR #6 has 1 failing check (the pre-existing scaffolding finding) and 2 passing. That's stated plainly in `00-status.md` and the PR body.
- It does not claim production is running this code — PR #6 is unmerged.
- It does not claim any real push/email/WhatsApp message reached a real device this pass.
# Current follow-up evidence — 2026-10-27

The sections below also contain historical results from earlier branches. For `feat/notification-spec-contracts`, the following focused checks were run against the current worktree:

```
vitest run --reporter=dot \
  src/tests/notification-event-pipeline.integration.test.ts \
  src/tests/notification-delivery.test.ts \
  src/tests/core-event-handlers.test.ts \
  src/tests/notifications-dedupe.test.ts \
  src/tests/notification-preferences.test.ts
Test Files  5 passed (5)
Tests       63 passed (63)
```

`prisma validate` and Prisma client generation passed for the additive schema migration. `git diff --check` passed. The full backend build and full suite have not been rerun from this worktree because its dependency tree is incomplete. `public-stores.test.ts` could not start: local `stripe` resolution fails because dependency `qs` is unavailable in this checkout. CI should run with the repository's locked dependency install before merge.

The current follow-up does not claim native iOS/Android runtime QA, WhatsApp provider delivery, production migration, or production gate enablement.

## Follow-up from main `c979a5a` — 2026-10-27

This review branch reconciles the existing R30 reminder against current `main` and adds narrowly scoped R24 support from the persisted ordinary-shipment `DELAYED` transition. No Prisma schema change or migration was introduced.

Focused command:

```
npx vitest run src/tests/automation-detectors.test.ts src/tests/automation-centre.test.ts src/tests/vendor-subscription-webhooks.test.ts src/tests/notification-event-pipeline.integration.test.ts src/tests/notification-delivery.test.ts src/tests/shipments.test.ts src/tests/notification-preferences.test.ts src/tests/notifications-dedupe.test.ts src/tests/notification-outcomes.test.ts src/tests/event-outbox.test.ts --reporter=dot
Test Files  10 passed (10)
Tests       154 passed (154)
```

The R30 cases verify future scheduling, exact `trialEndsAt - 7 days` timing, current-state checks, and suppression after the five-minute due-time jitter window. R24 tests cover the authenticated vendor producer transition, full outbox-to-candidate-to-push path, current buyer/shipment eligibility, and cancellation when a newer delay episode supersedes a candidate. Shared-pipeline coverage verifies idempotent candidate metadata, preference persistence and marketing consent, send-time opt-out enforcement, local quiet-hour deferral, WhatsApp-delivered episode suppression, delivery receipt state, and source-backed outcome attribution. Product publication is no longer treated as direct completion of an R08 verification-approved alert because that event does not prove the vendor acted on the alert. No WhatsApp provider exists/configured; tests validate suppression against recorded delivery evidence only, not provider-dependent sending.

Additional checks: `npm run build` — passed; `npx tsc --noEmit` — passed; `npx prisma validate` — passed; `git diff --check` — passed. Mobile `npm run typecheck` passed during review of open mobile PR #5. This is source typechecking, not native device QA. No device, production runtime, external provider, or sub-daily scheduler verification was performed. All gates remain off.

PR #43 CI failed because the detector test's mocked `automationService` did not implement the newly invoked due-R30 dispatcher. PR #44 added that mock and asserts the sweep invokes it; PR #44 was merged externally at `6b09204`, and its focused GitHub test passed according to the prior live check. No merge was performed in this session.

## 2026-10-27 scheduler, shared-channel policy, catalogue, and mobile review

**Backend source base:** local `origin/main` commit `6b09204` (PR #44). Current work is on backend PR #45, open and clean as of 2026-10-27. Its CI `test` job, Vercel preview, and Vercel preview-comments check all passed. Mobile PR #5 is open/clean; its Vercel checks pass. No PR was merged.

**Scheduler evidence:** Actions run `40468800224` (2026-10-27) returned HTTP 401 from all five internal endpoints with an empty bearer value. The preceding recorded runs were about 5h37m apart despite a ten-minute cron declaration. The old workflow concealed failures with `continue-on-error`; the local follow-up now checks for an injected secret without printing it and fails on every unsuccessful endpoint. This change has not yet run in GitHub Actions. No secret value was read/changed, and R30 remains disabled.

**Backend focused verification, after changes:**

```
npx vitest run --pool=threads --maxWorkers=1 \
  src/tests/notification-delivery.test.ts \
  src/tests/notification-event-pipeline.integration.test.ts \
  src/tests/payment-anomaly.test.ts \
  src/tests/event-outbox.test.ts --reporter=dot
Test Files  4 passed (4)
Tests       63 passed (63)
```

The delivery tests cover exact-task WhatsApp suppression only with an explicit 3,600-second window and positive `deliveredAt` bounded to the window; unset cooldown does not query/suppress, unresolved provider outcomes do not suppress, critical order service messages bypass cross-channel suppression, and previously covered opt-out/quiet-hours/receipt cases remain in the passing suite. Added a deterministic clock to an existing R34 rescue-window integration test because its hard-coded deadline expired relative to the 2026-10-27 runtime clock.

- Backend `npm run build`: **passed**.
- Backend `npx tsc --noEmit`: **passed**.
- Backend `npx prisma validate`: **passed**; no schema change or migration was introduced.
- Catalogue validator `node --test scripts/validate-notification-catalogue.node-test.mjs`: **4 passed**. The checked-in template validates with `--template`; a full import requires exactly 210 source-backed rows. Search of available project trees found only references/specification, not the original handbook.
- Mobile PR #5 source worktree `npm run typecheck`: **passed**. `check:tab-registration`, `check:automation-managed-types-viewable`, and `check:release-config`: **passed**. `check:domains` could not reach the domains/API from this network-restricted environment (two fetch failures); no route health is inferred from it. Current GitHub state: PR #5 open/clean with Vercel checks passing.
- Mobile package has no test-runner/routing harness. No Android SDK, `adb`, emulator, or physical-device runtime QA was available. The R40 staging setup and ten-case matrix are documented in `09-mobile-runtime-qa.md`.
- Full backend `npx vitest run --pool=threads --maxWorkers=1 --reporter=dot` (before the final critical-message regression test was added): **196 files passed, 10 files failed; 2,903 passed and 308 failed out of 3,211 tests**. All 308 failures are HTTP requests blocked by sandbox `connect EACCES 127.0.0.1` (for example `admin-organiser-stripe-connect-route`, `admin-role-matrix-http`, and `security-rbac-idor`); no test file failed collection after renaming the Node test. The final focused 63-test run includes the additional critical-message test. An initial focused Vitest attempt failed before tests due sandbox temp-file rename permissions; rerunning with repository-local `TEMP` and one thread passed.

PR #45 latest-head GitHub CI: `test` passed in 1m23s (run [40507966820](https://github.com/andyeazugbene-blip/ekiapp-backend/actions/runs/40507966820)); Vercel preview and preview comments passed. The PR remains open/clean and was not merged. No production notification, WhatsApp delivery, secret/configuration change, migration, or gate activation occurred. Test results do not establish device/runtime QA, client approval, or enablement.

## Scheduler transport follow-up from merged main `746a394` — 2026-10-27

Code review found that a nonzero `curl` transport exit could leave the workflow with an empty HTTP status and still allow the Bash step to succeed; arbitrary response bodies were also printed. The workflow now calls `scripts/call-internal-scheduler-endpoint.mjs`, which validates the secret before making the request, treats transport/timeout errors, redirects, and all non-2xx statuses as failures, and logs neither response bodies nor caught error details. Its focused tests verify missing-secret fail-fast, transport errors without detail leakage, HTTP 401 handling without body reads, redirect rejection, and 2xx success.

```
node --test scripts/call-internal-scheduler-endpoint.node-test.mjs
6 tests passed; 0 failed
npm run build                         passed
npx tsc --noEmit                      passed
npx prisma validate                  passed (no schema change)
node scripts/validate-notification-catalogue.mjs docs/notification-orchestration/210-event-reconciliation-template.csv --template
                                      passed
git diff --check                     passed
```

The six tests include the workflow entry point's nonzero exit and clear error when the credential is absent. The CI workflow now runs these Node tests. CI has not yet run on this follow-up branch. GitHub confirmed PR #45 merged at `746a394` with CI run [40508295734](https://github.com/andyeazugbene-blip/ekiapp-backend/actions/runs/40508295734), Vercel preview, and preview comments passing. This only verifies that merged code passed its checks; the owner's `CRON_SECRET` injection and successful sub-daily scheduled executions remain unverified. R30 and cadence-sensitive rules remain gated.

Mobile PR #5 remains open at `72355b0`; its Vercel preview is pending, Vercel preview comments passed, and no CI test job is listed. The clean PR QA checkout's `npm run typecheck` passed after adding a TypeScript 6 declaration for the existing global CSS import; the three repository checks `check:tab-registration`, `check:automation-managed-types-viewable`, and `check:release-config` passed. `check:domains` could not reach its remote endpoint in the prior review. The package has no unit-test runner/routing harness, so source-level mobile tests are unsupported without adding a test stack. No physical-device or native runtime QA is claimed.
