# Frontend Integration Guide

## Auth Token Flow

```
1. POST /api/auth/register or /api/auth/login
   → Response: { user, token }
   → Store token in SecureStore/AsyncStorage

2. All authenticated requests:
   Headers: { Authorization: "Bearer <token>" }

3. Token expires after 7 days (configurable)
   → On 401 response, redirect to login
```

## Response Format Consistency

All endpoints follow these patterns:

```typescript
// Single resource
{ user: {...} }
{ order: {...} }
{ vendor: {...} }

// Paginated list
{ items: [...], nextCursor: string | null }

// Action result
{ success: true }

// Error
{ message: string, details?: any }
```

## Pagination

All list endpoints support cursor-based pagination:
```
?limit=20&cursor=<lastItemId>
```
- Default limit: 20
- Max limit: 100
- Response includes `nextCursor` (null = no more pages)

## Error Codes

| Status | Meaning |
|--------|---------|
| 400 | Validation error (check `message`) |
| 401 | Missing/invalid/expired token |
| 403 | Authenticated but not authorized |
| 404 | Resource not found |
| 409 | Conflict (duplicate, invalid state transition) |
| 429 | Rate limited |
| 502 | Stripe/external service failure |
| 500 | Internal server error |

## Frontend Service Mapping

| Frontend Service | Backend Endpoints |
|-----------------|-------------------|
| `authService.login` | `POST /api/auth/login` |
| `authService.register` | `POST /api/auth/register` |
| `authService.forgotPassword` | `POST /api/auth/forgot-password` |
| `productService.getAll` | `GET /api/products?category=&vendorId=&limit=&cursor=` |
| `productService.getById` | `GET /api/products/:id` |
| `productService.create` | `POST /api/products` |
| `productService.update` | `PATCH /api/products/:id` |
| `productService.delete` | `DELETE /api/products/:id` |
| `orderService.getBuyerOrders` | `GET /api/orders/me?status=` |
| `orderService.getVendorOrders` | `GET /api/vendors/me/orders?status=` |
| `orderService.updateOrderStatus` | `PATCH /api/vendors/me/orders/:id/status` |
| `orderService.getVendorEarnings` | `GET /api/vendors/me/earnings` |
| `vendorService.getVendorDashboard` | `GET /api/vendors/me/dashboard` |
| `vendorService.approveVendor` | `PATCH /api/admin/vendors/:id/approve` |
| `vendorService.rejectVendor` | `PATCH /api/admin/vendors/:id/reject` |
| `vendorService.getAdminDashboard` | `GET /api/admin/dashboard` |

## Checkout Flow (Stripe)

```
1. GET /api/cart                          → get cart with items
2. POST /api/delivery/calculate           → get delivery quote
3. POST /api/promo-codes/validate         → (optional) validate promo
4. POST /api/payments/create-intent       → get clientSecret
5. Stripe.confirmPayment(clientSecret)    → frontend Stripe SDK
6. Webhook handles the rest automatically
7. GET /api/orders/me                     → poll for order status
```

## File Upload Flow

```
1. POST /api/uploads/request-url
   Body: { filename, contentType, category }
   → Response: { uploadUrl, publicUrl, key }

2. PUT <uploadUrl> with file binary
   Headers: { Content-Type: <contentType> }

3. Use publicUrl in subsequent API calls
   (e.g., product images, avatar, verification docs)
```

## Messaging Flow

```
1. POST /api/conversations
   Body: { participantId, initialMessage? }
   → Creates or returns existing conversation

2. GET /api/conversations
   → List all conversations

3. GET /api/conversations/:id/messages?limit=30
   → Messages in chronological order

4. POST /api/conversations/:id/messages
   Body: { text, attachments? }

5. PATCH /api/conversations/:id/read
   → Mark messages as read (call when user opens chat)
```

## Vendor Onboarding Flow

```
1. POST /api/auth/register { role: not needed, always BUYER }
2. POST /api/vendors { storeName, ... }  → promotes to VENDOR
3. POST /api/vendors/me/verification { type, frontUrl, ... }
4. Wait for admin approval
5. GET /api/vendors/me/verification → check status
6. POST /api/vendors/me/stripe-connect/onboard → get Stripe link
7. Open Stripe onboarding in browser
8. GET /api/vendors/me/stripe-connect/status → verify connected
```

## Key Differences from Mock Data

| Frontend Mock | Backend Reality |
|--------------|-----------------|
| `product.price` (float) | `product.priceInCents` (integer cents) |
| `product.name` | `product.title` |
| `product.status` | Derived from `isActive` + `stock` |
| `order.status` lowercase | `order.status` UPPERCASE enum |
| `vendor.adminStatus` | `vendor.isSuspended` + `verificationStatus` |
| `vendor.subscriptionPlan` | Separate `VendorSubscription` model |
| `user.walletBalance` | Separate `BuyerWallet` model |
| `earnings.salesTodayNgn` | Not stored — compute on frontend with exchange rate |
