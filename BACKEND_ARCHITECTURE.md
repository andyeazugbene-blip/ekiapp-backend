# Eki Marketplace — Complete Backend Architecture

> Generated after Phases 1–8 implementation — May 2026

---

## 1. Overview

| Aspect | Detail |
|--------|--------|
| **Framework** | Express 4 (TypeScript) |
| **Runtime** | Node.js (tsx dev, tsc build) |
| **Database** | PostgreSQL via Prisma ORM |
| **Payments** | Stripe (PaymentIntents, Checkout Sessions, Webhooks) |
| **Auth** | JWT (jsonwebtoken + bcryptjs) |
| **Queue** | BullMQ + Redis (optional, graceful fallback) |
| **Email** | Resend (transactional emails) |
| **Monitoring** | Sentry (optional) |
| **Security** | Helmet, CORS, Redis rate-limiting, input validation |
| **Deployment** | Vercel Serverless Functions |
| **API Docs** | Swagger UI at `/api/docs` |

---

## 2. Project Structure

```
├── api/
│   └── index.ts                    # Vercel serverless entrypoint
├── prisma/
│   ├── schema.prisma               # Full database schema
│   ├── seed.ts                     # Dev seed data
│   └── migrations/                 # 8 sequential migrations
├── src/
│   ├── app.ts                      # Express app (middleware stack)
│   ├── server.ts                   # Server entry + worker bootstrap
│   ├── config/
│   │   └── env.ts                  # Env var loading + validation
│   ├── lib/
│   │   ├── prisma.ts               # PrismaClient singleton
│   │   ├── redis.ts                # Redis connection (lazy, optional)
│   │   ├── stripe.ts               # Stripe SDK instance
│   │   ├── email.ts                # Resend client wrapper
│   │   ├── email-templates.ts      # HTML email templates
│   │   ├── email-queue.ts          # enqueueEmail() helper
│   │   ├── logger.ts               # Structured JSON logger
│   │   ├── sentry.ts               # Sentry init (optional)
│   │   └── swagger.ts              # OpenAPI 3.0 spec
│   ├── middlewares/
│   │   ├── authenticate.ts         # JWT verify + role guard
│   │   ├── error-handler.ts        # Global error handler
│   │   ├── not-found.ts            # 404 catch-all
│   │   ├── rate-limit.ts           # Redis-backed rate limiters
│   │   └── validate-input-length.ts # Input size/depth validation
│   ├── modules/
│   │   ├── addresses/              # Buyer address CRUD
│   │   ├── admin/                  # Admin dashboard, listings, moderation
│   │   ├── auth/                   # Register, login, profile, password reset
│   │   ├── buyer-wallet/           # Buyer wallet, top-up, apply
│   │   ├── cart/                   # Shopping cart (single-vendor)
│   │   ├── delivery/              # Fee calculator + zone management
│   │   ├── health/                 # Health check
│   │   ├── messages/               # Conversations + messaging
│   │   ├── notifications/          # In-app notifications
│   │   ├── orders/                 # Buyer/vendor order management
│   │   ├── payments/               # Stripe PaymentIntent creation
│   │   ├── payouts/                # Vendor payout requests
│   │   ├── products/               # Product CRUD
│   │   ├── promos/                 # Promo code validation + admin CRUD
│   │   ├── referrals/              # Referral system
│   │   ├── shipments/              # Shipment tracking
│   │   ├── stripe/                 # Webhook handler
│   │   ├── subscriptions/          # Vendor subscription plans
│   │   ├── uploads/                # File upload URL generation
│   │   ├── vendors/                # Vendor profile + dashboard
│   │   └── verification/           # KYC document submission
│   ├── queues/
│   │   └── index.ts                # BullMQ queue declarations
│   ├── routes/
│   │   └── index.ts                # Route aggregator
│   ├── shared/
│   │   ├── errors/app-error.ts     # Custom AppError class
│   │   ├── utils/async-handler.ts  # Express async wrapper
│   │   ├── utils/audit.ts          # Audit log helper
│   │   └── pricing.ts             # Pure pricing functions
│   └── workers/
│       ├── index.ts                # Worker bootstrap
│       ├── notifications.worker.ts # Notification queue processor
│       ├── emails.worker.ts        # Email queue processor (Resend)
│       ├── stock-alerts.worker.ts  # Low stock alerts (every 6h)
│       └── cart-cleanup.worker.ts  # Abandoned order cleanup (every 15m)
└── package.json
```


