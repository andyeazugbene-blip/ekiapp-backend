# QA Seed System - Final Acceptance Checklist

This checklist confirms the QA seed system is ready for use.

## ✅ Acceptance Criteria

### 1. Scripts Exist and Run

- [ ] `npm run seed:qa` executes without errors
- [ ] `npm run cleanup:qa -- --dry-run` executes without errors
- [ ] `npm run cleanup:qa -- --confirm` executes without errors
- [ ] `npm run seed:escrow` executes without errors
- [ ] `npm run seed:otp` executes without errors
- [ ] `npm run validate:qa` executes without errors

### 2. Idempotency

- [ ] Running `npm run seed:qa` twice does not create duplicates
- [ ] Existing users are reused by email
- [ ] Existing vendors are reused by userId
- [ ] Existing products are reused by vendorId + title
- [ ] No "unique constraint violation" errors on rerun

### 3. Data Integrity

- [ ] All seeded users have correct roles (ADMIN, BUYER, VENDOR)
- [ ] All vendors have matching currency on products
- [ ] All paid orders have matching Payment records
- [ ] All paid orders have matching WalletTransaction records
- [ ] Wallet balances match order statuses (pending/available)
- [ ] `npm run reconcile:wallets` shows 0 mismatches after seed

### 4. Safety Features

- [ ] All data is prefixed with `SEED_QA_` (or configured prefix)
- [ ] Safe mode is ON by default (no real provider calls)
- [ ] No real Stripe charges unless explicitly enabled
- [ ] No real Paystack charges unless explicitly enabled
- [ ] No real SMS/emails sent unless explicitly enabled
- [ ] Cleanup only touches QA-prefixed data
- [ ] Cleanup requires `--confirm` flag (dry-run by default)

### 5. Generated Files

- [ ] `QA_SEED_CREDENTIALS.md` is created with login credentials
- [ ] `QA_SEED_REPORT.json` is created with structured data
- [ ] `ESCROW_SEED_REPORT.md` is created by escrow script
- [ ] `OTP_SEED_REPORT.md` is created by OTP script
- [ ] `QA_SEED_VALIDATION_REPORT.json` is created by validation
- [ ] `QA_CLEANUP_REPORT.json` is created by cleanup
- [ ] All credential files are in `.gitignore`

### 6. Data Coverage

#### Users
- [ ] 1 admin user exists
- [ ] Multiple buyers exist (5-50 depending on scale)
- [ ] Multiple vendors exist (3-20 depending on scale)
- [ ] All users have correct email format
- [ ] All users have correct password hash
- [ ] All users are email verified

#### Vendors
- [ ] All vendors have correct currency (EUR, GBP, NGN, GHS, KES, USD)
- [ ] All vendors have wallets
- [ ] All vendors have delivery zones
- [ ] All vendors are verified
- [ ] All vendors have unique store slugs

#### Products
- [ ] Products exist for each vendor
- [ ] Products have correct currency (matches vendor)
- [ ] Products have realistic names and prices
- [ ] Low-stock product exists (stock=1)
- [ ] Out-of-stock product exists (stock=0)
- [ ] Expensive product exists
- [ ] Product without image exists

#### Coupons
- [ ] `SEED_QA_10OFF` exists (10% off)
- [ ] `SEED_QA_FIXED5` exists (fixed amount)
- [ ] `SEED_QA_EXPIRED` exists and is expired
- [ ] `SEED_QA_LIMIT1` exists (max 1 use)

#### Carts
- [ ] Empty cart exists
- [ ] One-product cart exists
- [ ] Multi-item cart exists
- [ ] Multi-vendor cart exists (if supported)
- [ ] Out-of-stock cart exists
- [ ] Low-stock cart exists
- [ ] Cart with coupon exists

#### Orders
- [ ] PENDING orders exist (2+)
- [ ] PAID orders exist (3+)
- [ ] PROCESSING orders exist (2+)
- [ ] DELIVERED orders exist (2+)
- [ ] COMPLETED orders exist (2+)
- [ ] REFUNDED order exists (1+)
- [ ] DISPUTED order exists (1+)
- [ ] All paid orders have Payment records
- [ ] All paid orders have correct wallet transactions

#### Reviews
- [ ] Reviews exist for delivered orders
- [ ] Reviews have various ratings (1-5 stars)
- [ ] Reviews are approved
- [ ] Reviews are linked to correct orders/products/vendors

#### Wallets
- [ ] All vendors have wallets
- [ ] Vendor pending balances are correct
- [ ] Vendor available balances are correct
- [ ] Some buyers have wallet balances
- [ ] Wallet transactions match orders

### 7. Escrow Scenarios

- [ ] ESCROW_PENDING_PAYMENT scenario exists
- [ ] ESCROW_PAID_HELD scenario exists
- [ ] ESCROW_VENDOR_ACCEPTED scenario exists
- [ ] ESCROW_SHIPPED scenario exists
- [ ] ESCROW_BUYER_CONFIRMED scenario exists
- [ ] ESCROW_AUTO_RELEASE_READY scenario exists
- [ ] ESCROW_DISPUTED scenario exists
- [ ] ESCROW_REFUNDED scenario exists
- [ ] ESCROW_VENDOR_PAYOUT_READY scenario exists
- [ ] All escrow orders use Paystack provider
- [ ] All escrow orders have PaystackTransaction records
- [ ] Disputed orders have Dispute records

### 8. OTP Scenarios

