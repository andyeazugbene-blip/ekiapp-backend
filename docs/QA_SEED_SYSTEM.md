# QA Seed Data System

Comprehensive test data generation system for end-to-end marketplace testing.

## Overview

The QA seed system creates realistic test data across all marketplace entities:
- Users (admin, buyers, vendors)
- Products with various edge cases
- Coupons and promotions
- Shopping carts in different states
- Orders across all statuses
- Payments and wallet transactions
- Reviews
- Escrow scenarios (Paystack)
- OTP scenarios

## Quick Start

```bash
# 1. Seed all basic QA data
npm run seed:qa

# 2. Seed escrow scenarios (optional)
npm run seed:escrow

# 3. Seed OTP scenarios (optional)
npm run seed:otp

# 4. Validate seeded data
npm run validate:qa

# 5. Test with seeded data
# Use credentials from QA_SEED_CREDENTIALS.md

# 6. Cleanup when done
npm run cleanup:qa -- --dry-run  # Preview
npm run cleanup:qa -- --confirm  # Delete
```

## Configuration

### Environment Variables

```bash
# Prefix for all test data (default: SEED_QA_)
QA_SEED_PREFIX=SEED_QA_

# Safe mode - prevents destructive operations (default: true)
QA_SEED_SAFE_MODE=true

# Scale: small | medium | large (default: small)
QA_SEED_COUNTS=small

# Allow real provider API calls (default: false)
QA_ALLOW_PROVIDER_CALLS=false

# Allow real email/SMS sending (default: false)
QA_ALLOW_EMAIL_SMS=false

# Allow real payment intents (default: false)
QA_ALLOW_PAYMENT_INTENTS=false

# Test R2 uploads (default: false)
QA_R2_UPLOAD=false
```

### Scale Options

| Scale  | Buyers | Vendors | Products/Vendor | Orders |
|--------|--------|---------|-----------------|--------|
| small  | 5      | 3       | 4               | 10     |
| medium | 20     | 10      | 5               | 30     |
| large  | 50     | 20      | 10              | 100    |

## Scripts

### `npm run seed:qa`

Creates core test data:
- 1 admin user
- Multiple buyers (5-50 depending on scale)
- Multiple vendors (3-20 depending on scale)
- Products for each vendor
- Coupons (valid, expired, limited)
- Shopping carts in various states
- Orders across all statuses
- Payments for paid orders
- Reviews for delivered orders
- Wallet balances

**Output:**
- `QA_SEED_CREDENTIALS.md` - Login credentials (DO NOT COMMIT)
- `QA_SEED_REPORT.json` - Structured data report

**Idempotency:** Safe to run multiple times. Existing data is reused.

### `npm run seed:escrow`

Creates Paystack escrow test scenarios:
1. PENDING_PAYMENT - Checkout started, no payment
2. PAID_HELD - Payment success, funds held in escrow
3. VENDOR_ACCEPTED - Vendor accepted order
4. SHIPPED - Vendor marked shipped
5. BUYER_CONFIRMED - Buyer confirmed delivery
6. AUTO_RELEASE_READY - Ready for auto-release
7. DISPUTED - Buyer opened dispute, funds frozen
8. REFUNDED - Admin resolved with refund
9. VENDOR_PAYOUT_READY - Vendor has releasable balance

**Output:**
- `ESCROW_SEED_REPORT.md` - Scenario details and test instructions

**Use Case:** Testing escrow flows, auto-release, disputes, payouts

### `npm run seed:otp`

Creates OTP test scenarios:
1. VALID_OTP - Valid, not expired
2. EXPIRED_OTP - Expired OTP
3. WRONG_ATTEMPTS - 2 wrong attempts already
4. MAX_ATTEMPTS - Max attempts reached (locked)
5. ALREADY_USED - OTP already consumed
6. RESEND_COOLDOWN - Recent OTP exists
7. DELIVERY_OTP_VALID - Valid delivery OTP

**Output:**
- `OTP_SEED_REPORT.md` - OTP codes and test instructions
- `OTP_SEED_REPORT.json` - Structured data

**Use Case:** Testing OTP verification, expiry, rate limiting, resend cooldown

### `npm run validate:qa`

Validates seeded data integrity:
- Users exist with correct roles
- Vendors have correct currency
- Products have matching vendor currency
- Orders have matching payments
- Wallets are reconciled
- Reviews are valid
- All order statuses represented

**Output:**
- `QA_SEED_VALIDATION_REPORT.json` - Validation results
- Exit code 0 if all pass, 1 if any fail

**Use Case:** Verify seed data before testing, CI/CD validation

### `npm run cleanup:qa`

Safely removes all QA test data:
- Finds all data with QA prefix
- Deletes in correct order (referential integrity)
- Dry-run mode by default