---

## 3. All API Endpoints

All routes prefixed with `/api`.

### Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Register buyer (rate-limited) |
| POST | `/auth/login` | — | Login (rate-limited) |
| GET | `/auth/me` | Yes | Get current user profile |
| PATCH | `/auth/me` | Yes | Update profile (name, phone, avatar, country) |
| POST | `/auth/forgot-password` | — | Request password reset email |
| POST | `/auth/reset-password` | — | Reset password with token |

### Vendors
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/vendors` | Yes | Create vendor profile (promotes BUYER→VENDOR) |
| GET | `/vendors/me` | Yes | Get own vendor profile + wallet |
| PATCH | `/vendors/me` | Yes | Update vendor profile |
| GET | `/vendors/me/dashboard` | VENDOR | Aggregated dashboard stats |
| GET | `/vendors/me/earnings` | VENDOR | Earnings breakdown + recent payouts |
| POST | `/vendors/me/payout-methods` | VENDOR | Create payout method |
| GET | `/vendors/me/payout-methods` | VENDOR | List payout methods |
| POST | `/vendors/me/verification` | VENDOR | Submit KYC document |
| GET | `/vendors/me/verification` | VENDOR | Get verification status |
| GET | `/vendors/me/orders` | VENDOR | List orders with vendor's items |
| GET | `/vendors/me/orders/:id` | VENDOR | Get order detail |
| PATCH | `/vendors/me/orders/:id/status` | VENDOR | Update order status |

### Products
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/products` | — | List active products (paginated) |
| GET | `/products/:id` | — | Get product by ID |
| POST | `/products` | VENDOR (verified) | Create product |
| PATCH | `/products/:id` | VENDOR | Update own product |
| DELETE | `/products/:id` | VENDOR | Soft-disable own product |

### Cart
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/cart` | Yes | Get/create cart |
| POST | `/cart/items` | Yes | Add item |
| PATCH | `/cart/items/:id` | Yes | Update quantity |
| DELETE | `/cart/items/:id` | Yes | Remove item |
| DELETE | `/cart` | Yes | Clear cart |

### Delivery
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/delivery/zones` | — | List active delivery zones (public) |
| POST | `/delivery/calculate` | Yes | Quote delivery fee |
| GET | `/delivery/zones/me` | VENDOR | List vendor's own zones |
| POST | `/delivery/zones/me` | VENDOR | Create delivery zone |
| PATCH | `/delivery/zones/me/:id` | VENDOR | Update zone |
| DELETE | `/delivery/zones/me/:id` | VENDOR | Delete zone |
| POST | `/delivery/zones/me/:zoneId/methods` | VENDOR | Add delivery method |
| PATCH | `/delivery/methods/:id` | VENDOR | Update delivery method |
| DELETE | `/delivery/methods/:id` | VENDOR | Delete delivery method |

### Orders
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/orders/me` | Yes | List buyer's own orders (paginated) |
| GET | `/orders/:id` | Yes | Get order detail (buyer ownership) |

### Payments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/payments/create-intent` | Yes | Create order + Stripe PaymentIntent |

### Shipments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/shipments` | VENDOR | List vendor's shipments |
| POST | `/shipments/orders/:orderId` | VENDOR | Create shipment for order |
| PATCH | `/shipments/:id` | VENDOR | Update shipment status/tracking |
| GET | `/shipments/orders/:orderId` | BUYER/VENDOR | Get shipment by order |

### Payout Requests
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/payout-requests` | VENDOR | Create payout request |
| GET | `/payout-requests/me` | VENDOR | List own payout requests |

### Buyer Wallet
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/wallet/me` | Yes | Get wallet balance |
| GET | `/wallet/me/transactions` | Yes | List wallet transactions |
| POST | `/wallet/me/top-up` | Yes | Top up wallet |
| POST | `/wallet/me/apply` | Yes | Apply wallet to order |

