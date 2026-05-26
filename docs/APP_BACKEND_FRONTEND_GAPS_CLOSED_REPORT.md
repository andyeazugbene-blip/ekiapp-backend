# App Backend ↔ Frontend Gaps Closed Report

**Date**: 2026-05-26
**Scope**: Round 6 — close the five remaining backend gaps reported by the Expo frontend integration. No marketing automation, no schema changes.

---

## Executive Summary

| Frontend gap | Status |
|---|---|
| 1. Reviews endpoints missing | ✅ Live, with privacy-safe buyer name + summary |
| 2. POST /api/subscriptions/activate missing | ✅ Live; FREE activates, paid plans return controlled `409 SUBSCRIPTIONS_NOT_AVAILABLE` |
| 3. GET /api/vendors/me/buyers missing | ✅ Already live, verified isolated + paginated |
| 4. Vendor/admin revenue chart endpoints | ✅ Two new endpoints with daily series + summary |
| 5. Stripe PaymentSheet `clientSecret` support | ✅ Response now exposes `paymentIntentId` + `clientSecret` |

**Verification**:
- `npx prisma generate` → OK (no schema changes)
- `npx tsc --noEmit` → 0 errors
- `npx vitest run` → **376/376 passing across 33 files** (was 332 in 28 files before this round)

No `npx prisma migrate` was needed — no schema changes.

---

