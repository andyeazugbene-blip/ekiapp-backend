# Refund SLA

## Public Wording
> Refund requests are reviewed within 24 hours. Approved refunds are processed within 3 business days.

## Internal Admin SLA
- **First response:** within 24 hours of request
- **Decision:** within 48 hours
- **Processing:** within 3 business days after approval
- **Partial refunds:** require senior admin approval

## Escalation Flow
1. Support agent receives refund request
2. Agent reviews order history, delivery status, dispute history
3. If straightforward (undelivered, damaged): approve immediately
4. If complex (partial, post-delivery, disputed): escalate to senior admin
5. Senior admin decides within 48h
6. Refund issued via `POST /admin/orders/:id/refund`

## First 10 Refunds
- Extra review by founding team
- Document reason and outcome
- Use to calibrate future policy

## After-Delivery Refund Handling
- If buyer entered OTP (escrow): transaction is final, no refund
- If order was auto-released: refund possible within 7 days
- If goods are defective: full refund, vendor bears cost
- If buyer changed mind (EU 14-day right): full refund, buyer returns goods

## Partial Refund
- Admin specifies `amount` in refund request
- Order status: REFUNDED (even for partial — simplifies logic)
- Vendor wallet credit reversed proportionally