### Promo Codes
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/promo-codes/validate` | Yes | Validate promo code |

### Referrals
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/referrals/me` | Yes | Get referral code + stats |

### Subscriptions
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/subscriptions/plans` | — | List available plans |
| GET | `/subscriptions/me` | VENDOR | Get current subscription |
| GET | `/subscriptions/me/limits` | VENDOR | Get plan limits |
| POST | `/subscriptions/checkout` | VENDOR | Create Stripe Checkout for upgrade |
| POST | `/subscriptions/cancel` | VENDOR | Cancel subscription |

### Notifications
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/notifications` | Yes | List notifications (paginated) |
| PATCH | `/notifications/:id/read` | Yes | Mark as read |

### Conversations (Messaging)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/conversations` | Yes | List conversations |
| POST | `/conversations` | Yes | Create/get conversation |
| GET | `/conversations/:id/messages` | Yes | List messages |
| POST | `/conversations/:id/messages` | Yes | Send message |
| PATCH | `/conversations/:id/read` | Yes | Mark conversation read |

### Addresses
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/addresses` | Yes | List saved addresses |
| POST | `/addresses` | Yes | Create address |
| PATCH | `/addresses/:id` | Yes | Update address |
| DELETE | `/addresses/:id` | Yes | Delete address |

### Uploads
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/uploads/request-url` | Yes | Get upload URL for file |

### Stripe Webhook
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/stripe/webhook` | Signature | Stripe webhook handler |

### Admin (all require ADMIN role)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/dashboard` | KPI dashboard |
| GET | `/admin/analytics` | Revenue trends, top vendors, growth |
| GET | `/admin/audit-logs` | Audit trail (paginated, filterable) |
| GET | `/admin/users` | List users |
| GET | `/admin/vendors` | List vendors |
| GET | `/admin/products` | List products |
| GET | `/admin/orders` | List orders |
| GET | `/admin/payments` | List payments |
| GET | `/admin/wallet-transactions` | List wallet ledger |
| PATCH | `/admin/vendors/:id/approve` | Approve vendor |
| PATCH | `/admin/vendors/:id/reject` | Reject vendor |
| PATCH | `/admin/vendors/:id/suspend` | Suspend vendor (disables products) |
| PATCH | `/admin/vendors/:id/unsuspend` | Unsuspend vendor |
| PATCH | `/admin/products/:id/approve` | Approve product |
| PATCH | `/admin/products/:id/disable` | Disable product |
| PATCH | `/admin/orders/:id/complete` | Complete order (release funds) |
| GET | `/admin/payout-requests` | List payout requests |
| PATCH | `/admin/payout-requests/:id/approve` | Approve payout |
| PATCH | `/admin/payout-requests/:id/reject` | Reject payout |
| PATCH | `/admin/payout-requests/:id/mark-paid` | Mark payout paid |
| GET | `/admin/verification-documents` | List pending KYC docs |
| PATCH | `/admin/verification-documents/:id/review` | Approve/reject document |
| GET | `/admin/delivery-zones` | List all delivery zones |
| POST | `/admin/delivery-zones` | Create global delivery zone |
| PATCH | `/admin/delivery-zones/:id` | Update delivery zone |
| DELETE | `/admin/delivery-zones/:id` | Delete delivery zone |
| GET | `/admin/promo-codes` | List promo codes |
| POST | `/admin/promo-codes` | Create promo code |
| PATCH | `/admin/promo-codes/:id` | Update promo code |


---

## 4. Database Models & Relationships

### Enums

