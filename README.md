# Marketplace Payments Backend

Backend-only paid test task for a multi-vendor marketplace payment foundation using Node.js, Express, TypeScript, PostgreSQL, Prisma ORM, and Stripe.

## Scope

Implemented:
- PaymentIntent creation
- Order creation
- Stripe webhook verification and handling
- Wallet pending balance updates
- Wallet ledger transaction recording
- Webhook idempotency protection

Not implemented:
- Payout execution
- Refunds
- Authentication and authorization
- Frontend
- Admin dashboard
- Multi-vendor checkout in a single order

Manual payout execution is not implemented, but the wallet and ledger foundation is ready for it through `Wallet.availableBalance`, `Wallet.pendingBalance`, and `WalletTransaction`.

## Tech Stack

- Node.js
- Express
- TypeScript
- PostgreSQL
- Prisma ORM
- Stripe SDK

## Project Structure

```text
prisma/
  migrations/
  schema.prisma
  seed.ts
src/
  config/
  lib/
  middlewares/
  modules/
    health/
    orders/
    payments/
    stripe/
  routes/
  shared/
```

## Architecture

- `modules/payments`: creates orders, order items, payment records, and Stripe PaymentIntents
- `modules/stripe`: verifies Stripe webhooks and applies payment success side effects
- `lib/prisma.ts`: shared Prisma client
- `lib/stripe.ts`: shared Stripe client
- `middlewares`: centralized error handling and 404 handling
- `shared/errors`: reusable application error class
- `shared/utils`: async route wrapper

The code keeps business logic in services and keeps controllers/routes thin.

## Data Model Summary

- `User`: buyer or vendor owner
- `Vendor`: seller profile linked to a user
- `Product`: vendor-owned sellable item
- `Order`: checkout record with `PENDING`, `PAID`, or `FAILED`
- `OrderItem`: product snapshot inside an order
- `Payment`: Stripe payment state and amount breakdown
- `Wallet`: vendor wallet with `pendingBalance` and `availableBalance`
- `WalletTransaction`: immutable wallet ledger entry linked to vendor, order, and payment
- `WebhookEvent`: Stripe event tracking for idempotency

## Environment Variables

Copy `.env.example` to `.env` and update values.

```env
NODE_ENV=development
PORT=4000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/marketplace_payments?schema=public"
STRIPE_SECRET_KEY=sk_test_your_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
DEFAULT_CURRENCY=usd
PLATFORM_FEE_BPS=1000
```

Explanation:
- `NODE_ENV`: runtime mode
- `PORT`: HTTP server port
- `DATABASE_URL`: PostgreSQL connection string used by Prisma
- `STRIPE_SECRET_KEY`: Stripe secret API key
- `STRIPE_WEBHOOK_SECRET`: secret from Stripe CLI or Stripe dashboard webhook endpoint
- `DEFAULT_CURRENCY`: fallback currency, currently expected to be `usd`
- `PLATFORM_FEE_BPS`: platform fee in basis points, `1000` = `10%`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Update `.env` with your PostgreSQL and Stripe values.

4. Generate Prisma client:

```bash
npm run prisma:generate
```

5. Run migrations:

```bash
npm run prisma:migrate
```

6. Seed sample data:

```bash
npm run prisma:seed
```

The seed creates:
- one buyer
- one vendor owner
- one vendor
- one wallet
- one sample product

7. Start the API:

```bash
npm run dev
```

## API Endpoints

### Health Check

`GET /api/health`

### Create PaymentIntent

`POST /api/payments/create-intent`

Request body:

```json
{
  "buyerId": "buyer_user_id",
  "items": [
    {
      "productId": "product_id",
      "quantity": 1
    }
  ]
}
```

Rules:
- buyer must exist
- items cannot be empty
- quantity must be greater than `0`
- products must exist and be active
- all products must belong to a single vendor

## Sample cURL Request

```bash
curl -X POST http://localhost:4000/api/payments/create-intent \
  -H "Content-Type: application/json" \
  -d '{
    "buyerId": "buyer_user_id",
    "items": [
      {
        "productId": "product_id",
        "quantity": 1
      }
    ]
  }'
```