**Flags:**
- `--dry-run` (default) - Preview what will be deleted
- `--confirm` - Actually delete data

**Output:**
- `QA_CLEANUP_REPORT.json` - Cleanup results

**Use Case:** Clean up after testing, reset test environment

## Safety Features

### 1. Prefixing
All test data is prefixed with `SEED_QA_` (configurable):
- Emails: `seed_qa_buyer001@example.com`
- Product titles: `SEED_QA_ Extra Virgin Olive Oil`
- Coupon codes: `SEED_QA_10OFF`
- Order references: `seedqa_paystack_ref_...`

### 2. Safe Mode
Enabled by default, prevents:
- Real Stripe/Paystack API calls
- Real SMS/email sending
- Real payment charges
- Destructive operations in production

### 3. Idempotency
Scripts can be run multiple times safely:
- Existing users are reused (by email)
- Existing vendors are reused (by userId)
- Existing products are reused (by vendorId + title)
- No duplicate data on rerun

### 4. Cleanup Safety
Cleanup script:
- Only touches QA-prefixed data
- Maintains referential integrity
- Dry-run mode by default
- Requires explicit `--confirm` flag

### 5. No Real Money
- Uses test payment IDs: `pi_seedqa_...`
- Uses test Paystack refs: `seedqa_paystack_...`
- No real charges unless explicitly enabled

## Test Data Structure

### Users

**Admin:**
- Email: `seed_qa_admin@example.com`
- Password: `SeedQA123!`
- Role: ADMIN

**Buyers:**
- Emails: `seed_qa_buyer001@example.com` to `seed_qa_buyer020@example.com`
- Password: `SeedQA123!`
- Countries: UK, Italy, Nigeria, Ghana, Kenya, US (rotated)
- Wallets: Some with balance, some empty

**Vendors:**
- Emails: `seed_qa_vendor001@example.com` to `seed_qa_vendor010@example.com`
- Password: `SeedQA123!`
- Currencies: EUR, GBP, NGN, GHS, KES, USD (based on country)
- All verified and active

### Products

**Standard Products:**
- Realistic marketplace items (olive oil, yam flour, spices, etc.)
- Prices: 10-500 currency units
- Stock: 5-100 units
- Categories: food, spices, oils, grains, sauces, snacks, beverages, beauty

**Edge Cases:**
- Low stock product (stock=1)
- Out of stock product (stock=0)
- Expensive product (500+ currency units)
- Product without image (tests fallback)

### Coupons

- `SEED_QA_10OFF` - 10% off, max 100 uses, active
- `SEED_QA_FIXED5` - Fixed 5 units off, active
- `SEED_QA_EXPIRED` - Expired coupon (tests rejection)
- `SEED_QA_LIMIT1` - Max 1 use (tests limit enforcement)

### Orders

Orders created across all statuses:
- PENDING (2) - Unpaid orders
- PAID (3) - Paid, awaiting vendor action
- PROCESSING (2) - Vendor accepted
- DELIVERED (2) - Delivered, awaiting review
- COMPLETED (2) - Completed, funds released
- REFUNDED (1) - Refunded order
- DISPUTED (1) - Disputed order

Each paid order has:
- Matching Payment record
- Matching WalletTransaction
- Correct vendor wallet balance

### Carts

- Buyer 1: Empty cart
- Buyer 2: One product
- Buyer 3: Multiple items, same vendor
- Buyer 4: Multiple vendors (if supported)
- Buyer 5: Out-of-stock product
- Buyer 6: Low-stock product
- Buyer 7: Cart with coupon applied

## Testing Workflows

### Backend API Testing

```bash
# 1. Seed data
npm run seed:qa

# 2. Run backend tests
npm test

# 3. Check wallet reconciliation
npm run reconcile:wallets

# 4. Run health check
npm run launch:health

# 5. Validate seed data
npm run validate:qa
```

### Frontend/Mobile Testing

```bash
# 1. Seed data
npm run seed:qa
npm run seed:escrow
npm run seed:otp

# 2. Get credentials
cat QA_SEED_CREDENTIALS.md

# 3. Test flows:
# - Login as buyer
# - Browse products
# - Add to cart
# - Apply coupon
# - Checkout
# - View orders
# - Leave review

# - Login as vendor
# - View dashboard
# - View orders
# - Accept/ship order
# - View wallet
# - View buyers

# - Login as admin
# - View dashboard
# - View disputes
# - Process refund
# - Manage vendors
```

### Escrow Testing

```bash
# 1. Seed escrow scenarios
npm run seed:escrow

# 2. Check report
cat ESCROW_SEED_REPORT.md

# 3. Test flows:
# - View escrow orders
# - Test auto-release
# - Test disputes
# - Test refunds
# - Test vendor payouts
```