| Enum | Values |
|------|--------|
| `UserRole` | BUYER, VENDOR, ADMIN |
| `OrderStatus` | PENDING, PAID, CONFIRMED, PROCESSING, DISPATCHED, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED, REFUNDED, FAILED |
| `PaymentStatus` | PENDING, SUCCEEDED, FAILED |
| `WalletTransactionType` | PAYMENT_PENDING_CREDIT, PENDING_TO_AVAILABLE, PAYOUT_DEBIT, ADJUSTMENT_CREDIT, ADJUSTMENT_DEBIT |
| `WebhookEventStatus` | PROCESSING, PROCESSED, IGNORED |
| `PayoutRequestStatus` | PENDING, APPROVED, REJECTED, PAID |
| `VendorVerificationStatus` | PENDING, VERIFIED, REJECTED |
| `PayoutMethodType` | BANK_TRANSFER, MOBILE_MONEY, WISE, PAYONEER, OTHER |
| `NotificationType` | ORDER_PAID, BALANCE_CREDITED, PAYOUT_REQUESTED, PAYOUT_APPROVED, PAYOUT_REJECTED, PAYOUT_PAID |
| `ConversationType` | BUYER_VENDOR, ADMIN_VENDOR, DISPUTE |
| `VerificationDocType` | GOVERNMENT_ID, BUSINESS_REGISTRATION |
| `VerificationDocStatus` | PENDING, APPROVED, REJECTED |
| `ShipmentStatus` | PROCESSING, IN_TRANSIT, DELIVERED, DELAYED |
| `BuyerWalletTxType` | TOP_UP, REFERRAL_BONUS, ORDER_DEBIT, REFUND_CREDIT, WITHDRAWAL |
| `PromoType` | PERCENTAGE, FIXED_AMOUNT |
| `SubscriptionPlan` | FREE, BASIC, PREMIUM |
| `SubscriptionStatus` | ACTIVE, CANCELLED, EXPIRED, PAST_DUE |

### Models

| Model | Purpose |
|-------|---------|
| **User** | All platform users (email, password, role, phone, avatar, country, referralCode) |
| **Vendor** | Seller profile (storeName, city, country, verificationStatus, isSuspended) |
| **Product** | Marketplace listing (priceInCents, stock, weightGrams, isActive) |
| **Cart** | Buyer shopping cart (single-vendor lock) |
| **CartItem** | Cart line item (productId + quantity) |
| **Order** | Purchase record (orderNumber, status, amounts, deliveredAt) |
| **OrderItem** | Order line item (vendorId, quantity, amounts) |
| **Payment** | Stripe payment (platformFeeAmount, vendorEarningsAmount) |
| **Wallet** | Vendor balance (pendingBalance, availableBalance) |
| **WalletTransaction** | Vendor wallet ledger entry |
| **DeliveryZone** | Shipping zone (country, fees, vendorId for vendor-specific) |
| **DeliveryMethod** | Shipping option per zone (Standard/Express/Economy) |
| **Shipment** | Order tracking (trackingNumber, carrier, status) |
| **PayoutMethod** | Vendor withdrawal method (bank, mobile money, Wise, etc.) |
| **PayoutRequest** | Withdrawal request lifecycle |
| **Notification** | In-app notification |
| **Conversation** | Chat thread (participantA, participantB, orderId) |
| **Message** | Chat message (text, attachments, readAt) |
| **VerificationDocument** | KYC document (frontUrl, backUrl, status) |
| **BuyerAddress** | Saved delivery address |
| **BuyerWallet** | Buyer balance (top-up, referral bonuses) |
| **BuyerWalletTransaction** | Buyer wallet ledger |
| **PromoCode** | Discount code (percentage or fixed, limits, validity) |
| **PromoRedemption** | One-per-buyer redemption record |
| **Referral** | Referrer→referred relationship + bonus tracking |
| **VendorSubscription** | Subscription plan (Stripe Billing integration) |
| **PasswordResetToken** | Password reset tokens (1h expiry) |
| **WebhookEvent** | Stripe webhook idempotency guard |
| **AuditLog** | Admin action audit trail |

---

## 5. Auth & RBAC

### Authentication Flow
1. Register → bcrypt hash → JWT returned
2. Login → credentials verified → JWT returned
3. JWT payload: `{ sub: userId, role, email }`
4. Protected routes: `authenticate` middleware extracts Bearer token
5. Role guard: `requireRole(...roles)` checks `req.user.role`

### Roles & Permissions

| Role | Can Do |
|------|--------|
| **BUYER** | Browse, cart, checkout, pay, view own orders, wallet, messages, addresses, referrals |
| **VENDOR** | All buyer + products, orders, dashboard, earnings, shipments, delivery zones, payouts, verification, subscriptions |
| **ADMIN** | Everything + user/vendor/product moderation, analytics, audit logs, promo codes, delivery zone CRUD, payout management |

