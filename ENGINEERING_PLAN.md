# Engineering Plan: Backend Gap Analysis vs Frontend

> Based on full codebase analysis of both backend and frontend — May 2026

---

## 1. Existing Backend Modules (Working)

| Module | Status | Coverage |
|--------|--------|----------|
| Auth (register/login/me) | ✅ Complete | JWT, bcrypt, rate-limited |
| Vendors (profile CRUD, payout methods) | ✅ Complete | Create, get, update, payout methods |
| Products (CRUD, list, disable) | ✅ Complete | Vendor-owned, paginated |
| Cart (single-vendor, CRUD) | ✅ Complete | Stock validation, auto-create |
| Delivery (fee calculator) | ✅ Complete | Zone-based, weight-based |
| Payments (Stripe PaymentIntent) | ✅ Complete | Atomic order+payment creation |
| Stripe Webhooks (succeeded/failed) | ✅ Complete | Idempotent, wallet credit |
| Payouts (request/approve/reject/paid) | ✅ Complete | Full lifecycle |
| Admin (listings, moderation, order completion) | ✅ Complete | Paginated, RBAC |
| Notifications (in-app, queue) | ✅ Complete | BullMQ with fallback |
| Health | ✅ Complete | Simple check |
| Swagger/OpenAPI | ✅ Complete | Full spec |

---

## 2. Missing Modules (Frontend Expects, Backend Lacks)

| # | Module | Frontend Evidence | Priority |
|---|--------|-------------------|----------|
| 1 | **Messaging / Chat** | `messageStore.ts`, `(vendor)/messages.tsx`, `(vendor)/message-chat.tsx`, `(buyer)/messages.tsx`, `(admin)/messages.tsx` | HIGH |
| 2 | **Buyer Order History** | `orderStore.fetchBuyerOrders()`, `(buyer)/orders.tsx` | HIGH |
| 3 | **Vendor Order Management** | `vendorOrderStore.ts`, `(vendor)/orders.tsx`, `(vendor)/order-detail.tsx`, `orderService.updateOrderStatus()` | HIGH |
| 4 | **Vendor Dashboard / Analytics** | `vendorStore.fetchDashboard()`, `(vendor)/index.tsx` | HIGH |
| 5 | **Admin Dashboard / Analytics** | `vendorStore.fetchAdminDashboard()`, `(admin)/analytics.tsx`, `(admin)/index.tsx` | HIGH |
| 6 | **File Upload / Storage** | `(vendor-verification)/upload-id.tsx`, `(vendor-verification)/upload-business.tsx`, product images | HIGH |
| 7 | **Vendor Verification (KYC)** | `(vendor-verification)/*` screens, `verificationStatus` in types | HIGH |
| 8 | **Delivery Zone Management** | `deliveryStore.ts`, `(vendor)/delivery-zone.tsx`, `(vendor)/delivery.tsx` | MEDIUM |
| 9 | **Delivery Tracking / Shipments** | `(vendor)/delivery-tracking.tsx`, shipment statuses | MEDIUM |
| 10 | **Buyer Wallet / Rewards** | `(buyer)/wallet.tsx`, `walletBalance`, referral bonus, top-up | MEDIUM |
| 11 | **Promo Codes / Discounts** | `checkout.tsx` applies promo code `AFRO10` | MEDIUM |
| 12 | **Forgot Password / Reset** | `(auth)/forgot-password.tsx`, `authService.forgotPassword()` | MEDIUM |
| 13 | **Subscription Plans** | `subscriptionPlan: "free" | "basic" | "premium"` in VendorProfile | LOW |
| 14 | **Reviews / Ratings** | `Review` type in `product.ts`, `rating` + `totalReviews` on vendor | LOW |
| 15 | **Product Search** | `productService.getAll({ search })` | LOW |
| 16 | **Buyer Profile Management** | `(buyer)/profile.tsx`, delivery address, phone | LOW |
| 17 | **Admin Settings / Config** | `(admin)/settings.tsx` | LOW |
| 18 | **OTP Verification** | `(vendor-onboarding)/otp.tsx` | LOW |
| 19 | **Multi-currency Display** | `priceNgn`, `localCurrency`, `localRate` in frontend types | LOW |

