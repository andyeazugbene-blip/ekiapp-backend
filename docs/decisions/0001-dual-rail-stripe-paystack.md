# ADR-0001: Dual Payment Rail (Stripe + Paystack)

## Context
Eki serves two vendor segments: diaspora vendors (UK/EU/US) selling internationally, and African vendors (Nigeria/Ghana) selling domestically. No single payment provider covers both segments well.

## Decision
Run Stripe and Paystack in parallel. Vendor country determines which rail is used. The checkout service branches based on vendor market.

## Alternatives Considered
- **Stripe only:** Poor payout reach into African local banks. Stripe Connect doesn't support NGN/GHS payouts to local accounts.
- **Paystack only:** No coverage for UK/EU/US card acquiring or SEPA/Apple Pay.
- **Flutterwave:** Covers more African countries but less mature for EU/UK acquiring.

## Consequences
- Two webhook handlers to maintain (Stripe + Paystack)
- Two refund paths in admin controller
- Two reconciliation scripts
- Vendor.currency determines which rail processes the order
- Frontend must handle both Stripe PaymentSheet and Paystack inline

## Operational Notes
- Stripe webhook: `/api/stripe/webhook` (signature: HMAC-SHA256)
- Paystack webhook: `/api/paystack/webhook` (signature: HMAC-SHA512)
- Both use WebhookEvent table for idempotency
- Reconciliation: `npm run reconcile:stripe` and `npm run reconcile:paystack`
