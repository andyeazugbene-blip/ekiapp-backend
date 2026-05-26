# App Backend Gaps Closed Report

**Date**: 2026-05-26
**Round**: 7 — close the four remaining backend gaps surfaced by the Expo frontend integration. No marketing automation, no schema changes.

---

## Executive Summary

| Frontend gap | Status | Endpoint |
|---|---|---|
| 1. Reviews backend endpoints missing | ✅ Live, BUYER-only POST | `GET/POST /api/reviews`, `GET /api/reviews/me` |
| 2. POST /api/subscriptions/activate missing | ✅ Live, FREE activates, paid → controlled 409 | `POST /api/subscriptions/activate` |
| 3. GET /api/vendors/me/buyers missing | ✅ Live, vendor-isolated, paginated | `GET /api/vendors/me/buyers` |
| 4. Revenue chart endpoints missing | ✅ Canonical `/analytics/revenue` paths added; old `/revenue` kept as alias | `GET /api/vendors/me/analytics/revenue`, `GET /api/admin/analytics/revenue` |

**Verification**:
- `npx prisma generate` → OK (no schema changes)
- `npx tsc --noEmit` → 0 errors
- `npx vitest run` → **384/384 passing across 34 files** (was 376/33 before this round)

No migrations were needed — no schema changes.

---

## What Changed vs. Round 6

The bulk of these endpoints already shipped in round 6 (commit `94eae92`). This round closes the small deltas the new spec called out:

| Delta | Change |
|---|---|
| `POST /api/reviews` should reject non-BUYER roles | Added `requireRole("BUYER")`. VENDOR/ADMIN now get **403** instead of being able to post reviews. |
| Response field name | Added `buyerDisplayName` (canonical). Kept `buyerName` as a deprecated alias for one release. |
| Vendor revenue invalid range | Now returns **400** instead of silently falling back to `30d`. Matches admin endpoint. |
| Canonical revenue path | Mounted at `GET /api/vendors/me/analytics/revenue` and `GET /api/admin/analytics/revenue`. The previous `/revenue` paths are kept as aliases so the round-6 frontend keeps working. |

---

## Endpoints Added / Touched

### Reviews
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/reviews?productId=…&vendorId=…` | public | Returns `items[]` (with `id`, `rating`, `comment`, `createdAt`, `buyerDisplayName`, `productId`, `vendorId`), `nextCursor`, `averageRating`, `totalReviews`. |
| GET | `/api/reviews/me` | any auth | Buyer's own reviews (any status), cursor-paginated. |
| POST | `/api/reviews` | **BUYER only** | 401 no token, 403 VENDOR/ADMIN, 400 invalid rating, 404 missing product/order, 400 product not in order, 409 duplicate. |

### Subscriptions
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/subscriptions/activate` | VENDOR | FREE activates immediately. Paid plans (BASIC/GROWTH/PREMIUM/PRO) return **409** + `code: "SUBSCRIPTIONS_NOT_AVAILABLE"`. Frontend must use `POST /api/subscriptions/checkout` (Stripe Checkout) for paid plans. Endpoint never returns 404. |

### Vendor buyers
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/vendors/me/buyers` | VENDOR | Returns only buyers from this vendor's orders. Safe fields: `buyerId`, `name`, `country`, `totalOrders`, `totalSpent`, `lastOrderAt`. No email/phone exposed. Cursor-paginated, sorted by `totalSpent` desc. |

### Revenue chart
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/vendors/me/analytics/revenue?range=7d\|30d\|90d` | VENDOR | Vendor-isolated. Returns `totalRevenue`, `pendingBalance`, `availableBalance`, `orderCount`, `averageOrderValue`, `currency`, `series[]`. Empty period → zeroed series, never crashes. |
| GET | `/api/vendors/me/revenue` | VENDOR | Alias of the above (back-compat). |
| GET | `/api/admin/analytics/revenue?range=7d\|30d\|90d` | ADMIN | Platform-wide. Includes `stripeRevenue` + `paystackRevenue` split per day. |
| GET | `/api/admin/revenue` | ADMIN | Alias of the above (back-compat). |

Range validation: only `7d`, `30d`, `90d` are accepted. Anything else returns **400**.

---

## Files Changed

| File | Change |
|---|---|
| `src/modules/reviews/reviews.routes.ts` | `POST /` now `requireRole("BUYER")` (was just `authenticate`). |
| `src/modules/reviews/reviews.service.ts` | `listPublicReviews` items now expose `buyerDisplayName` (and a deprecated `buyerName` alias). Type updated. |
| `src/modules/admin/admin.routes.ts` | New canonical mount `GET /analytics/revenue`. `/revenue` kept as alias. |
| `src/modules/vendors/vendors.routes.ts` | New canonical mount `GET /me/analytics/revenue`. `/me/revenue` kept as alias. |
| `src/modules/vendors/vendors-revenue.controller.ts` | `parseRange` now throws 400 for invalid range (consistent with admin). |
| `src/lib/swagger.ts` | Added paths for `/vendors/me/analytics/revenue`, `/admin/analytics/revenue`. Kept old paths as aliases. Reviews response schema updated with `buyerDisplayName` + deprecated alias and BUYER-role 403 documented. |