### Key Rules
- All users register as BUYER
- Creating vendor profile promotes BUYER → VENDOR
- Only VERIFIED vendors can create products
- Suspended vendors have all products disabled
- Admin role is manual (seed or direct DB)


---

## 6. Order Lifecycle

```
BUYER adds items to cart (single-vendor enforced)
  │
  ▼
POST /delivery/calculate → delivery quote
  │
  ▼
POST /payments/create-intent { cartId, destinationZoneId }
  │ ┌─ Stock decremented
  │ ├─ Order created (PENDING, orderNumber: EKI-2026-XXXXXX)
  │ ├─ Payment created (PENDING)
  │ └─ Stripe PaymentIntent → clientSecret returned
  ▼
FRONTEND confirms with Stripe.js
  │
  ▼
STRIPE webhook: payment_intent.succeeded
  │ ┌─ Payment → SUCCEEDED
  │ ├─ Order → PAID
  │ ├─ Vendor wallet pendingBalance credited
  │ ├─ Cart cleared
  │ └─ Notifications sent (buyer + vendor)
  ▼
VENDOR updates status:
  PAID → CONFIRMED → PROCESSING → DISPATCHED
  │
  ▼
VENDOR creates shipment (tracking number, carrier)
  │
  ▼
Shipment: IN_TRANSIT → DELIVERED
  │
  ▼
ADMIN completes order:
  │ ├─ Order → COMPLETED
  │ ├─ pendingBalance → availableBalance
  │ └─ Vendor can now request payout
  ▼
VENDOR requests payout → ADMIN approves → marks paid

FAILURE PATH:
  payment_intent.payment_failed → Payment FAILED, Order FAILED, stock restored

ABANDONED PATH (worker):
  Order PENDING > 30 min → stock restored, order FAILED
```

---

## 7. Vendor Lifecycle

```
1. User registers as BUYER
2. POST /vendors → creates Vendor (PENDING) + Wallet + promotes to VENDOR
3. POST /vendors/me/verification → submits ID document
4. ADMIN reviews → approves → vendor becomes VERIFIED
5. Vendor can now create products
6. Vendor manages delivery zones + methods
7. Orders come in → vendor confirms/processes/dispatches
8. Earnings accumulate in wallet (pending → available on completion)
9. Vendor requests payout → admin approves → paid
10. Vendor can upgrade subscription (FREE → BASIC → PREMIUM)
```

---

## 8. Background Workers

| Worker | Schedule | Purpose |
|--------|----------|---------|
| **Notifications** | On-demand (queue) | Creates notification DB records from queue |
| **Emails** | On-demand (queue) | Sends emails via Resend (rate-limited 10/sec) |
| **Stock Alerts** | Every 6 hours | Emails vendors about products with stock ≤ 5 |
| **Cart Cleanup** | Every 15 minutes | Restores stock from abandoned orders (>30 min PENDING) |

All workers gracefully skip if Redis is not configured.

---

## 9. Email Templates

| Template | Trigger | Recipient |
|----------|---------|-----------|
| `welcomeBuyer` | Registration | Buyer |
| `passwordReset` | Forgot password | User |
| `orderConfirmation` | Payment succeeded | Buyer |
| `orderShipped` | Shipment created | Buyer |
| `vendorNewOrder` | Payment succeeded | Vendor |
| `payoutApproved` | Admin approves payout | Vendor |
| `lowStockAlert` | Stock alert worker | Vendor |
| `vendorVerified` | Admin verifies vendor | Vendor |

---

## 10. Security

| Layer | Implementation |
|-------|---------------|
| **Headers** | Helmet (X-Content-Type-Options, X-Frame-Options, HSTS, etc.) |
| **CORS** | Configurable origins via `CORS_ORIGINS` env var |
| **Rate Limiting** | Redis-backed (auth: 10/15min, payments: 20/min, general: 100/min) |
| **Body Size** | JSON: 5MB, URL-encoded: 2MB |
| **Input Validation** | Max string: 5000 chars, max array: 100, max depth: 10 |
| **Auth** | JWT with configurable expiry, bcrypt password hashing |
| **Webhook** | Stripe signature verification |
| **Idempotency** | WebhookEvent table prevents duplicate processing |
| **Transactions** | Prisma $transaction for all multi-step operations |
| **Audit** | All admin actions logged with actor + timestamp |
| **Vendor Verification** | Only verified vendors can list products |

