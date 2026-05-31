# QA Test Data Index

**Last Updated:** [Run seed scripts to generate]

This document provides a comprehensive index of all QA test data for end-to-end marketplace testing.

## Quick Start

```bash
# Seed all QA data
npm run seed:qa

# Seed specific scenarios
npm run seed:escrow
npm run seed:otp

# Cleanup all QA data
npm run cleanup:qa -- --dry-run  # Preview
npm run cleanup:qa -- --confirm  # Actually delete
```

## Environment Configuration

```bash
# .env or command line
QA_SEED_PREFIX=SEED_QA_              # Prefix for all test data
QA_SEED_SAFE_MODE=true               # Safe mode (default)
QA_SEED_COUNTS=small                 # small | medium | large
QA_ALLOW_PROVIDER_CALLS=false        # Stripe/Paystack API calls
QA_ALLOW_EMAIL_SMS=false             # Send real emails/SMS
QA_ALLOW_PAYMENT_INTENTS=false       # Create real payment intents
QA_R2_UPLOAD=false                   # Test R2 uploads
```

## Test Credentials

### Admin
- **Email:** seed_qa_admin@example.com
- **Password:** SeedQA123!

### Buyers
- **Pattern:** seed_qa_buyer001@example.com to seed_qa_buyer020@example.com
- **Password:** SeedQA123!
- **Countries:** UK, Italy, Nigeria, Ghana, Kenya, US (rotated)

### Vendors
- **Pattern:** seed_qa_vendor001@example.com to seed_qa_vendor010@example.com
- **Password:** SeedQA123!
- **Currencies:** EUR, GBP, NGN, GHS, KES, USD (based on country)

## Test Data Categories

### 1. Products
- **Total:** 20-100 depending on scale
- **Prefix:** SEED_QA_
- **Categories:** food, spices, oils, grains, sauces, snacks, beverages, beauty
- **Edge Cases:**
  - Low stock (stock=1)
  - Out of stock (stock=0)
  - Expensive product
  - Product without image

### 2. Coupons
- **SEED_QA_10OFF:** 10% off, max 100 uses, active
- **SEED_QA_FIXED5:** Fixed 5 currency units off, active
- **SEED_QA_EXPIRED:** Expired coupon (should be rejected)
- **SEED_QA_LIMIT1:** Max 1 use (test limit enforcement)

### 3. Cart Scenarios
- **Buyer 1:** Empty cart
- **Buyer 2:** One product cart
- **Buyer 3:** Multi-item same vendor
- **Buyer 4:** Multi-vendor cart (if supported)
- **Buyer 5:** Out-of-stock product cart
- **Buyer 6:** Low-stock product cart
- **Buyer 7:** Cart with coupon
- **Buyer 8:** Cart with unsupported delivery zone

### 4. Order Statuses
Orders are created across all statuses:
- PENDING (2 orders)
- PAID (3 orders)
- PROCESSING (2 orders)
- DELIVERED (2 orders)
- COMPLETED (2 orders)
- REFUNDED (1 order)
- DISPUTED (1 order)

### 5. Wallet Balances
- **Buyer 1:** Empty wallet
- **Buyer 2:** Small balance (50 currency units)
- **Buyer 3:** Large balance (500 currency units)
- **Buyer 4:** Partial balance (250 currency units)
- **Vendors:** Balances reflect order statuses (pending/available)

### 6. Reviews
- Created only for delivered/completed orders
- Ratings: 1-star, 3-star, 4-star, 5-star examples
- All reviews prefixed with SEED_QA_

## Escrow Scenarios

Run `npm run seed:escrow` to create:

1. **ESCROW_PENDING_PAYMENT:** Checkout started, no payment
2. **ESCROW_PAID_HELD:** Payment success, funds held
3. **ESCROW_VENDOR_ACCEPTED:** Vendor accepted order
4. **ESCROW_SHIPPED:** Vendor marked shipped
5. **ESCROW_BUYER_CONFIRMED:** Buyer confirmed delivery
6. **ESCROW_AUTO_RELEASE_READY:** Ready for auto-release
7. **ESCROW_DISPUTED:** Buyer opened dispute
8. **ESCROW_REFUNDED:** Admin resolved refund
9. **ESCROW_VENDOR_PAYOUT_READY:** Vendor has releasable balance

See `ESCROW_SEED_REPORT.md` for details.

## OTP Scenarios

Run `npm run seed:otp` to create:

1. **VALID_OTP:** Valid OTP, not expired
2. **EXPIRED_OTP:** OTP expired
3. **WRONG_ATTEMPTS:** 2 wrong attempts already
4. **MAX_ATTEMPTS:** Max attempts reached (locked)
5. **ALREADY_USED:** OTP already consumed
6. **RESEND_COOLDOWN:** Recent OTP exists
7. **DELIVERY_OTP_VALID:** Valid delivery OTP

See `OTP_SEED_REPORT.md` for OTP codes and testing instructions.

## API Testing Flows

