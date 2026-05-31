# QA Seed System - Quick Reference Card

## 🚀 Quick Commands

```bash
# Seed everything
npm run seed:qa && npm run seed:escrow && npm run seed:otp

# Validate
npm run validate:qa

# Cleanup (preview)
npm run cleanup:qa -- --dry-run

# Cleanup (confirm)
npm run cleanup:qa -- --confirm
```

## 🔑 Default Credentials

| Role   | Email                              | Password    |
|--------|------------------------------------|-------------|
| Admin  | seed_qa_admin@example.com          | SeedQA123!  |
| Buyer  | seed_qa_buyer001@example.com       | SeedQA123!  |
| Vendor | seed_qa_vendor001@example.com      | SeedQA123!  |

## 🎫 Test Coupons

| Code              | Type       | Value | Status  |
|-------------------|------------|-------|---------|
| SEED_QA_10OFF     | Percentage | 10%   | Active  |
| SEED_QA_FIXED5    | Fixed      | 5     | Active  |
| SEED_QA_EXPIRED   | Percentage | 20%   | Expired |
| SEED_QA_LIMIT1    | Percentage | 15%   | Limited |

## 📦 Order Statuses

- PENDING (2 orders)
- PAID (3 orders)
- PROCESSING (2 orders)
- DELIVERED (2 orders)
- COMPLETED (2 orders)
- REFUNDED (1 order)
- DISPUTED (1 order)

## 🔐 Escrow Scenarios

1. PENDING_PAYMENT
2. PAID_HELD
3. VENDOR_ACCEPTED
4. SHIPPED
5. BUYER_CONFIRMED
6. AUTO_RELEASE_READY
7. DISPUTED
8. REFUNDED
9. VENDOR_PAYOUT_READY

## 📱 OTP Scenarios

1. VALID_OTP
2. EXPIRED_OTP
3. WRONG_ATTEMPTS
4. MAX_ATTEMPTS
5. ALREADY_USED
6. RESEND_COOLDOWN
7. DELIVERY_OTP_VALID

## ⚙️ Environment Variables

```bash
QA_SEED_PREFIX=SEED_QA_              # Data prefix
QA_SEED_COUNTS=small                 # small|medium|large
QA_SEED_SAFE_MODE=true               # Safe mode
QA_ALLOW_PROVIDER_CALLS=false        # API calls
QA_ALLOW_EMAIL_SMS=false             # SMS/Email
```

## 📊 Scale Options

| Scale  | Buyers | Vendors | Products |
|--------|--------|---------|----------|
| small  | 5      | 3       | 12       |
| medium | 20     | 10      | 50       |
| large  | 50     | 20      | 200      |

## 🧪 API Test Endpoints

```bash
# Public
GET /api/products
GET /api/vendors
GET /api/reviews?productId=<id>

# Buyer
POST /api/auth/login
GET /api/cart
POST /api/cart/items
GET /api/orders

# Vendor
GET /api/vendors/me
GET /api/vendors/me/orders
GET /api/vendors/me/wallet

# Admin
GET /api/admin/dashboard
GET /api/admin/orders
GET /api/admin/disputes
```

## 📁 Generated Files

- `QA_SEED_CREDENTIALS.md` - Credentials (DO NOT COMMIT)
- `QA_SEED_REPORT.json` - Data report
- `ESCROW_SEED_REPORT.md` - Escrow details
- `OTP_SEED_REPORT.md` - OTP codes
- `QA_SEED_VALIDATION_REPORT.json` - Validation
- `QA_CLEANUP_REPORT.json` - Cleanup results

## ✅ Validation Checklist

```bash
# After seeding, run:
npm run validate:qa              # Data validation
npm run reconcile:wallets        # Wallet check
npm run launch:health            # Health check
npm test                         # Unit tests
```

## 🔄 Typical Workflow

```bash
# 1. Seed
npm run seed:qa

# 2. Validate
npm run validate:qa

# 3. Test
# Use credentials from QA_SEED_CREDENTIALS.md

# 4. Cleanup
npm run cleanup:qa -- --confirm
```

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| Duplicate error | `npm run cleanup:qa -- --confirm` |
| Wallet mismatch | `npm run reconcile:wallets` |
| Products not showing | Check `isActive` and currency |
| OTP fails | Use exact code from `OTP_SEED_REPORT.md` |

## 📚 Documentation

- `QA_TEST_DATA_INDEX.md` - Main index
- `docs/QA_SEED_SYSTEM.md` - Full documentation
- `docs/QA_SEED_ACCEPTANCE.md` - Acceptance checklist
- `QA_SEED_SUMMARY.md` - Implementation summary

## 🎯 Quick Tests

### Buyer Flow
```bash
# 1. Login: seed_qa_buyer001@example.com / SeedQA123!
# 2. Browse products (should see SEED_QA_ products)
# 3. Add to cart
# 4. Apply coupon: SEED_QA_10OFF
# 5. Checkout
# 6. View orders
```

### Vendor Flow
```bash
# 1. Login: seed_qa_vendor001@example.com / SeedQA123!
# 2. View dashboard
# 3. View orders
# 4. View wallet
# 5. View buyers
```

### Admin Flow
```bash
# 1. Login: seed_qa_admin@example.com / SeedQA123!
# 2. View dashboard
# 3. View disputes
# 4. Process refund
# 5. Manage vendors
```

## 🔒 Safety Notes

- ✅ Safe mode ON by default
- ✅ No real charges
- ✅ No real SMS/emails
- ✅ All data prefixed
- ✅ Cleanup is safe
- ✅ Credentials not committed

## 📞 Support

1. Check `QA_TEST_DATA_INDEX.md`
2. Check `docs/QA_SEED_SYSTEM.md`
3. Run `npm run validate:qa`
4. Check report files
5. Review backend logs

---

**Quick Start:** `npm run seed:qa && npm run validate:qa`  
**Quick Cleanup:** `npm run cleanup:qa -- --confirm`  
**Full Docs:** `docs/QA_SEED_SYSTEM.md`