---

## 11. Subscription Plans

| Plan | Monthly | Max Products | Max Images/Product | Analytics | Priority Support |
|------|---------|-------------|-------------------|-----------|-----------------|
| FREE | $0 | 10 | 3 | ❌ | ❌ |
| BASIC | $19.99 | 50 | 8 | ✅ | ❌ |
| PREMIUM | $49.99 | Unlimited | 20 | ✅ | ✅ |

Powered by Stripe Checkout Sessions + Stripe Billing.


---

## 12. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Environment mode |
| `PORT` | No | `4000` | Server port |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `STRIPE_SECRET_KEY` | **Yes** | — | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | **Yes** | — | Stripe webhook signing secret |
| `JWT_SECRET` | **Yes** | — | JWT signing secret |
| `JWT_EXPIRES_IN` | No | `7d` | JWT expiration |
| `DEFAULT_CURRENCY` | No | `usd` | Default currency |
| `PLATFORM_FEE_BPS` | No | `1000` | Platform fee (1000 = 10%) |
| `CORS_ORIGINS` | No | — | Comma-separated allowed origins |
| `REDIS_URL` | No | — | Redis for queues + rate limiting |
| `RESEND_API_KEY` | No | — | Resend email API key |
| `EMAIL_FROM` | No | `Eki Marketplace <noreply@ekiapp.com>` | From address |
| `FRONTEND_URL` | No | `http://localhost:3000` | Frontend URL for email links |
| `UPLOAD_BASE_URL` | No | `/uploads` | CDN/bucket public URL |
| `SENTRY_DSN` | No | — | Sentry error monitoring |
| `LOG_LEVEL` | No | `info` | Minimum log level |

---

## 13. Dependencies

### Production
| Package | Purpose |
|---------|---------|
| express | HTTP framework |
| @prisma/client | Database ORM |
| stripe | Payment processing |
| jsonwebtoken | JWT auth |
| bcryptjs | Password hashing |
| bullmq | Job queues |
| ioredis | Redis client |
| resend | Transactional emails |
| cors | CORS middleware |
| helmet | Security headers |
| express-rate-limit | Rate limiting |
| rate-limit-redis | Redis store for rate limiter |
| swagger-jsdoc | OpenAPI spec |
| swagger-ui-express | Swagger UI |
| @sentry/node | Error monitoring |
| dotenv | Env var loading |