### Buyer Flow
```bash
# 1. Login
POST /api/auth/login
{ "email": "seed_qa_buyer001@example.com", "password": "SeedQA123!" }

# 2. Browse products
GET /api/products?limit=20

# 3. Add to cart
POST /api/cart/items
{ "productId": "<product_id>", "quantity": 1 }

# 4. View cart
GET /api/cart

# 5. Apply coupon
POST /api/cart/apply-coupon
{ "code": "SEED_QA_10OFF" }

# 6. Checkout
POST /api/payments/create-intent
{ "cartId": "<cart_id>", "deliveryCountry": "Italy" }

# 7. View orders
GET /api/orders

# 8. Leave review (for delivered orders)
POST /api/reviews
{ "orderId": "<order_id>", "vendorId": "<vendor_id>", "rating": 5, "comment": "Great!" }
```

### Vendor Flow
```bash
# 1. Login
POST /api/auth/login
{ "email": "seed_qa_vendor001@example.com", "password": "SeedQA123!" }

# 2. View profile
GET /api/vendors/me

# 3. View products
GET /api/products?vendorId=<vendor_id>

# 4. View orders
GET /api/vendors/me/orders

# 5. Accept order
PATCH /api/vendors/me/orders/<order_id>/accept

# 6. Mark shipped
PATCH /api/vendors/me/orders/<order_id>/ship

# 7. View wallet
GET /api/vendors/me/wallet

# 8. View buyers
GET /api/vendors/me/buyers

# 9. View analytics
GET /api/vendors/me/analytics/revenue
```

### Admin Flow
```bash
# 1. Login
POST /api/auth/login
{ "email": "seed_qa_admin@example.com", "password": "SeedQA123!" }

# 2. View dashboard
GET /api/admin/dashboard

# 3. View all orders
GET /api/admin/orders

# 4. View disputes
GET /api/admin/disputes

# 5. Refund order
POST /api/admin/orders/<order_id>/refund
{ "amount": 1000, "reason": "Test refund" }

# 6. View vendors
GET /api/admin/vendors

# 7. Approve vendor
PATCH /api/admin/vendors/<vendor_id>/approve

# 8. View products
GET /api/admin/products
```

## Mobile App Testing

### Screens to Test
1. **Auth:**
   - Login with buyer/vendor credentials
   - Registration (use new email with SEED_QA_ prefix)
   - Password reset

2. **Buyer Screens:**
   - Product catalog
   - Product detail
   - Cart
   - Checkout
   - Order history
   - Order detail
   - Leave review
   - Wallet balance

3. **Vendor Screens:**
   - Dashboard
   - Products list
   - Add/edit product
   - Orders list
   - Order detail
   - Accept/ship order
   - Buyers list
   - Wallet/earnings
   - Analytics

4. **Admin Screens:**
   - Dashboard
   - Orders management
   - Disputes
   - Refunds
   - Vendor management
   - Product moderation

## Validation Checklist

After seeding, verify:

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `npm run reconcile:wallets` shows 0 mismatches
- [ ] `npm run launch:health` passes
- [ ] GET /api/products returns seeded products
- [ ] GET /api/reviews returns seeded reviews
- [ ] Buyer can login and see orders
- [ ] Vendor can login and see dashboard
- [ ] Admin can login and see disputes
- [ ] Coupons can be applied in cart
- [ ] Out-of-stock products block checkout
- [ ] Escrow orders show correct status
- [ ] OTP verification works with seeded codes

## Cleanup

```bash
# Dry run (preview what will be deleted)
npm run cleanup:qa -- --dry-run

# Confirm deletion
npm run cleanup:qa -- --confirm
```

Cleanup will:
- Deactivate all SEED_QA_ products
- Delete all SEED_QA_ coupons
- Delete all carts for QA users
- Delete all orders for QA users/vendors
- Delete all reviews by QA users
- Delete all QA wallets and transactions
- Delete all QA vendors
- Delete all QA users

## Reports

After running seed scripts, check these files:
- `QA_SEED_CREDENTIALS.md` - Login credentials
- `QA_SEED_REPORT.json` - Structured data report
- `ESCROW_SEED_REPORT.md` - Escrow scenarios
- `OTP_SEED_REPORT.md` - OTP scenarios with codes
- `QA_CLEANUP_REPORT.json` - Cleanup results

## Safety Notes

- All data is prefixed with `SEED_QA_` for easy identification
- Safe mode is ON by default (no real provider calls)
- No real money is charged
- No real SMS/emails are sent (unless explicitly enabled)
- Cleanup is idempotent and safe to run multiple times
- Never commit `QA_SEED_CREDENTIALS.md` to git

## Troubleshooting

### Seed fails with "unique constraint violation"
- Run cleanup first: `npm run cleanup:qa -- --confirm`
- Or use different prefix: `QA_SEED_PREFIX=TEST2_ npm run seed:qa`

### Wallet reconciliation fails
- Check that all paid orders have matching payments
- Check that wallet transactions match order statuses
- Run: `npm run reconcile:wallets` for detailed report

### Products not showing in catalog
- Check `isActive` is true
- Check product currency matches vendor currency
- Check stock > 0 for available products

### OTP verification fails
- Use exact OTP from `OTP_SEED_REPORT.md`
- Check OTP not expired
- Check attempts < max limit
- Check OTP not already consumed

## Support

For issues or questions:
1. Check this index
2. Check individual report files
3. Run validation checklist
4. Check backend logs
5. Run cleanup and re-seed
