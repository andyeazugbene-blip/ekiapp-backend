# Domestic Africa Escrow — Implementation Plan

## Overview

A complete escrow-based delivery system for Africa-based vendors (Nigeria/Ghana) selling domestically. Payment via Paystack (NGN/GHS), delivery confirmed via physical OTP given by rider to buyer, with auto-release after 24 hours and dispute protection.

---

## Architecture Decisions

- Paystack runs **alongside** Stripe (not replacing it). A vendor's country/type determines which flow applies.
- New order statuses are added to the existing `OrderStatus` enum — no separate Order model.
- Delivery OTP is a new model, distinct from the email verification OTP.
- Background jobs use BullMQ (already configured) with new queues for timeout/release.
- Buyer trust score is a field on the User model with a dedicated service.

---

## Batch 1 — Paystack Integration & Escrow Order Foundation

**Goal:** Buyer can pay via Paystack. Funds are captured. Vendor is notified. Order enters escrow state.

### Database Changes
- Add to `OrderStatus` enum: `PAYMENT_SECURED`, `VENDOR_CONFIRMED`, `DISPUTED`, `AUTO_RELEASED`
- Add `Order` fields: `escrowType` (NONE | DOMESTIC_AFRICA), `escrowExpiresAt`, `disputedAt`, `autoReleasedAt`, `vendorConfirmedAt`
- Add `PaystackTransaction` model: `id`, `orderId`, `reference`, `amount`, `currency`, `status`, `paystackResponse`, `createdAt`
- Add `VendorBankAccount` model: `id`, `vendorId`, `bankName`, `bankCode`, `accountNumber`, `accountName`, `currency`, `isDefault`, `paystackRecipientCode`, `createdAt`, `updatedAt`
- Add `User.trustScore` field (Int, default 50)

### Backend Tasks
1. Install Paystack SDK / create `src/lib/paystack.ts` client
2. Add env vars: `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`
3. Create `src/modules/paystack/` module:
   - `POST /api/paystack/initialize` — initialize payment (returns Paystack checkout URL or inline reference)
   - `POST /api/paystack/webhook` — receive Paystack webhook (verify signature, confirm payment)
   - `GET /api/paystack/verify/:reference` — manual verification fallback
4. Paystack webhook handler:
   - On `charge.success` → mark order `PAYMENT_SECURED`, notify vendor (push + SMS)
   - Record `PaystackTransaction`
5. Vendor notification: push via Expo + SMS fallback (new SMS provider or Paystack SMS)
6. Create migration + seed for testing

### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/paystack/initialize` | Buyer | Start Paystack payment for domestic order |
| POST | `/api/paystack/webhook` | Public | Paystack webhook receiver |
| GET | `/api/paystack/verify/:ref` | Buyer | Manual payment verification |

### Tests
- Paystack initialize returns valid reference
- Webhook with valid signature marks order PAYMENT_SECURED
- Invalid webhook signature rejected
- Vendor receives notification on PAYMENT_SECURED
- Order with escrowType=DOMESTIC_AFRICA uses Paystack flow

---

## Batch 2 — Vendor Confirmation & 48-Hour Timeout

**Goal:** Vendor confirms order within 48h or order auto-cancels with full refund.

### Backend Tasks
1. Add `POST /api/vendors/me/orders/:id/confirm` — vendor confirms order
   - Only works on `PAYMENT_SECURED` status
   - Sets `vendorConfirmedAt`, transitions to `VENDOR_CONFIRMED`
2. Add background job: `escrow-vendor-timeout`
   - Runs every 15 minutes
   - Finds orders with `status=PAYMENT_SECURED` and `createdAt` older than 48h
   - Auto-cancels: status → `CANCELLED`, triggers Paystack refund
   - Notifies buyer of cancellation
3. Paystack refund integration:
   - `POST /api/paystack/refund` (internal, called by timeout job)
   - Uses Paystack Refund API

### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/vendors/me/orders/:id/confirm` | Vendor | Confirm order within 48h |

### Tests
- Vendor can confirm PAYMENT_SECURED order
- Vendor cannot confirm other statuses
- Order auto-cancels after 48h with no confirmation
- Buyer is refunded on auto-cancel
- Refund creates PaystackTransaction record

---

## Batch 3 — Dispatch & Delivery OTP

**Goal:** Vendor marks dispatched. OTP generated. Displayed once. Buyer enters to confirm delivery.

### Database Changes
- Create `DeliveryOtp` model: `id`, `orderId` (unique), `codeHash`, `expiresAt`, `attempts`, `confirmedAt`, `createdAt`

### Backend Tasks
1. Add `POST /api/vendors/me/orders/:id/dispatch` — vendor marks order dispatched
   - Only works on `VENDOR_CONFIRMED` status
   - Generates 6-digit crypto OTP
   - Stores hash only in `DeliveryOtp`
   - Returns plain code in response (displayed once on vendor's screen)
   - Sets `escrowExpiresAt` = now + 24h
   - Transitions order to `DISPATCHED`
   - Notifies buyer: "Your order is on the way"
2. Add `POST /api/orders/:id/confirm-delivery` — buyer enters OTP
   - Validates: order is DISPATCHED, OTP not expired, attempts < 5
   - Compares hash
   - On success: order → `COMPLETED`, trigger payment release, buyer trust +2
   - On failure: increment attempts, return error
   - On 5th failure: lock (no more attempts until expiry/admin)
3. OTP security:
   - `crypto.randomInt(100000, 999999)` for generation
   - SHA-256 hash storage
   - Plain code ONLY in the HTTP response to vendor's dispatch call
   - Never logged, never stored in plain

### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/vendors/me/orders/:id/dispatch` | Vendor | Mark dispatched, get OTP |
| POST | `/api/orders/:id/confirm-delivery` | Buyer | Enter OTP to confirm receipt |

### Tests
- Dispatch generates OTP and returns plain code
- OTP is 6 digits
- Only hash stored in DB
- Correct OTP confirms delivery
- Wrong OTP rejected, attempts incremented
- 5 wrong attempts locks the code
- Expired OTP rejected
- Order transitions to COMPLETED on success
- Trust score +2 on OTP entry

---

## Batch 4 — 24-Hour Auto-Release

**Goal:** If buyer doesn't act within 24h of dispatch, payment releases to vendor automatically.

### Backend Tasks
1. Add background job: `escrow-auto-release`
   - Runs every 15 minutes
   - Finds orders with `status=DISPATCHED` and `escrowExpiresAt < now` and NOT disputed
   - Releases payment: triggers Paystack Transfer to vendor bank
   - Status → `COMPLETED`, set `autoReleasedAt`
   - Buyer trust score -1
   - Notifies vendor: "Payment released"
2. Paystack Transfer integration:
   - Create transfer recipient (vendor's bank details → Paystack recipient code)
   - Initiate transfer from Eki balance to recipient
   - Handle transfer webhook (`transfer.success`, `transfer.failed`)
3. Add `POST /api/vendors/me/bank-accounts` — vendor registers bank account
   - Validates with Paystack Resolve Account API
   - Creates Paystack transfer recipient
   - Stores `VendorBankAccount`
4. Add `GET /api/vendors/me/bank-accounts` — list bank accounts

### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/vendors/me/bank-accounts` | Vendor | Register bank account for payout |
| GET | `/api/vendors/me/bank-accounts` | Vendor | List registered bank accounts |

### Tests
- Auto-release fires after 24h
- Disputed orders are skipped
- Paystack Transfer initiated on release
- Vendor bank account validated with Paystack
- Buyer trust -1 on auto-release
- Transfer failure handled gracefully (retry or flag)

---

## Batch 5 — Dispute System

**Goal:** Buyer can raise a dispute before 24h expires. Escrow freezes. Admin resolves.

### Database Changes
- Create `Dispute` model: `id`, `orderId` (unique), `buyerId`, `vendorId`, `reason`, `status` (OPEN | RESOLVED_VENDOR | RESOLVED_BUYER | RESOLVED_PARTIAL), `resolution`, `resolvedById`, `resolvedAt`, `createdAt`, `updatedAt`

### Backend Tasks
1. Add `POST /api/orders/:id/dispute` — buyer opens dispute
   - Only works if order is `DISPATCHED` and within 24h window
   - Fails if buyer already entered OTP (transaction is final)
   - Sets order status → `DISPUTED`
   - Freezes auto-release (job skips disputed orders)
   - Notifies vendor + admin
   - Body: `{ reason: string }`
2. Add admin endpoints:
   - `GET /api/admin/disputes` — list disputes
   - `GET /api/admin/disputes/:id` — dispute detail
   - `PATCH /api/admin/disputes/:id/resolve` — resolve dispute
     - Body: `{ resolution: "vendor" | "buyer" | "partial", note: string, refundAmount?: number }`
     - "vendor" → release to vendor
     - "buyer" → full refund
     - "partial" → split (partial refund + partial release)
3. Trust score: -20 if admin marks dispute as fraudulent (add `fraudulent` flag)

### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/orders/:id/dispute` | Buyer | Raise a dispute |
| GET | `/api/admin/disputes` | Admin | List all disputes |
| GET | `/api/admin/disputes/:id` | Admin | Dispute detail |
| PATCH | `/api/admin/disputes/:id/resolve` | Admin | Resolve dispute |

### Tests
- Buyer can dispute DISPATCHED order
- Buyer cannot dispute after OTP entered
- Dispute freezes auto-release
- Admin can resolve in favour of vendor (payment released)
- Admin can resolve in favour of buyer (refund issued)
- Fraudulent dispute flags trust score -20
- Cannot dispute order older than 24h from dispatch

---

## Batch 6 — Buyer Trust Score & Restrictions

**Goal:** Track buyer behaviour. Restrict low-trust buyers.

### Backend Tasks
1. Trust score updates (already integrated in Batches 3-5):
   - +2 on OTP confirmation
   - -1 on auto-release
   - -20 on fraudulent dispute
2. Add `GET /api/auth/me` response includes `trustScore`
3. Add middleware/guard: `checkBuyerTrust`
   - Buyers below score 20 cannot use bank transfer (card only)
   - Buyers below score 10 are flagged for manual review on each order
4. Admin view:
   - `GET /api/admin/users` already returns users — add `trustScore` to response
   - `PATCH /api/admin/users/:id/trust-score` — manual adjustment

### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| PATCH | `/api/admin/users/:id/trust-score` | Admin | Manually adjust trust score |

### Tests
- Trust score starts at 50
- +2 applied on OTP confirm
- -1 applied on auto-release
- -20 applied on fraudulent dispute
- Low trust buyer blocked from bank transfer
- Admin can override trust score

---

## Batch 7 — Balance Monitoring & Operations

**Goal:** Ensure Eki's Paystack balance always covers outstanding escrow orders. Alert ops team if low.

### Backend Tasks
1. Add background job: `paystack-balance-check`
   - Runs daily (or every 6 hours)
   - Calls Paystack Balance API
   - Sums all outstanding escrow orders (PAYMENT_SECURED + VENDOR_CONFIRMED + DISPATCHED)
   - If balance < outstanding total → send alert email to ops team
   - Log to audit table
2. Add admin endpoint:
   - `GET /api/admin/escrow/health` — returns current balance vs outstanding
3. Add env var: `OPS_ALERT_EMAIL`

### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/escrow/health` | Admin | Balance vs outstanding orders |

### Tests
- Balance check correctly sums outstanding orders
- Alert fires when balance < threshold
- Health endpoint returns accurate data

---

## Batch 8 — SMS Notifications & Frontend Integration

**Goal:** Vendor receives SMS fallback for critical notifications. Frontend screens for the escrow flow.

### Backend Tasks
1. SMS provider integration (Termii, AfricasTalking, or Paystack SMS)
   - `src/lib/sms.ts` — send SMS
   - Fallback: if push notification delivery unconfirmed, send SMS
2. Key SMS events:
   - Vendor: "Payment Secured — prepare order" 
   - Vendor: "Payment Released"
   - Buyer: "Enter this code to confirm delivery" (NO — code is told verbally by rider, never sent electronically)
3. Frontend screens (Expo):
   - Buyer: domestic checkout with Paystack inline
   - Buyer: order detail with "Confirm Delivery" (OTP input)
   - Buyer: "I have a problem" button
   - Vendor: "Confirm Order" button
   - Vendor: "Mark Dispatched" → shows OTP code screen (display once)
   - Vendor: bank account setup
   - Admin: disputes list + resolve

### Tests
- SMS sends on PAYMENT_SECURED
- SMS sends on payment release
- OTP is NEVER sent via SMS to anyone (verify in code)

---

## Dependency Order

```
Batch 1 (Paystack + escrow foundation)
  ↓
Batch 2 (vendor confirm + 48h timeout)
  ↓
Batch 3 (dispatch + delivery OTP)
  ↓
Batch 4 (24h auto-release + Paystack Transfer)
  ↓
Batch 5 (disputes)
  ↓
Batch 6 (trust score)
  ↓
Batch 7 (balance monitoring)
  ↓
Batch 8 (SMS + frontend)
```

Batches 6, 7, and 8 can run in parallel once Batch 5 is done.

---
yes the same credentials i already sent it 


## Env Vars Required

| Variable | Description |
|----------|-------------|
| `PAYSTACK_SECRET_KEY` | Paystack API secret key |
| `PAYSTACK_PUBLIC_KEY` | Paystack publishable key (frontend) |
| `PAYSTACK_WEBHOOK_SECRET` | For webhook signature verification |
| `SMS_PROVIDER` | termii / africastalking |
| `SMS_API_KEY` | SMS provider API key |
| `SMS_SENDER_ID` | Sender name for SMS |
| `OPS_ALERT_EMAIL` | Email for balance alerts |
| `ESCROW_AUTO_RELEASE_HOURS` | Default 24 |
| `ESCROW_VENDOR_TIMEOUT_HOURS` | Default 48 |

---

## Estimated Scope Per Batch

| Batch | Files | Effort |
|-------|-------|--------|
| 1 — Paystack + foundation | ~10 new files, 3 modified | Large |
| 2 — Vendor confirm + timeout | ~4 new files, 2 modified | Medium |
| 3 — Dispatch + delivery OTP | ~5 new files, 2 modified | Medium |
| 4 — Auto-release + Transfer | ~4 new files, 3 modified | Medium-Large |
| 5 — Disputes | ~5 new files, 2 modified | Medium |
| 6 — Trust score | ~3 new files, 4 modified | Small |
| 7 — Balance monitoring | ~3 new files, 1 modified | Small |
| 8 — SMS + frontend | ~5 new files + frontend screens | Large |

---

## Risk Notes

1. **Paystack balance management** — If Eki runs out of balance, vendor payouts fail. This is the #1 operational risk.
2. **SMS reliability** — Nigerian SMS delivery can be unreliable. Push notification must be primary; SMS is fallback only.
3. **Rider fraud** — If the rider tells the code to the buyer before delivering goods, the buyer confirms and the rider runs. Mitigation: the vendor only shows the code when the rider physically collects the package.
4. **Vendor collusion** — Vendor marks dispatched without actually shipping. Buyer doesn't get goods but auto-release pays vendor in 24h. Mitigation: buyer must dispute within 24h. Trust score tracks repeat offenders.
5. **Currency handling** — NGN and GHS are separate Paystack accounts. Ensure correct routing per vendor country.