### Dev
| Package | Purpose |
|---------|---------|
| typescript | Type checking |
| tsx | Dev runtime |
| prisma | Schema management |
| vitest | Testing |
| @types/* | Type definitions |

---

## 14. Scripts

```bash
npm run dev          # Start dev server (tsx)
npm run dev:watch    # Start with file watching
npm run build        # Compile TypeScript
npm start            # Run compiled output
npm test             # Run tests (vitest)
npm run prisma:generate    # Generate Prisma client
npm run prisma:migrate     # Run migrations (dev)
npm run prisma:migrate:deploy  # Run migrations (production)
npm run prisma:seed        # Seed database
```

---

## 15. Frontend Integration Guide

### Public Endpoints (no auth)
```
GET  /api/health
POST /api/auth/register
POST /api/auth/login
POST /api/auth/forgot-password
POST /api/auth/reset-password
GET  /api/products
GET  /api/products/:id
GET  /api/delivery/zones
GET  /api/subscriptions/plans
GET  /api/docs (Swagger UI)
```

### Buyer Flow
```
GET    /api/auth/me
PATCH  /api/auth/me
GET    /api/cart
POST   /api/cart/items
PATCH  /api/cart/items/:id
DELETE /api/cart/items/:id
DELETE /api/cart
POST   /api/delivery/calculate
POST   /api/payments/create-intent
GET    /api/orders/me
GET    /api/orders/:id
GET    /api/shipments/orders/:orderId
GET    /api/wallet/me
GET    /api/wallet/me/transactions
POST   /api/wallet/me/top-up
POST   /api/wallet/me/apply
POST   /api/promo-codes/validate
GET    /api/referrals/me
GET    /api/addresses
POST   /api/addresses
PATCH  /api/addresses/:id
DELETE /api/addresses/:id
GET    /api/notifications
PATCH  /api/notifications/:id/read
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages
PATCH  /api/conversations/:id/read
POST   /api/uploads/request-url
```

### Vendor Flow
```
POST   /api/vendors
GET    /api/vendors/me
PATCH  /api/vendors/me
GET    /api/vendors/me/dashboard
GET    /api/vendors/me/earnings
POST   /api/vendors/me/verification
GET    /api/vendors/me/verification
GET    /api/vendors/me/orders
GET    /api/vendors/me/orders/:id
PATCH  /api/vendors/me/orders/:id/status
POST   /api/vendors/me/payout-methods
GET    /api/vendors/me/payout-methods
POST   /api/payout-requests
GET    /api/payout-requests/me
POST   /api/products
PATCH  /api/products/:id
DELETE /api/products/:id
GET    /api/delivery/zones/me
POST   /api/delivery/zones/me
PATCH  /api/delivery/zones/me/:id
DELETE /api/delivery/zones/me/:id
POST   /api/delivery/zones/me/:zoneId/methods
PATCH  /api/delivery/methods/:id
DELETE /api/delivery/methods/:id
GET    /api/shipments
POST   /api/shipments/orders/:orderId
PATCH  /api/shipments/:id
GET    /api/subscriptions/me
GET    /api/subscriptions/me/limits
POST   /api/subscriptions/checkout
POST   /api/subscriptions/cancel
```

### Admin Flow
```
GET    /api/admin/dashboard
GET    /api/admin/analytics
GET    /api/admin/audit-logs
GET    /api/admin/users
GET    /api/admin/vendors
GET    /api/admin/products
GET    /api/admin/orders
GET    /api/admin/payments
GET    /api/admin/wallet-transactions
PATCH  /api/admin/vendors/:id/approve
PATCH  /api/admin/vendors/:id/reject
PATCH  /api/admin/vendors/:id/suspend
PATCH  /api/admin/vendors/:id/unsuspend
PATCH  /api/admin/products/:id/approve
PATCH  /api/admin/products/:id/disable
PATCH  /api/admin/orders/:id/complete
GET    /api/admin/payout-requests
PATCH  /api/admin/payout-requests/:id/approve
PATCH  /api/admin/payout-requests/:id/reject
PATCH  /api/admin/payout-requests/:id/mark-paid
GET    /api/admin/verification-documents
PATCH  /api/admin/verification-documents/:id/review
GET    /api/admin/delivery-zones
POST   /api/admin/delivery-zones
PATCH  /api/admin/delivery-zones/:id
DELETE /api/admin/delivery-zones/:id
GET    /api/admin/promo-codes
POST   /api/admin/promo-codes
PATCH  /api/admin/promo-codes/:id
```

---

## 16. Deployment

### Vercel (Serverless)
- Entry: `api/index.ts` wraps Express app
- Build: `vercel-build` script runs `prisma generate`
- Database: Use Neon pooled connection string
- Workers: Run separately (not in serverless — use a VPS or Railway for workers)

### Traditional (VPS/Railway)
- `npm run build && npm start`
- Workers start automatically with the server
- Set `REDIS_URL` to enable queues + workers

---

## 17. Total Endpoint Count

| Category | Count |
|----------|-------|
| Auth | 6 |
| Vendors | 12 |
| Products | 5 |
| Cart | 5 |
| Delivery | 9 |
| Orders | 2 |
| Payments | 1 |
| Shipments | 4 |
| Payouts | 2 |
| Buyer Wallet | 4 |
| Promo Codes | 1 |
| Referrals | 1 |
| Subscriptions | 5 |
| Notifications | 2 |
| Conversations | 5 |
| Addresses | 4 |
| Uploads | 1 |
| Stripe Webhook | 1 |
| Admin | 27 |
| Health | 1 |
| **Total** | **~98 endpoints** |