---

## 3. Missing Prisma Models

### New Models Required

```
model Conversation
  - id, type (buyer_vendor | admin_vendor | dispute)
  - participants (User[])
  - orderId? (linked to order)
  - lastMessageAt, createdAt

model Message
  - id, conversationId, senderId
  - text, attachments[]
  - readAt, createdAt

model VerificationDocument
  - id, vendorId
  - type (government_id | business_registration)
  - idType (passport | drivers_license | national_id)
  - frontUrl, backUrl?
  - status (pending | approved | rejected)
  - reviewedById?, reviewedAt?, rejectionReason?
  - createdAt

model Shipment
  - id, orderId, vendorId
  - trackingNumber, carrier
  - status (processing | in_transit | delivered | delayed)
  - estimatedDeliveryAt, dispatchedAt, deliveredAt
  - createdAt, updatedAt

model BuyerWallet
  - id, buyerId (unique)
  - balance, currency
  - createdAt, updatedAt

model BuyerWalletTransaction
  - id, walletId, buyerId
  - type (top_up | referral_bonus | order_debit | refund_credit | withdrawal)
  - amount, currency, description
  - createdAt

model PromoCode
  - id, code (unique)
  - type (percentage | fixed_amount)
  - value, minOrderAmount?
  - maxUses, usedCount
  - validFrom, validUntil
  - isActive, createdAt

model PromoRedemption
  - id, promoCodeId, buyerId, orderId
  - discountAmount, createdAt

model Review
  - id, buyerId, vendorId?, productId?
  - orderId
  - rating (1-5), comment
  - createdAt

model SubscriptionPlan
  - id, vendorId
  - plan (free | basic | premium)
  - status (active | cancelled | expired)
  - startedAt, expiresAt
  - stripeSubscriptionId?

model DeliveryMethod
  - id, deliveryZoneId
  - label (Standard | Express | Economy)
  - price, minDays, maxDays
  - isActive, createdAt

model PasswordResetToken
  - id, userId, token (unique)
  - expiresAt, usedAt?
  - createdAt

model OtpVerification
  - id, userId?, email?, phone?
  - code, purpose (registration | password_reset | vendor_onboarding)
  - expiresAt, verifiedAt?
  - createdAt

model BuyerAddress
  - id, buyerId
  - recipientName, line1, line2?, city, postalCode, country, phone
  - isDefault, createdAt
```

### Models Requiring Schema Changes

```
User
  + phone: String?
  + avatar: String?
  + country: String?

Vendor
  + city: String?
  + coverImage: String?
  + rating: Float @default(0)
  + totalReviews: Int @default(0)
  + subscriptionPlan: String @default("free")

Product
  + unit: String?  (kg, g, litre, pack)
  + status: ProductStatus  (active | draft | low_stock | out_of_stock)

Order
  + orderNumber: String @unique  (human-readable: EKI-YYYY-XXXX)
  + notes: String?
  + deliveredAt: DateTime?

OrderStatus enum
  + CONFIRMED
  + PROCESSING
  + DISPATCHED
  + IN_TRANSIT
  + DELIVERED
  + CANCELLED
  + REFUNDED
  (replace current: PENDING, PAID, COMPLETED, FAILED)

DeliveryZone
  + flag: String?  (emoji flag)
```

---

## 4. Missing Endpoints

### Buyer Orders
| Method | Path | Description |
|--------|------|-------------|
| GET | `/orders/me` | List buyer's own orders (paginated, filterable by status) |
| GET | `/orders/:id` | Get order detail (buyer must own it) |

### Vendor Orders
| Method | Path | Description |
|--------|------|-------------|
| GET | `/vendors/me/orders` | List orders containing vendor's products |
| GET | `/vendors/me/orders/:id` | Get order detail (vendor must own items) |
| PATCH | `/vendors/me/orders/:id/status` | Update order status (confirmed → processing → dispatched) |