## Endpoints Added / Touched

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/reviews` | public | Now returns `items[]` (with `buyerName`), `nextCursor`, `averageRating`, `totalReviews` |
| GET | `/api/reviews/me` | buyer JWT | New — buyer's own reviews (any status), cursor-paginated |
| POST | `/api/reviews` | buyer JWT | Existing endpoint, behavior expanded: now accepts `PAID/CONFIRMED/PROCESSING/DISPATCHED/IN_TRANSIT/DELIVERED/COMPLETED/PAYMENT_SECURED/VENDOR_CONFIRMED/AUTO_RELEASED`. 404 if product missing. 400 if product not in order. 409 if duplicate. |
| POST | `/api/subscriptions/activate` | vendor JWT | Existing endpoint, behavior tightened: FREE activates without payment; paid plans return `409 SUBSCRIPTIONS_NOT_AVAILABLE` (must use `POST /api/subscriptions/checkout` instead). |
| GET | `/api/vendors/me/buyers` | vendor JWT | Already implemented — verified isolation, pagination, safe fields (`buyerId`, `name`, `country`, `totalOrders`, `totalSpent`, `lastOrderAt`); no email/phone exposed. |
| GET | `/api/vendors/me/revenue` | vendor JWT | **New.** Query `range=7d|30d|90d` (default 30d). Returns vendor-isolated revenue summary + daily series. Currency from wallet → vendor.currency fallback. |
| GET | `/api/admin/revenue` | admin JWT | **New.** Same `range` param. Platform-wide totals + daily series with `stripeRevenue` / `paystackRevenue` split. Empty period returns zeroed series, never crashes. |
| POST | `/api/payments/create-intent` | buyer JWT | Response shape now: `{ paymentIntentId, clientSecret, checkoutId, orderIds[], amount, currency }`. Wallet-only checkouts return `paymentIntentId: ""` and `clientSecret: "wallet_paid"`. |

### Endpoints intentionally unavailable (controlled response)

| Endpoint | Behavior | Why |
|---|---|---|
| `POST /api/subscriptions/activate` with paid plan | `409` + `code: "SUBSCRIPTIONS_NOT_AVAILABLE"` | Soft-launch policy: never fake activation. Paid activation is gated behind the existing Stripe Checkout flow (`POST /api/subscriptions/checkout`). The Stripe webhook is the only thing that can mark a paid subscription `ACTIVE`. |

The endpoint never returns 404 — frontend always gets a structured response with a clear next step.

---

## Files Inspected

- `src/modules/reviews/{routes,controller,service,validation,types}.ts`
- `src/modules/payments/{controller,service,types,validation,routes}.ts`
- `src/modules/subscriptions/{routes,controller,service,validation,types}.ts`
- `src/modules/vendors/{vendors.routes,vendors-buyers.controller,vendors-dashboard.*}.ts`
- `src/modules/admin/{admin.routes,admin-dashboard.*}.ts`
- `src/lib/swagger.ts`

## Files Changed

| File | Change |
|---|---|
| `src/modules/reviews/reviews.service.ts` | `listPublicReviews` now returns `totalReviews` + safe `buyerName`; allowed order statuses expanded; `productId` existence check; new `listMyReviews(buyerId, …)` |
| `src/modules/reviews/reviews.controller.ts` | New `listMyReviews` controller |
| `src/modules/reviews/reviews.routes.ts` | `GET /me` registered (auth-only) |
| `src/modules/subscriptions/subscriptions.service.ts` | `activatePlan` only accepts FREE; paid plans throw `AppError` with `code: "SUBSCRIPTIONS_NOT_AVAILABLE"` |
| `src/modules/payments/payments.service.ts` | Both return blocks include `paymentIntentId`; types updated |
| `src/modules/payments/payments.types.ts` | `CreatePaymentIntentResponse` adds `paymentIntentId: string` |
| `src/modules/vendors/vendors-revenue.controller.ts` | **New** — `GET /api/vendors/me/revenue` |
| `src/modules/vendors/vendors.routes.ts` | Wires `/me/revenue` |
| `src/modules/admin/admin-revenue.controller.ts` | **New** — `GET /api/admin/revenue` |
| `src/modules/admin/admin.routes.ts` | Wires `/revenue` |
| `src/lib/swagger.ts` | New paths: `/reviews/me`, `/subscriptions/activate`, `/vendors/me/buyers`, `/vendors/me/revenue`, `/admin/revenue`. `CreatePaymentIntentResponse` schema rewritten with new fields. |

## Tests Added

| File | Tests | What it proves |
|---|---|---|
| `src/tests/reviews.behavior.test.ts` | 14 | Rating boundary (rejects 0, -1, 6, 3.5; accepts 1..5); 404 missing order/product; 403 not-owner; 400 not-paid; 400 product-not-in-order; 409 duplicate; happy path; summary returns `averageRating` + `totalReviews` + safe buyerName + zero-state shape |
| `src/tests/subscriptions-activate.test.ts` | 5 | 403 no vendor; FREE activates; GROWTH/PRO/BASIC/PREMIUM all return 409 `SUBSCRIPTIONS_NOT_AVAILABLE`; no upsert side-effect on paid rejection |
| `src/tests/vendor-buyers.test.ts` | 4 | Pre-existing — vendor isolation, pagination, safe fields |
| `src/tests/revenue-endpoints.test.ts` | 11 | Pre-existing — vendor isolation, range validation, empty range zero-series, Stripe/Paystack split for admin |
| `src/tests/payments-create-intent.test.ts` | 7 | Pre-existing — PaymentSheet response shape (`paymentIntentId` + `clientSecret`), 404 missing cart, 403 cross-buyer, 400 empty cart, no fake PAID before webhook |

Plus updates to existing tests so they reflect the new behavior:

- `src/tests/reviews.test.ts` — adjusted for `PAID` allowed; added 404-product test
- `src/tests/production-validation.test.ts` — adjusted activate test for FREE-only + new 409 case; reviews tests now confirm PAID/PROCESSING are accepted

---

## Frontend Services Affected

| Frontend service | Change required (FE side) |
|---|---|
| `reviewsService` | Read `buyerName` instead of looking up user; read `averageRating` + `totalReviews` from response root. New `GET /api/reviews/me` for "my reviews" screen. |
| `subscriptionsService` | Catch `409 + code === "SUBSCRIPTIONS_NOT_AVAILABLE"` from `POST /activate` and route the user to the Stripe Checkout flow (`POST /api/subscriptions/checkout`). Do NOT show "active" UI from a paid `/activate` response — it never returns one. |
| `vendorsService.getBuyers()` | No change — endpoint already returns the documented shape. |
| `vendorsService.getRevenue(range)` | Hit `GET /api/vendors/me/revenue?range=7d|30d|90d`. Series is always exactly N entries (one per day), zeros when no orders. |
| `adminService.getRevenue(range)` | Hit `GET /api/admin/revenue?range=7d|30d|90d`. Includes `stripeRevenue` + `paystackRevenue` split. |
| `paymentsService.createIntent()` | Read `paymentIntentId` and `clientSecret` from the response, pass both to mobile Stripe PaymentSheet. Order status remains `PENDING` until the webhook confirms — frontend success ≠ paid. |

---

## Remaining Frontend Work (out of scope here)

- Render `buyerName` in review cards.
- Add "My reviews" screen consuming `GET /api/reviews/me`.
- Replace the optimistic "subscription active" UI for paid plans with the Stripe Checkout flow.
- Wire revenue chart components to the new `/revenue` endpoints with the `range` selector.
- Confirm Stripe PaymentSheet on iOS + Android consumes `paymentIntentId` (some SDKs accept just `clientSecret`; the field is now exposed for SDKs that require both).

PaymentSheet customer mode was **not** added in this round (no `customerId` / `ephemeralKey` exposed). The frontend can drive PaymentSheet using `clientSecret` only — see Stripe's React Native docs for the basic mode. Customer mode can be wired later without touching the API surface.

---

## Verification (live commands)

```text
> npx prisma generate
✔ Generated Prisma Client (no schema changes)

> npx tsc --noEmit
exit 0   (no output)

> npx vitest run
 Test Files  33 passed (33)
      Tests  376 passed (376)
   Duration  ~30s
exit 0
```

---

## Final Verdict

✅ **Frontend backend gaps closed for the public-launch path.**

- Reviews no longer 404, expose privacy-safe buyer names, and return the summary the chart needs.
- Subscriptions activate no longer 404; paid plans surface a controlled `409 SUBSCRIPTIONS_NOT_AVAILABLE` so the frontend can route to checkout instead of showing a fake active state.
- Vendors/me/buyers no longer 404 (already live, re-verified).
- Vendor + admin revenue endpoints return safe per-day series with currency, totals, and Stripe/Paystack split.
- Payments create-intent exposes both `paymentIntentId` and `clientSecret` for mobile PaymentSheet.
- All new endpoints are auth/role protected; no cross-user or cross-vendor data leaks (covered by tests).
- All tests pass.
