# Marketplace Backend

Multi-vendor marketplace backend built with Node.js, Express, TypeScript, PostgreSQL, Prisma ORM, and Stripe.

## Features

- JWT-based authentication with three roles: `BUYER`, `VENDOR`, `ADMIN`
- Vendor profiles, verification status, payout methods
- Products with stock, images, category, weight
- Shopping cart with stock validation
- Delivery zones and delivery fee calculation
- **Multi-vendor** cart-based Stripe PaymentIntent checkout (subtotal + delivery + wallet deduction)
- Stripe webhook with signature verification, idempotency, wallet credit, and cancellation handling
- Admin order completion releasing vendor pending → available balance
- Buyer wallet (top-up via Stripe, apply to orders, referral bonuses)
- Promo codes with atomic redemption (race-condition safe)
- Reviews with rating validation (1–5, DB CHECK enforced)
- Referral system (bonus on first paid order, idempotent, self-referral guard)
- Subscription plans with product limits
- Rate limiting on auth and API endpoints
- Payout request flow (vendor request, admin approve / reject / mark-paid)
- In-app notifications for payment and payout lifecycle events
- Admin listing and moderation endpoints

## Tech Stack

Node.js, Express 4, TypeScript 5, Prisma 6, PostgreSQL, Stripe SDK, bcryptjs, jsonwebtoken.

## Project Structure

```text
prisma/
  migrations/
  schema.prisma
  seed.ts
src/
  app.ts
  server.ts
  config/
  lib/
  middlewares/
  modules/
    admin/
    auth/
    buyer-wallet/
    cart/
    delivery/
    health/
    notifications/
    orders/
    payments/
    payouts/
    products/
    promos/
    referrals/
    reviews/
    stripe/
    subscriptions/
    uploads/
    vendors/
  routes/
  shared/
  tests/
```

Business logic lives in services. Controllers and routes stay thin. All authenticated-user routes use the `authenticate` middleware; admin routes add `requireRole("ADMIN")`.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
NODE_ENV=development
PORT=4000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/marketplace?schema=public"
STRIPE_SECRET_KEY=sk_test_your_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
DEFAULT_CURRENCY=usd
PLATFORM_FEE_BPS=1000
JWT_SECRET=change_me_in_production
JWT_EXPIRES_IN=7d
```

- `JWT_SECRET`: required. Long random string used to sign access tokens.
- `JWT_EXPIRES_IN`: token lifetime (e.g. `7d`, `12h`). Default `7d`.
- `PLATFORM_FEE_BPS`: platform fee in basis points, `1000` = 10%. Applied to subtotal only (not delivery).
- `DEFAULT_CURRENCY`: currency used for new wallets and as fallback for products.
- `SENTRY_DSN`: optional. Sentry project DSN. When set, the centralized error handler captures 5xx and uncaught errors to Sentry. Leave empty to disable monitoring (local dev runs unaffected).
- `REDIS_URL`: optional. When set, BullMQ queues (`notifications`, `emails`, `payouts`) are initialized using this Redis instance. Leave empty in local dev to disable queueing — the app still runs without Redis. Use a managed Redis (Upstash, Redis Cloud, Railway, Render…) in production. Format: `redis://default:password@host:port` or `rediss://...` for TLS.

### `DATABASE_URL` on Vercel (Neon pooled connection)

On Vercel serverless, every warm Lambda instance keeps its own `PrismaClient`. To avoid exhausting Postgres connections you **must** point `DATABASE_URL` at the Neon **pooled** endpoint (the host contains `-pooler`):

```
postgresql://USER:PASS@ep-xxx-pooler.<region>.aws.neon.tech/<db>?sslmode=require&pgbouncer=true&connection_limit=1
```

- `pgbouncer=true` tells Prisma it is talking to PgBouncer (transaction-mode pooling).
- `connection_limit=1` keeps each Lambda using a single backend connection.
- For `prisma migrate` commands, set a separate `DIRECT_URL` to the unpooled Neon endpoint (host without `-pooler`) and add `directUrl = env("DIRECT_URL")` in `prisma/schema.prisma` if you run migrations from CI/Vercel.

The Prisma client is created once per worker via a `globalThis` singleton in `src/lib/prisma.ts`, so no new client is ever instantiated per request.

## Setup

