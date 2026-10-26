# Test Report

## Latest verification — 2026-10-26 R28 specification alignment

- Backend `src/tests/community-buy-support-case.test.ts` and `src/tests/notifications-dedupe.test.ts`: **27 tests passed**. Coverage includes exact R28 copy, reporter recipient, stable response-version dedupe, no notification for a closed case, notification row ID in push data, and existing duplicate push suppression.
- Backend `npm run build`: **passed**.
- Mobile `npm run typecheck`: **passed** after adding case-specific R28 routing, own-case verification before expansion, and read acknowledgement after authentication restoration.
- No schema or migration changes were made. No native device QA or full backend suite was run for this slice.
- GitHub was unreachable from this environment during publication; this local feature commit has no PR or CI result yet.

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
