# How the Backend Works

## Architecture
Express app → routes → controllers → services → Prisma → PostgreSQL (Neon)

## Request Flow
1. Request hits Vercel serverless function (`src/app.ts`)
2. Helmet adds security headers
3. CORS validated
4. Body parsed (raw for webhooks, JSON for everything else)
5. Rate limiter checks
6. Input length validation
7. Route matched → controller called
8. Controller validates input → calls service
9. Service executes business logic with Prisma
10. Response returned

## Authentication Flow
1. `POST /auth/register` or `/auth/login` → returns JWT
2. JWT contains: `sub` (userId), `role`, `email`, `tv` (tokenVersion)
3. `authenticate` middleware: verifies JWT → checks tokenVersion in DB → reads live role from DB
4. `requireRole(...)` middleware: checks `request.user.role`

## Payment Flow (Stripe)
1. Buyer: cart → `POST /payments/create-intent` → Stripe PaymentIntent created
2. Frontend: confirms payment with Stripe SDK
3. Stripe: sends `payment_intent.succeeded` webhook
4. Backend: marks orders PAID, credits vendor wallets, clears cart

## Payment Flow (Paystack Escrow)
1. Buyer: `POST /paystack/initialize` → Paystack checkout URL
2. Buyer: pays on Paystack
3. Paystack: sends `charge.success` webhook → order becomes PAYMENT_SECURED
4. Vendor: confirms within 48h → VENDOR_CONFIRMED
5. Vendor: dispatches → OTP generated (shown once)
6. Rider: delivers, tells buyer the code
7. Buyer: enters OTP → payment released to vendor

## Wallet Flow
1. Top-up: `POST /wallet/me/top-up` → Stripe PI → webhook credits wallet
2. Apply: checkout with `walletAmount` → atomic debit in transaction
3. Refund: webhook reverses credit, restores wallet if applicable

## Key Invariants
- Wallet balance can never go negative (DB CHECK + atomic updateMany)
- Stock can never go negative (DB CHECK + atomic updateMany WHERE stock >= qty)
- One webhook event = one processing (WebhookEvent unique constraint)
- Product currency = vendor currency (always, no override)