```bash
npm install
cp .env.example .env     # or: Copy-Item .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

The seed creates one buyer, one vendor owner, one vendor, one wallet, and one product. Default seed password is `password123`.

## Money

All monetary values are stored as integer cents (`Int` in Prisma). API request/response amounts (`priceAmount`, `amount`, `baseFeeAmount`, `feePerKgAmount`, `subtotalAmount`, `deliveryAmount`, `totalAmount`) are also integer cents.

## API Overview

All routes are prefixed with `/api`. Auth is `Bearer <JWT>` in the `Authorization` header unless noted.

### Auth (public)

- `POST /auth/register` — `{ email, password, name }`. Always creates a `BUYER`. Returns `{ user, token }`.
- `POST /auth/login` — `{ email, password }` → `{ user, token }`.
- `GET /auth/me` — current user (auth).

### Vendors (auth)

- `POST /vendors` — create own vendor profile; creates the vendor's wallet and promotes a `BUYER` → `VENDOR` (admins keep their role).
- `GET /vendors/me` — own profile with wallet.
- `PATCH /vendors/me` — partial profile update.
- `POST /vendors/me/payout-methods` — `{ type, label?, details, isDefault? }`.
- `GET /vendors/me/payout-methods`.

### Products

- `GET /products?category=&vendorId=&limit=&cursor=` (public) — list active products.
- `GET /products/:id` (public) — 404 if missing or inactive.
- `POST /products` (VENDOR) — `{ title, description?, priceAmount, currency?, images?, category?, stock?, weightGrams? }`.
- `PATCH /products/:id` (VENDOR, owner) — partial update. Supports toggling `isActive`.
- `DELETE /products/:id` (VENDOR, owner) — soft-disable.

### Cart (auth)

Cart is per user, supports multiple vendors, and validates stock.

- `GET /cart` — returns (auto-creating if missing).
- `POST /cart/items` — `{ productId, quantity }`.
- `PATCH /cart/items/:id` — `{ quantity }`.
- `DELETE /cart/items/:id`.
- `DELETE /cart` — clear all items.

### Delivery (auth)

- `POST /delivery/calculate` — `{ cartId, destinationZoneId }` → `{ subtotalAmount, deliveryAmount, totalAmount, totalWeightGrams, currency }`. `deliveryAmount = baseFeeAmount + ceil(totalWeightGrams / 1000) * feePerKgAmount`.

### Payments (auth)

- `POST /payments/create-intent` - `{ cartId, destinationZoneId | deliveryCountry, walletAmount? }` returns `{ checkoutId, orderIds, amount, currency, clientSecret }`. Creates one checkout, one order/payment per vendor, reserves stock, optionally debits buyer wallet, and creates a Stripe PaymentIntent for the remaining amount.

For Stripe-paid checkouts, the cart is cleared after the webhook marks payment successful. For fully wallet-paid checkouts, the cart is cleared inside the checkout transaction.

### Stripe Webhook (public, signature-verified)

- `POST /stripe/webhook` - handles `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, wallet top-up success, and basic dispute logging. It verifies the signature, dedupes on `WebhookEvent.stripeEventId`, credits vendor pending balances through `PAYMENT_PENDING_CREDIT` ledger rows, restores stock/wallet deductions on failed or canceled checkouts, clears the buyer cart on success, and emits notifications.

### Payout Requests

- `POST /payout-requests` (VENDOR) — `{ payoutMethodId, amount, notes? }` — validates amount ≤ `wallet.availableBalance`.
- `GET /payout-requests/me` (VENDOR) — list own.

### Admin (ADMIN role)

- `GET /admin/users?role=&limit=&cursor=`
- `GET /admin/vendors?status=&limit=&cursor=`
- `GET /admin/products?isActive=&limit=&cursor=`
- `GET /admin/orders?status=&limit=&cursor=`
- `GET /admin/payments?status=&limit=&cursor=`
- `GET /admin/wallet-transactions?type=&vendorId=&limit=&cursor=`
- `PATCH /admin/vendors/:id/approve` / `PATCH /admin/vendors/:id/reject`
- `PATCH /admin/products/:id/approve` / `PATCH /admin/products/:id/disable`
- `PATCH /admin/orders/:id/complete` — PAID → COMPLETED, releases `pendingBalance` → `availableBalance` with a `PENDING_TO_AVAILABLE` ledger row. Protected against duplicate release by the `WalletTransaction(vendorId, orderId, paymentId, type)` unique constraint.
- `GET /admin/payout-requests?status=`
- `PATCH /admin/payout-requests/:id/approve`
- `PATCH /admin/payout-requests/:id/reject` — `{ reason? }`
- `PATCH /admin/payout-requests/:id/mark-paid` — APPROVED → PAID, creates `PAYOUT_DEBIT`, debits `availableBalance`. Protected against duplicate processing by the `WalletTransaction(payoutRequestId, type)` unique constraint.