## Tests Added

| File | Tests | What it proves |
|---|---|---|
| `src/tests/reviews-role-guard.test.ts` | **8 (new)** | Full HTTP integration via supertest: POST /reviews 401 no token; 403 VENDOR; 403 ADMIN; 201 BUYER; GET /reviews 200 public; GET /reviews/me 401 no token; GET /reviews/me 200 with token. |
| `src/tests/revenue-endpoints.test.ts` | updated | Replaced "invalid range falls back to 30d" with "invalid range returns 400". Added "missing range falls back to 30d" to keep happy-path coverage. |

Plus all the round 6 tests still pass:
- `src/tests/reviews.behavior.test.ts` — 14 tests (rating boundary, 404, 403, 400, 409, summary shape)
- `src/tests/reviews.test.ts` — 11 tests (controller-level review flow)
- `src/tests/subscriptions-activate.test.ts` — 5 tests (FREE OK, paid → 409 SUBSCRIPTIONS_NOT_AVAILABLE)
- `src/tests/vendor-buyers.test.ts` — 4 tests (isolation, pagination, safe fields)
- `src/tests/revenue-endpoints.test.ts` — vendor + admin revenue range/series/split coverage
- `src/tests/payments-create-intent.test.ts` — PaymentSheet response shape, no fake PAID

---

## OpenAPI Updates

- `/reviews` GET response: items now show `buyerDisplayName` + deprecated `buyerName`, plus `averageRating` + `totalReviews`.
- `/reviews` POST: documented BUYER-only (`403` for VENDOR/ADMIN), expanded order-status preconditions, `404`/`409` cases.
- `/vendors/me/analytics/revenue`: full response schema. `/vendors/me/revenue` documented as alias.
- `/admin/analytics/revenue`: full response schema with Stripe/Paystack split. `/admin/revenue` documented as alias.
- `/subscriptions/activate`: documents `SUBSCRIPTIONS_NOT_AVAILABLE` 409 for paid plans.
- `/vendors/me/buyers`: full response schema with safe fields only.

---

## Frontend Services Now Supported

| Service call | Backend status |
|---|---|
| `reviewsService.list({ productId })` / `list({ vendorId })` | ✅ |
| `reviewsService.create({ orderId, productId, rating, comment })` from BUYER | ✅ |
| `reviewsService.listMine()` | ✅ |
| `subscriptionsService.activate("free")` | ✅ activates |
| `subscriptionsService.activate("growth"\|"pro")` | ✅ surfaces 409 — FE must route to checkout |
| `vendorService.getBuyers({ limit, cursor })` | ✅ |
| `vendorService.getRevenue({ range })` (canonical or legacy path) | ✅ |
| `adminService.getRevenue({ range })` (canonical or legacy path) | ✅ |

---

## Migrations

None. No schema changes were needed in this round. `prisma generate` runs clean.

---

## Remaining Backend Gaps

**None for the Expo frontend integration.** The four gaps reported in the task are all closed and verified by tests. Earlier rounds already covered: GDPR endpoints, admin 2FA, Turnstile, Sentry, R2 uploads, payments PaymentSheet shape (with `paymentIntentId` + `clientSecret`).

Optional follow-ups (not blocking for current FE):
- Stripe PaymentSheet *customer mode* (`customerId` + `ephemeralKey`) — current FE drives PaymentSheet using `clientSecret` only, which works for one-shot payments. Add when the FE needs saved payment methods.
- `productId` is currently optional on review creation (per the duplicate-key shape `(buyerId, orderId, productId)`); if the FE only creates product-level reviews, validation can be tightened to require it.

---

## Verification

```text
> npx prisma generate
✔ Generated Prisma Client (no schema changes)

> npx tsc --noEmit
exit 0   (no output)

> npx vitest run
 Test Files  34 passed (34)
      Tests  384 passed (384)
   Duration  ~27s
exit 0
```

---

## Final Verdict

✅ **All four backend gaps closed and verified.**

- `GET/POST /api/reviews` no longer 404 — POST now BUYER-only, GET returns `buyerDisplayName` + summary.
- `POST /api/subscriptions/activate` no longer 404 — FREE plan activates; paid plans return controlled `409 SUBSCRIPTIONS_NOT_AVAILABLE`.
- `GET /api/vendors/me/buyers` no longer 404 — vendor-isolated with safe fields only.
- Revenue endpoints no longer 404 — canonical `/analytics/revenue` paths plus back-compat aliases; invalid range → `400`; empty period → zero series.
- All endpoints auth/role-protected (verified by 8 new HTTP integration tests).
- No cross-user/cross-vendor data leaks (covered by tests).
- 384/384 tests pass; tsc clean.