### Vendor Dashboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/vendors/me/dashboard` | Aggregated stats: sales today/week/month, alerts, insights |
| GET | `/vendors/me/earnings` | Earnings breakdown with local currency conversion |

### Admin Dashboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/dashboard` | KPIs: total revenue, orders, vendors, disputes |
| GET | `/admin/analytics` | Revenue trends, top vendors, growth metrics |

### Messaging
| Method | Path | Description |
|--------|------|-------------|
| GET | `/conversations` | List user's conversations |
| POST | `/conversations` | Create conversation (buyer→vendor or admin→vendor) |
| GET | `/conversations/:id/messages` | List messages in conversation (paginated) |
| POST | `/conversations/:id/messages` | Send a message |
| PATCH | `/conversations/:id/read` | Mark conversation as read |

### File Upload
| Method | Path | Description |
|--------|------|-------------|
| POST | `/uploads/image` | Upload image (product, avatar, cover) → returns URL |
| POST | `/uploads/document` | Upload verification document → returns URL |

### Vendor Verification (KYC)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/vendors/me/verification` | Submit verification documents |
| GET | `/vendors/me/verification` | Get verification status + documents |
| PATCH | `/admin/vendors/:id/verification` | Admin review (approve/reject with reason) |

### Delivery Zone Management (Vendor)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/vendors/me/delivery-zones` | List vendor's delivery zone config |
| PATCH | `/vendors/me/delivery-zones/:id` | Toggle zone active, update methods |
| GET | `/delivery-zones` | Public: list active zones (for checkout) |

### Shipment Tracking
| Method | Path | Description |
|--------|------|-------------|
| POST | `/vendors/me/orders/:id/shipment` | Create shipment (tracking number, carrier) |
| PATCH | `/vendors/me/shipments/:id` | Update shipment status |
| GET | `/vendors/me/shipments` | List all vendor shipments |
| GET | `/orders/:id/shipment` | Buyer: get shipment tracking for their order |

### Buyer Wallet
| Method | Path | Description |
|--------|------|-------------|
| GET | `/wallet/me` | Get buyer wallet balance |
| GET | `/wallet/me/transactions` | List wallet transactions |
| POST | `/wallet/me/top-up` | Initiate top-up (Stripe) |
| POST | `/wallet/me/apply` | Apply wallet balance to order |

### Promo Codes
| Method | Path | Description |
|--------|------|-------------|
| POST | `/promo-codes/validate` | Validate a promo code for a cart |
| POST | `/admin/promo-codes` | Create promo code |
| GET | `/admin/promo-codes` | List promo codes |
| PATCH | `/admin/promo-codes/:id` | Update/deactivate promo code |

### Password Reset
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/forgot-password` | Send reset email |
| POST | `/auth/reset-password` | Reset password with token |

### Reviews
| Method | Path | Description |
|--------|------|-------------|
| POST | `/reviews` | Create review (buyer, after delivery) |
| GET | `/products/:id/reviews` | List product reviews |
| GET | `/vendors/:id/reviews` | List vendor reviews |

### Buyer Profile
| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/auth/me` | Update profile (name, phone, avatar, country) |
| GET | `/addresses` | List saved addresses |
| POST | `/addresses` | Create address |
| PATCH | `/addresses/:id` | Update address |
| DELETE | `/addresses/:id` | Delete address |

### Product Search
| Method | Path | Description |
|--------|------|-------------|
| GET | `/products/search` | Full-text search with relevance ranking |
| GET | `/products/popular` | Popular/trending products |
| GET | `/products/deals` | Hot deals / discounted products |