- [ ] VALID_OTP scenario exists
- [ ] EXPIRED_OTP scenario exists
- [ ] WRONG_ATTEMPTS scenario exists
- [ ] MAX_ATTEMPTS scenario exists
- [ ] ALREADY_USED scenario exists
- [ ] RESEND_COOLDOWN scenario exists
- [ ] DELIVERY_OTP_VALID scenario exists
- [ ] OTP codes are provided in report
- [ ] OTPs are hashed in database
- [ ] No OTPs sent unless explicitly enabled

### 9. Validation

- [ ] `npm run validate:qa` passes all checks
- [ ] No currency mismatches
- [ ] No missing payments for paid orders
- [ ] No missing wallets
- [ ] No wallet balance mismatches
- [ ] All order statuses represented
- [ ] All edge cases present

### 10. Cleanup

- [ ] Cleanup dry-run shows correct data to delete
- [ ] Cleanup with `--confirm` removes all QA data
- [ ] Cleanup maintains referential integrity
- [ ] Cleanup doesn't touch non-QA data
- [ ] Cleanup report is generated
- [ ] After cleanup, validation finds no QA data

### 11. Backend Integration

- [ ] `npx tsc --noEmit` succeeds after seed
- [ ] `npm test` passes after seed
- [ ] `npm run reconcile:wallets` passes after seed
- [ ] `npm run launch:health` passes after seed
- [ ] GET /api/products returns seeded products
- [ ] GET /api/reviews returns seeded reviews
- [ ] GET /api/orders works with seeded orders

### 12. API Testing

#### Public Endpoints
- [ ] GET /api/products returns SEED_QA_ products
- [ ] GET /api/products?category=food filters correctly
- [ ] GET /api/vendors returns seeded vendors
- [ ] GET /api/reviews?productId=<id> returns reviews

#### Buyer Endpoints
- [ ] POST /api/auth/login works with buyer credentials
- [ ] GET /api/auth/me returns buyer profile
- [ ] GET /api/cart returns buyer cart
- [ ] POST /api/cart/items adds product to cart
- [ ] POST /api/cart/apply-coupon applies SEED_QA_10OFF
- [ ] GET /api/orders returns buyer orders
- [ ] POST /api/reviews creates review for delivered order

#### Vendor Endpoints
- [ ] POST /api/auth/login works with vendor credentials
- [ ] GET /api/vendors/me returns vendor profile
- [ ] GET /api/vendors/me/orders returns vendor orders
- [ ] GET /api/vendors/me/wallet returns wallet balance
- [ ] GET /api/vendors/me/buyers returns buyer list
- [ ] GET /api/vendors/me/analytics/revenue returns data

#### Admin Endpoints
- [ ] POST /api/auth/login works with admin credentials
- [ ] GET /api/admin/dashboard returns data
- [ ] GET /api/admin/orders returns all orders
- [ ] GET /api/admin/disputes returns disputes
- [ ] POST /api/admin/orders/<id>/refund works
- [ ] GET /api/admin/vendors returns vendors
- [ ] PATCH /api/admin/vendors/<id>/approve works

### 13. Frontend/Mobile Testing

- [ ] Can login as buyer and browse products
- [ ] Can add SEED_QA_ products to cart
- [ ] Can apply SEED_QA_10OFF coupon
- [ ] Can view order history
- [ ] Can leave review on delivered order
- [ ] Can login as vendor and view dashboard
- [ ] Can view vendor orders
- [ ] Can view vendor wallet
- [ ] Can login as admin and view disputes
- [ ] All seeded data displays correctly

### 14. Documentation

- [ ] `QA_TEST_DATA_INDEX.md` exists and is complete
- [ ] `docs/QA_SEED_SYSTEM.md` exists and is complete
- [ ] `docs/QA_SEED_ACCEPTANCE.md` exists (this file)
- [ ] All scripts have clear usage comments
- [ ] All environment variables documented
- [ ] All test flows documented
- [ ] Troubleshooting guide exists

### 15. Security

- [ ] No real secrets in seeded data
- [ ] No real payment charges
- [ ] No real SMS/emails sent by default
- [ ] Credentials file not committed to git
- [ ] Safe mode prevents production damage
- [ ] Cleanup is safe and reversible (dry-run)

## 🎯 Final Acceptance

The QA seed system is **READY** if:

- ✅ All scripts run without errors
- ✅ Idempotency works (no duplicates on rerun)
- ✅ Validation passes (0 failures)
- ✅ Wallet reconciliation passes (0 mismatches)
- ✅ Cleanup works (removes all QA data)
- ✅ No real provider charges
- ✅ No real SMS/emails by default
- ✅ All data categories exist
- ✅ All scenarios exist
- ✅ API testing works
- ✅ Frontend/mobile can use seeded data
- ✅ Documentation is complete

## 📋 Sign-Off

**Tested By:** _________________  
**Date:** _________________  
**Environment:** _________________  
**Scale Used:** _________________  
**Issues Found:** _________________  
**Status:** ☐ PASS ☐ FAIL ☐ NEEDS WORK  

**Notes:**
```
[Add any notes, issues, or observations here]
```

## 🚀 Next Steps After Acceptance

1. **Communicate to team:**
   - Share `QA_TEST_DATA_INDEX.md`
   - Share `docs/QA_SEED_SYSTEM.md`
   - Provide training on usage

2. **Integrate into CI/CD:**
   - Add seed + validate to test pipeline
   - Add cleanup to teardown

3. **Create test scenarios:**
   - Document specific test cases
   - Create test scripts using seeded data

4. **Monitor usage:**
   - Track seed script performance
   - Collect feedback from testers
   - Iterate on scenarios

5. **Maintain:**
   - Update as schema changes
   - Add new scenarios as needed
   - Keep documentation current