PowerShell example:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/payments/create-intent" `
  -ContentType "application/json" `
  -Body '{
    "buyerId": "buyer_user_id",
    "items": [
      {
        "productId": "product_id",
        "quantity": 1
      }
    ]
  }'
```

Expected response example:

```json
{
  "orderId": "cm_order_id",
  "paymentId": "cm_payment_id",
  "amount": 4999,
  "currency": "usd",
  "clientSecret": "pi_3Nx..._secret_abc123"
}
```

### Stripe Webhook

`POST /api/stripe/webhook`

This endpoint expects the raw request body and verifies the `stripe-signature` header using `STRIPE_WEBHOOK_SECRET`.

Handled event:
- `payment_intent.succeeded`

## Payment Flow

1. Client sends `buyerId` and line items to `POST /api/payments/create-intent`.
2. Backend validates the buyer, products, quantities, single-vendor rule, and currency consistency.
3. Backend calculates:
   - subtotal
   - platform fee
   - vendor earnings
4. Backend creates:
   - `Order` with `PENDING`
   - `OrderItem` rows
   - `Payment` with `PENDING`
5. Backend creates a Stripe PaymentIntent with metadata:
   - `orderId`
   - `paymentId`
   - `buyerId`
   - `vendorId`
6. Backend returns `clientSecret` for client-side confirmation.
7. Stripe sends `payment_intent.succeeded` webhook.
8. Backend verifies the signature and processes the webhook atomically.
9. Backend marks:
   - `Payment` as `SUCCEEDED`
   - `Order` as `PAID`
10. Backend creates a `WalletTransaction` ledger record and increments vendor `pendingBalance`.

## Wallet and Ledger Explanation

The wallet system is ledger-based.

- `Wallet.pendingBalance`: money earned from successful payments but not yet paid out
- `Wallet.availableBalance`: reserved for future payout release logic
- `WalletTransaction`: immutable transaction history for wallet changes

For a successful payment:
- one `WalletTransaction` of type `PAYMENT_PENDING_CREDIT` is created
- the vendor wallet `pendingBalance` is incremented by `vendorEarningsAmount`

This keeps balance derivation auditable and makes future payout integration straightforward.

## Webhook Idempotency

The webhook is safe against duplicate Stripe delivery.

Protection layers:
- `WebhookEvent.stripeEventId` is unique
- `WalletTransaction` has a unique constraint on `(vendorId, orderId, paymentId, type)`
- payment success handling exits safely if payment is already `SUCCEEDED`

This prevents duplicate vendor wallet credits.

## Stripe CLI Local Testing

1. Start the app:

```bash
npm run dev
```

2. Start Stripe listener and copy the webhook secret into `.env`:

```bash
stripe listen --forward-to localhost:4000/api/stripe/webhook
```

3. In another terminal, trigger a test webhook:

```bash
stripe trigger payment_intent.succeeded
```

Note:
- `stripe trigger payment_intent.succeeded` sends a generic test event
- for a full end-to-end local test, first create a real PaymentIntent through `/api/payments/create-intent`, then confirm that PaymentIntent using Stripe test flows so the webhook metadata matches your stored payment and order records

## API Testing Notes

- Run the seed script and use the generated buyer/product IDs
- Create a payment intent through the API
- Confirm the Stripe PaymentIntent in test mode
- Verify in the database:
  - `Payment.status = SUCCEEDED`
  - `Order.status = PAID`
  - `Wallet.pendingBalance` increased
  - `WalletTransaction` created once
  - `WebhookEvent` stored once

## Known Limitations

- Only one vendor is allowed per order
- No automatic release from `pendingBalance` to `availableBalance`
- No payout execution
- No refund support
- No payment failure webhook handling yet
- No authentication or authorization
- No inventory management
- No tax or shipping calculation
- `stripe trigger payment_intent.succeeded` alone is not enough for a true end-to-end happy path unless the event metadata matches an existing payment created by this backend

## Verification

Run:

```bash
npm run prisma:generate
npm run build
```
