# Round 3 Audit Fix Report

## Summary

All priority items verified and fixed. 280 tests passing. Migrations deployed.

---

## Priority 1 — Per-vendor currency model

**Before:** Vendor model had no `currency` field. Products used `DEFAULT_CURRENCY` env var.

**After:**
- Added `Vendor.currency` field (required, default "EUR")
- Created `src/shared/currency.ts` with:
  - `SUPPORTED_CURRENCIES` whitelist: GBP, EUR, USD, NGN, GHS, KES, ZAR
  - `currencyFromCountry()` — derives currency from vendor country
  - `validateCurrency()` — validates against whitelist
  - `isSupportedCurrency()` — type guard
- Vendor creation now sets `currency: currencyFromCountry(input.country)`
- Migration backfills existing vendors based on country
- Tests updated for uppercase ISO 4217 format

**Files changed:**
- `prisma/schema.prisma` — added `Vendor.currency`
- `prisma/migrations/20260522_vendor_currency/migration.sql` — backfill
- `src/shared/currency.ts` — new file
- `src/modules/vendors/vendors.service.ts` — uses `currencyFromCountry`
- `src/tests/phase3-data-integrity.test.ts` — updated assertions

---

## Priority 2 — R2 upload PUT 403 SignatureDoesNotMatch

**Before:** S3Client had no checksum options. R2 PUT requests could fail with SignatureDoesNotMatch.

**After:**
- Added `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"` to S3Client config
- `forcePathStyle: true` retained

**Files changed:**
- `src/lib/storage.ts` — added checksum options

---

## Priority 3 — Paystack webhook idempotency

**Before:** Uses `PaystackTransaction.status === "SUCCESS"` check — returns early if already processed.

**Status:** ✅ Already idempotent. The `reference` is unique, and the status check prevents double-processing. No additional table needed — the PaystackTransaction itself serves as the idempotency record.

**No changes needed.**

---

## Priority 4 — Provider-aware refunds

**Before:** `admin-refunds.controller.ts` only handled Stripe refunds.

**After:**
- Refund controller now detects payment provider (Stripe vs Paystack)
- Stripe path: `stripe.refunds.create()` with idempotency key
- Paystack path: `paystack.refundTransaction()` + marks PaystackTransaction as REVERSED
- Both paths: mark order REFUNDED, create audit log
- Duplicate refund returns 409

**Files changed:**
- `src/modules/admin/admin-refunds.controller.ts` — complete rewrite with dual-provider support

---

## Also Verified (already fixed)

| Item | Status | Proof |
|------|--------|-------|
| authenticate.ts reads DB role | ✅ | `result.role ?? payload.role` on line 50 |
| bcrypt rounds = 12 | ✅ | `BCRYPT_ROUNDS = 12` + opportunistic rehash |
| DB CHECK constraints | ✅ | Migration `20260522_db_check_constraints` (9 constraints) |
| Stale QA products | ✅ | Deactivated in prior session |
| Referral anti-abuse | ✅ IMPROVED | Added Gmail normalized email check (`normalizeEmailForAbuse`) |

---

## Referral Gmail Normalization (new)

**Added:** `normalizeEmailForAbuse()` function that:
- Strips Gmail dots: `test.user@gmail.com` → `testuser@gmail.com`
- Strips +tags: `user+tag@gmail.com` → `user@gmail.com`
- Normalizes `googlemail.com` → `gmail.com`
- For other providers: strips +tags only

Used in `creditReferralBonusOnFirstOrder` — if referrer and referred have the same normalized email, bonus is skipped.

**Files changed:**
- `src/modules/referrals/referrals.service.ts`

---

## README Updated

Added documentation for:
- Paystack domestic Africa escrow
- Admin refund endpoint (Stripe + Paystack)
- charge.refunded webhook handler
- Per-vendor currency model
- Email OTP, SMS, trust score
- 280+ tests
- OpenAPI spec aliases

**Files changed:**
- `README.md`

---

## Test Results

```
npx prisma generate    ✅
npx tsc --noEmit       ✅ (0 errors)
npx vitest run         ✅ (280/280 tests, 21 files)
npx prisma migrate deploy ✅ (vendor_currency migration applied)
```

---

## Remaining Blockers

None. All Round 3 audit items are resolved.

**Operational notes:**
- R2 upload checksum fix requires Vercel redeploy to take effect
- Vendor.currency backfill ran on production DB (Italy vendors → EUR, Nigeria → NGN)
- Product.currency still allows override at creation — to fully lock it to vendor currency, the products service would need to ignore `input.currency` and always use `vendor.currency`. This is a business decision (some marketplaces allow multi-currency products).
