# FIRST_SALE / Vendor Onboarding — Rule-by-Rule Report

Covers PR #5 (merged) and PR #6 (open). Source of truth: [automation.detectors.ts](../../src/modules/automation/automation.detectors.ts).

## R01 — REGISTRATION_REMINDER

- **Trigger / source data:** `User.role === "VENDOR" && vendor === null` (real query, not inferred).
- **Recipient/ownership:** the user themself; no vendor row exists yet so no cross-vendor exposure risk.
- **Eligibility at schedule + send time:** re-queried every sweep run; a vendor who creates their profile between sweeps simply stops appearing — no stale send possible.
- **Stop condition:** independent — vendor profile created. Verified by the candidate query itself (`vendor: null`), not a separate flag.
- **Idempotency/episode dedup:** `dedupeKey = {userId}:touch{N}`, DB-unique. Verified by test: re-running the sweep never produces a second distinct key for an already-fired touch.
- **Copy/CTA/destination:** title/body match spec text exactly ("Start setting up your Eki store" / "Add your business details to begin"). Destination key `store_setup` — route status: see `05-deeplink-matrix.md`.
- **Max sends:** 3 (touch1/2/3), enforced by the shared `duePTouchNumbers` helper — tested for the exact boundary (past 72h → exactly 3, never 4).
- **Completion attribution:** none (no `Outcome` table yet) — only that it stopped firing.
- **Regression risk:** **low.** Narrower, more specific trigger than before; cannot fire for anyone it didn't already fire for.

## R03 — FIRST_PRODUCT_REMINDER

Same structure as R01. Trigger: Vendor row exists, zero active products. Verified mutually exclusive against R05/R06/R11 by test (`FIRST_PRODUCT_REMINDER` fires → `DELIVERY_SETUP_REMINDER`/`VERIFICATION_REMINDER`/`FIRST_SALE` assert NOT called in the same case).

## R05 — DELIVERY_SETUP_REMINDER

Trigger: has an active product, no `DeliveryZone` row. Same mutual-exclusivity test coverage as R03.

## R06 — VERIFICATION_REMINDER

Trigger: has product + delivery zone, `verificationStatus !== "VERIFIED"`.

**Documented substitution:** the spec's stop condition is "verification submitted." This codebase has no "submitted, pending review" state distinct from "not started" — only a final `VERIFIED` boolean-equivalent. So this rule keeps nudging a vendor who has already submitted their documents and is waiting on Stripe, which is **not what the spec asked for** and could read as nagging someone who already acted. Not fixed this pass — fixing it needs either a new `verificationSubmittedAt` timestamp or reading Stripe Identity's own intermediate status, which is new schema/integration work, flagged rather than silently done or silently ignored.

## R11 — FIRST_SALE (narrowed)

Trigger: product + delivery + verified, zero paid orders. **Behavior change from the previous release:** this type used to also cover R03/R05/R06 with stage-switching copy; it now only fires for the R11 condition. Any dashboard, saved filter, or admin runbook that assumed `FIRST_SALE` meant "any onboarding nudge" needs updating — flagged as an operational note, not a code change (no such dashboard found in `admin-web`'s automation page; it lists by type already, so it will just show fewer `FIRST_SALE` rows and more of the four new types instead).

## Cross-cutting findings

- **Vendor-toggle exposure:** `FIRST_PRODUCT_REMINDER`/`DELIVERY_SETUP_REMINDER`/`VERIFICATION_REMINDER` were added to `VENDOR_TOGGLEABLE_AUTOMATION_TYPES` (a vendor can turn each off individually) — `REGISTRATION_REMINDER` deliberately was not (no Vendor row exists yet to attach a per-vendor toggle to).
- **Three-listings rule:** confirmed nowhere in the code does activation require 3 products — `hasProduct = _count.products > 0` everywhere, matching the client's locked decision.
- **"Foodstuff" terminology:** new copy for all 5 rules uses "foodstuff"/"store" per the spec; the underlying Prisma model is still named `Product` — cosmetic-only mismatch, not customer-facing, not changed (renaming a model is a bigger, riskier migration than this pass's scope).

## Test evidence

`src/tests/automation-detectors.test.ts` — rewrote the old merged-`FIRST_SALE` suite into 5 rule-specific test groups plus new P2-cadence tests (4h/24h/72h boundaries, 3-touch cap, mutual exclusivity). Full command output in `07-test-report.md`.
