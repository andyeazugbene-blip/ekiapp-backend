# ADR-0003: Paystack Escrow Model (Domestic Africa)

## Context
African domestic orders need delivery confirmation before vendor payout. Without escrow, buyers can claim non-delivery and vendors can ship nothing. A physical OTP bridges the trust gap.

## Decision
- Buyer pays via Paystack → funds held in Eki's Paystack balance (escrow pool)
- Vendor confirms order within 48h or auto-cancel + refund
- Vendor marks dispatched → 6-digit OTP generated (shown once, hash-only stored)
- Rider tells buyer the code → buyer enters in app → payment releases
- If no action in 24h → auto-release to vendor
- Buyer can dispute before 24h expires → escrow frozen → admin resolves

## Alternatives Considered
- **Paystack Escrow API:** Doesn't exist as a native product.
- **Third-party escrow service:** Adds cost and integration complexity.
- **No escrow (trust-based):** Unacceptable fraud risk in the target market.

## Consequences
- New order statuses: PAYMENT_SECURED, VENDOR_CONFIRMED, DISPUTED, AUTO_RELEASED
- Background workers needed: vendor timeout (15min), auto-release (15min)
- Buyer trust score tracks behavior (+2 OTP, -1 auto-release, -20 fraud)
- Admin dispute resolution with three outcomes (vendor/buyer/partial)
- Eki's Paystack balance must always cover outstanding escrow orders

## Operational Notes
- Balance monitoring: `GET /admin/escrow/health`
- Workers: `escrow-vendor-timeout`, `escrow-auto-release` (require Redis/BullMQ)
- OTP is NEVER sent electronically — only shown on vendor's screen
- Delivery OTP model: `DeliveryOtp` with hash-only storage, 5 attempts, 24h expiry
