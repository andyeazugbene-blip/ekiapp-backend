# Scaling & Sustainability Response

## Verification Asymmetry
**Concern:** Tests exist but coverage is uneven across modules.
**Response:** Created `npm run test:coverage-map` — maps all 25 modules to DIRECT_TESTED / TRANSITIVE_ONLY / UNTESTED. Money-adjacent modules flagged. Paystack module identified as needing direct tests (currently covered transitively via production smoke tests).

## Knowledge Concentration
**Concern:** Single developer knows the system; no onboarding path.
**Response:**
- 5 Architecture Decision Records in `docs/decisions/`
- `CONTRIBUTING.md` with full local setup, commands, PR checklist
- `docs/MODULE_OWNERSHIP.md` mapping 25 modules to domain categories
- `docs/HOW_BACKEND_WORKS.md` explaining request flow, payment flow, invariants
- `docs/RUNBOOK_ADD_FEATURE.md` and `docs/RUNBOOK_DEBUG_PAYMENT.md`

## AI-Pattern Bugs
**Concern:** AI-generated code may contain placeholder phrases that look like real code.
**Response:** Created `npm run check:scaffolding` — scans 208 source files for risky phrases ("For now", "placeholder", "mock for development", "TODO: replace", etc.). Fails CI if found. Currently passes clean.

## Feature Sprawl
**Concern:** New modules added without justification or deprecation plan.
**Response:**
- `docs/process/NEW_MODULE_GATE.md` — requires evidence, success metric, owner, deprecation plan
- `docs/process/UNUSED_MODULE_AUDIT.md` — 60-day audit cycle, feature-flag → remove flow

## Technical Scaling
**Concern:** Vercel serverless has timeout limits; synchronous processing won't scale.
**Response:** `docs/scaling/QUEUE_AND_CDN_PLAN.md` — documents current ceiling, recommends Inngest/QStash, lists what to move to background, CDN cache rules, rollout/rollback plan.

## Team Scaling
**Concern:** No process for multiple engineers working on the same codebase.
**Response:**
- Module ownership map (who owns what)
- Contributing guide (how to work)
- Commit convention enforced by commitlint
- PR checklist in CONTRIBUTING.md
- Runbooks for common tasks

---

## Verification Results

| Command | Result |
|---------|--------|
| `npm run check:scaffolding` | ✅ PASS (208 files, 0 risky phrases) |
| `npm run test:coverage-map` | ✅ 5 direct, 15 transitive, 5 untested (1 money-adjacent: paystack) |
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run` | ✅ 284/284 tests |

## Remaining Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Paystack module has no direct unit tests | Medium | Covered by production smoke tests; add unit tests in next sprint |
| Background jobs require Redis (not available on Vercel free tier) | Low | Queue plan documented; sync fallback works |
| No CI pipeline (GitHub Actions) | Medium | Tests run via husky pre-commit; add GH Actions in next sprint |