### Notifications (auth)

- `GET /notifications?limit=&cursor=&unreadOnly=true` — list current user's notifications.
- `PATCH /notifications/:id/read` — mark read (idempotent).

Notification types: `ORDER_PAID`, `BALANCE_CREDITED`, `PAYOUT_REQUESTED`, `PAYOUT_APPROVED`, `PAYOUT_REJECTED`, `PAYOUT_PAID`.

## Money Flow

1. Buyer adds items to cart (single vendor enforced).
2. `POST /payments/create-intent` with `cartId` and `destinationZoneId`:
   - `subtotalAmount = Σ priceInCents * quantity`
   - `deliveryFeeAmount = baseFee + ceil(weightKg) * feePerKg`
   - `totalAmount = subtotalAmount + deliveryFeeAmount`
   - `platformFeeAmount = round(subtotal * PLATFORM_FEE_BPS / 10000)`
   - `vendorEarningsAmount = subtotalAmount - platformFeeAmount` (vendor does not receive delivery fees)
   - Stripe PaymentIntent created for `totalAmount`.
3. Stripe → webhook → Payment SUCCEEDED, Order PAID, `pendingBalance += vendorEarningsAmount`, cart cleared, `ORDER_PAID` + `BALANCE_CREDITED` notifications.
4. Admin marks order `COMPLETED` → `pendingBalance -= amount`, `availableBalance += amount`, `PENDING_TO_AVAILABLE` ledger row.
5. Vendor requests payout (≤ availableBalance). Admin approves, then marks paid → `availableBalance -= amount`, `PAYOUT_DEBIT` ledger row.

## Idempotency & Concurrency Safeguards

- `WebhookEvent.stripeEventId` unique — dedupes Stripe retries.
- `WalletTransaction @@unique([vendorId, orderId, paymentId, type])` — one `PAYMENT_PENDING_CREDIT` and one `PENDING_TO_AVAILABLE` per order.
- `WalletTransaction @@unique([payoutRequestId, type])` — one `PAYOUT_DEBIT` per payout request.
- Payout state transitions use `updateMany` with `where: { status: ... }` to reject concurrent writes.
- All multi-write operations (vendor create, cart mutations, payment intent, webhook, order complete, payout mark-paid) run inside `prisma.$transaction`.

## Validation

Every endpoint validates its input in a `*.validation.ts` file and throws `AppError` on bad input. JSON bodies are parsed by Express except the Stripe webhook which uses `express.raw`.

## Build / Verify

```bash
npm run prisma:generate
npm run build
```

Both commands currently exit clean.

## Known Limitations

- No refunds endpoint (manual via Stripe dashboard).
- No automatic Stripe Connect payouts — payouts are marked paid manually by an admin.
- No real-time delivery tracking (push / websocket).

## Security Hardening

The following security measures have been applied across four phases:

### Phase 1 — Critical Financial Safety
- Wallet top-up via Stripe PaymentIntent (no direct credit)
- Wallet apply race condition fixed with conditional `updateMany`
- Webhook permanent failures → `IGNORED` + 200
- `payment_intent.canceled` handler with wallet restore
- R2/S3 upload config hardened (content type allowlist, max file size)
- `BuyerWallet.balance >= 0` CHECK constraint

### Phase 2 — High Financial/Security
- Promo code redemption: atomic `UPDATE WHERE usedCount < maxUses` (raw SQL)
- Review rating: `BETWEEN 1 AND 5` CHECK constraint
- Referral reward: credited only on first paid order, transactional, idempotent, and capped per referrer over a rolling 30-day window
- Fully wallet-paid checkout: vendor pending wallet credits + ledger rows are created in the checkout transaction
- Verification uploads: disabled until private storage is implemented, preventing KYC documents from using the public bucket
- Stripe `automatic_payment_methods: { enabled: true }` (replaces `payment_method_types`)
- Stripe API version pinned to `2025-08-27.basil`
- Auth middleware loads role from DB (not JWT) on every request
- Bcrypt rounds 10→12 with opportunistic rehash on login

### Phase 3 — Data Integrity
- DB CHECK constraints on all money/stock/quantity columns
- Currency validation at service level (`eur`, `usd`, `gbp`)

### Phase 4 — Cleanup
- Dead code removed (`assertSingleVendor`, unused `creditReferralBonus`)
- `AppError.code` field for machine-readable error codes
- README updated
