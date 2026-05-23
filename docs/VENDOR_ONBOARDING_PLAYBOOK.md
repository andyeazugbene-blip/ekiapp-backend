# Vendor Onboarding Playbook

## Stripe Vendor Flow (UK/EU/US)

1. **Register** → `POST /auth/register` (creates BUYER)
2. **Create vendor profile** → `POST /vendors` (promotes to VENDOR, returns fresh JWT)
3. **Email OTP verification** → `POST /auth/send-otp` + `POST /auth/verify-otp`
4. **Submit verification documents** → `POST /vendors/me/verification`
5. **Admin approves** → `PATCH /admin/vendors/:id/approve` (sets VERIFIED)
6. **Stripe Connect onboarding** → `POST /vendors/me/stripe-connect/onboard`
7. **Stripe verifies** → account.updated webhook
8. **Payouts enabled** → vendor can receive Stripe payouts

### Document Requirements
- Government-issued ID (front + back)
- Business registration (if applicable)
- Bank account details (for Stripe Connect)

## Paystack Vendor Flow (Nigeria/Ghana/Kenya/SA)

1. **Register** → same as above
2. **Create vendor profile** → `POST /vendors` with country=Nigeria/Ghana
3. **Email OTP verification** → same
4. **Register bank account** → `POST /vendors/me/bank-accounts`
   - Validates via Paystack Resolve Account API
   - Creates Paystack transfer recipient
5. **Admin approves** → `PATCH /admin/vendors/:id/approve`
6. **Vendor can receive payouts** via Paystack Transfer

### Document Requirements
- Valid bank account (verified via Paystack)
- Business name matching account name

## Country/Currency Mapping

| Country | Currency | Payment Rail | Payout Method |
|---------|----------|--------------|---------------|
| United Kingdom | GBP | Stripe | Stripe Connect |
| Italy / EU | EUR | Stripe | Stripe Connect |
| United States | USD | Stripe | Stripe Connect |
| Nigeria | NGN | Paystack | Paystack Transfer |
| Ghana | GHS | Paystack | Paystack Transfer |
| Kenya | KES | Paystack | Paystack Transfer |
| South Africa | ZAR | Paystack | Paystack Transfer |

## Admin Actions

### Approve Vendor
```
PATCH /api/admin/vendors/:id/approve
```

### Reject Vendor
```
PATCH /api/admin/vendors/:id/reject
Body: { "reason": "..." }
```

### Suspend Vendor
```
PATCH /api/admin/vendors/:id/suspend
Body: { "reason": "..." }
```

### Unsuspend Vendor
```
PATCH /api/admin/vendors/:id/unsuspend
```