### OTP Testing

```bash
# 1. Seed OTP scenarios
npm run seed:otp

# 2. Get OTP codes
cat OTP_SEED_REPORT.md

# 3. Test flows:
# - Verify valid OTP
# - Try expired OTP (should fail)
# - Try wrong OTP (should increment attempts)
# - Try max attempts (should lock)
# - Try used OTP (should fail)
# - Test resend cooldown
# - Test delivery OTP
```

## CI/CD Integration

```yaml
# Example GitHub Actions workflow
name: QA Seed Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Setup database
        run: |
          npm run prisma:migrate:deploy
      
      - name: Seed QA data
        run: npm run seed:qa
        env:
          QA_SEED_COUNTS: small
          QA_SEED_SAFE_MODE: true
      
      - name: Validate seed data
        run: npm run validate:qa
      
      - name: Run tests
        run: npm test
      
      - name: Check wallet reconciliation
        run: npm run reconcile:wallets
      
      - name: Cleanup
        run: npm run cleanup:qa -- --confirm
        if: always()
```

## Troubleshooting

### Issue: Unique constraint violation

**Cause:** Data already exists from previous seed

**Solution:**
```bash
npm run cleanup:qa -- --confirm
npm run seed:qa
```

### Issue: Wallet reconciliation fails

**Cause:** Mismatch between orders and wallet balances

**Solution:**
```bash
# Check detailed report
npm run reconcile:wallets

# Re-seed with clean state
npm run cleanup:qa -- --confirm
npm run seed:qa
npm run validate:qa
```

### Issue: Products not showing in catalog

**Cause:** Products inactive or wrong currency

**Solution:**
```bash
# Check validation
npm run validate:qa

# Check products
psql $DATABASE_URL -c "SELECT id, title, isActive, currency FROM \"Product\" WHERE title LIKE 'SEED_QA_%' LIMIT 10;"
```

### Issue: OTP verification fails

**Cause:** OTP expired, wrong code, or max attempts

**Solution:**
```bash
# Re-seed OTPs
npm run seed:otp

# Use exact codes from report
cat OTP_SEED_REPORT.md
```

### Issue: Cleanup doesn't remove all data

**Cause:** Referential integrity or missing prefix

**Solution:**
```bash
# Check what remains
npm run cleanup:qa -- --dry-run

# Force cleanup with different prefix
QA_SEED_PREFIX=SEED_QA_ npm run cleanup:qa -- --confirm
```

## Best Practices

1. **Always validate after seeding:**
   ```bash
   npm run seed:qa && npm run validate:qa
   ```

2. **Use dry-run before cleanup:**
   ```bash
   npm run cleanup:qa -- --dry-run
   ```

3. **Keep credentials file secure:**
   - Never commit `QA_SEED_CREDENTIALS.md`
   - Already in `.gitignore`

4. **Use appropriate scale:**
   - `small` for local dev
   - `medium` for staging
   - `large` for load testing

5. **Clean up after testing:**
   ```bash
   npm run cleanup:qa -- --confirm
   ```

6. **Test in safe mode first:**
   ```bash
   QA_SEED_SAFE_MODE=true npm run seed:qa
   ```

7. **Validate before production:**
   - Never run seed scripts in production
   - Use separate test database
   - Check `NODE_ENV` before running

## Files Generated

| File | Description | Commit? |
|------|-------------|---------|
| `QA_SEED_CREDENTIALS.md` | Login credentials | ❌ NO |
| `QA_SEED_REPORT.json` | Structured data report | ❌ NO |
| `QA_CLEANUP_REPORT.json` | Cleanup results | ❌ NO |
| `QA_SEED_VALIDATION_REPORT.json` | Validation results | ❌ NO |
| `ESCROW_SEED_REPORT.md` | Escrow scenarios | ❌ NO |
| `OTP_SEED_REPORT.md` | OTP codes | ❌ NO |
| `OTP_SEED_REPORT.json` | OTP data | ❌ NO |
| `QA_TEST_DATA_INDEX.md` | Documentation | ✅ YES |

## Support

For issues or questions:
1. Check this documentation
2. Check `QA_TEST_DATA_INDEX.md`
3. Run validation: `npm run validate:qa`
4. Check individual report files
5. Review backend logs
6. Try cleanup and re-seed

## Future Enhancements

Potential additions:
- [ ] Subscription scenarios
- [ ] Referral scenarios
- [ ] Multi-currency checkout
- [ ] Bulk order scenarios
- [ ] Vendor subscription tiers
- [ ] Advanced dispute scenarios
- [ ] Payout batch scenarios
- [ ] Tax calculation scenarios
- [ ] Shipping tracking scenarios
- [ ] Return/exchange scenarios