### OTP
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/send-otp` | Send OTP to phone/email |
| POST | `/auth/verify-otp` | Verify OTP code |

---

## 5. Missing RBAC Rules

| Rule | Current | Required |
|------|---------|----------|
| Vendor can update order status | ❌ Missing | Vendor should transition: PAID → CONFIRMED → PROCESSING → DISPATCHED |
| Vendor verification check on product creation | ❌ Missing | Only VERIFIED vendors can create products |
| Buyer can only review delivered orders | ❌ Missing | Review creation requires order status = DELIVERED |
| Vendor can only message their own buyers | ❌ Missing | Conversation participants must be validated |
| Admin can suspend vendor (disable all products) | ❌ Missing | Bulk disable + block new listings |
| Buyer wallet debit requires sufficient balance | ❌ Missing | Wallet balance check on apply |
| Promo code usage limit per buyer | ❌ Missing | One redemption per buyer per code |
| File upload size/type restrictions | ❌ Missing | Max 5MB images, 10MB documents, allowed MIME types |

---

## 6. Missing Background Jobs / Workers

| Worker | Queue | Purpose |
|--------|-------|---------|
| **Notification Worker** | `notifications` | Process notification queue → DB insert (declared but no worker file) |
| **Email Worker** | `emails` | Send transactional emails (order confirmation, password reset, verification) |
| **Payout Worker** | `payouts` | Process approved payouts (future: auto-transfer via Stripe Connect) |
| **Shipment Status Poller** | `shipments` | Poll carrier APIs for tracking updates |
| **Stock Alert Worker** | `stock-alerts` | Detect low stock → notify vendor |
| **Abandoned Cart Cleanup** | `cart-cleanup` | Release stock from expired PaymentIntents (>30min) |
| **Subscription Expiry** | `subscriptions` | Check expiring subscriptions, send reminders |
| **Review Aggregation** | `reviews` | Recalculate vendor/product ratings on new review |
| **Analytics Aggregation** | `analytics` | Pre-compute dashboard stats (daily/hourly) |

---

## 7. Missing Analytics Systems

| System | Purpose | Implementation |
|--------|---------|----------------|
| **Vendor Dashboard Stats** | Sales today/week/month, pending payouts, alerts | Aggregation queries on orders + wallet |
| **Admin KPIs** | Total revenue, order count, vendor count, disputes | Aggregation queries + cached |
| **Revenue Trends** | Monthly/weekly revenue chart data | Time-series aggregation |
| **Top Vendors Ranking** | By orders, revenue | Periodic computation |
| **Product Performance** | Best sellers, views (future) | Order item aggregation |
| **Conversion Metrics** | Cart → checkout → payment success rate | Event tracking (future) |

---

## 8. Security Issues to Address

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | No CORS middleware | HIGH | Add `cors` with explicit origins |
| 2 | Unverified vendors can list products | HIGH | Check `verificationStatus === VERIFIED` |
| 3 | Rate limiting ineffective on Vercel (in-memory) | HIGH | Use Redis-backed rate limit store |
| 4 | No file upload validation | HIGH | Validate MIME type, size, scan for malware |
| 5 | No token refresh mechanism | MEDIUM | Add refresh tokens with rotation |
| 6 | No helmet security headers | MEDIUM | Add `helmet` middleware |
| 7 | No request body size limits | MEDIUM | Configure explicit `express.json({ limit })` |
| 8 | No audit trail for admin actions | MEDIUM | Log admin mutations with actor + timestamp |
| 9 | Stock locked indefinitely on abandoned payments | MEDIUM | TTL-based stock release job |
| 10 | No input length validation on strings | LOW | Add max length to all string fields |

---

## 9. Scaling Concerns

| Concern | Impact | Mitigation |
|---------|--------|------------|
| Prisma connection pooling on serverless | DB connection exhaustion | Use Neon pooler URL (already documented) |
| No caching layer | Repeated DB queries for same data | Add Redis caching for product lists, dashboard stats |
| Wallet balance race conditions | Double-spend on concurrent payouts | Already using transactions (good), add optimistic locking |
| Large notification table | Slow queries over time | Add TTL/archival policy, partition by date |
| No CDN for uploaded files | Slow image loading | Use S3/Cloudflare R2 + CDN |
| Single-region deployment | Latency for global buyers | Consider edge functions for read-heavy routes |
| No database read replicas | Write contention | Future: read replica for analytics queries |

---

## 10. Recommended Implementation Order

### Phase 1: Critical Path (Weeks 1-2)
> Unblock frontend integration for core flows

1. **CORS middleware** — 30 min
2. **Buyer order history** (`GET /orders/me`, `GET /orders/:id`) — 2h
3. **Vendor order management** (list, detail, status update) — 4h
4. **Extended OrderStatus enum** (add CONFIRMED, PROCESSING, DISPATCHED, IN_TRANSIT, DELIVERED, CANCELLED) — 2h migration
5. **Order number generation** (human-readable EKI-YYYY-XXXX) — 1h
6. **Buyer profile update** (`PATCH /auth/me`) — 1h
7. **Forgot password / reset** — 3h
8. **Vendor verification enforcement** on product creation — 30 min

### Phase 2: Messaging & Files (Weeks 2-3)
> Enable communication and document handling

9. **File upload service** (S3/Cloudflare R2 presigned URLs) — 4h
10. **Messaging module** (conversations, messages, real-time via polling) — 8h
11. **Vendor verification/KYC** (document upload, admin review) — 4h
12. **Buyer address management** (CRUD) — 2h

### Phase 3: Vendor Dashboard & Delivery (Weeks 3-4)
> Power the vendor experience

13. **Vendor dashboard endpoint** (aggregated stats) — 4h
14. **Vendor earnings endpoint** (with local currency) — 2h
15. **Delivery zone management** (vendor CRUD, multiple methods per zone) — 4h
16. **Shipment tracking** (create, update, buyer view) — 4h
17. **Delivery method model** (Standard/Express/Economy per zone) — 2h

### Phase 4: Admin & Analytics (Week 4-5)
> Complete admin panel support

18. **Admin dashboard endpoint** (KPIs) — 3h
19. **Admin analytics** (revenue trends, top vendors) — 4h
20. **Admin vendor suspension** (bulk disable products) — 2h
21. **Admin delivery zone CRUD** — 2h
22. **Audit logging** for admin actions — 3h

### Phase 5: Buyer Wallet & Promos (Week 5-6)
> Monetization and engagement features

23. **Buyer wallet** (balance, transactions, top-up via Stripe) — 6h
24. **Promo codes** (create, validate, redeem) — 4h
25. **Apply wallet balance to order** — 2h
26. **Referral system** (generate link, credit on signup) — 4h

### Phase 6: Reviews & Search (Week 6-7)
> Discovery and trust

27. **Reviews module** (create, list, rating aggregation) — 4h
28. **Product search** (PostgreSQL full-text or pg_trgm) — 3h
29. **Popular/trending products** endpoint — 2h
30. **Vendor rating recalculation** worker — 2h

### Phase 7: Workers & Background Jobs (Week 7-8)
> Reliability and automation

31. **Notification worker** (process BullMQ queue) — 2h
32. **Email worker** (SendGrid/Resend integration) — 4h
33. **Stock alert worker** — 2h
34. **Abandoned cart/stock cleanup** — 3h
35. **Shipment status polling** (carrier API integration) — 4h

### Phase 8: Subscriptions & Polish (Week 8+)
> Premium features

36. **Subscription plans** (Stripe Billing integration) — 8h
37. **OTP verification** (Twilio/SMS) — 3h
38. **Helmet + security headers** — 30 min
39. **Redis-backed rate limiting** — 1h
40. **Input length validation** across all endpoints — 2h

---

## Summary Metrics

| Metric | Count |
|--------|-------|
| Existing working modules | 11 |
| Missing modules to build | 19 |
| New Prisma models needed | 12 |
| Schema changes to existing models | 6 |
| Missing endpoints | ~55 |
| Missing workers | 9 |
| Security fixes needed | 10 |
| Estimated total effort | 6-8 weeks (1 senior dev) |

---

## Key Principle

Every addition follows the existing patterns:
- Controller → Service → Validation → Types
- `asyncHandler` wrapper
- `AppError` for all errors
- `authenticate` + `requireRole` for RBAC
- Prisma transactions for multi-step operations
- BullMQ queue with direct-insert fallback
- Structured JSON logging
- No breaking changes to existing endpoints
