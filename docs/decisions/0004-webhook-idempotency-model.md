# ADR-0004: Webhook Idempotency Model

## Context
Payment providers retry webhook deliveries. Without idempotency, retries can double-credit vendor wallets, double-debit buyer wallets, or create duplicate orders.

## Decision
- `WebhookEvent` table with unique constraint on `stripeEventId`
- For Stripe: event ID is the Stripe event ID (e.g., `evt_xxx`)
- For Paystack: event ID is `paystack:{reference}` (reference is unique per transaction)
- First insert succeeds → process the event
- Duplicate insert throws P2002 → return `{ received: true, duplicate: true }`
- All webhook processing runs in Serializable isolation transactions

## Alternatives Considered
- **Read-then-write check:** Race condition — two concurrent requests both pass the read.
- **Redis dedup:** Adds infrastructure dependency; DB constraint is simpler and durable.
- **Stripe event replay protection only:** Doesn't cover Paystack.

## Consequences
- Every webhook handler must attempt WebhookEvent insert BEFORE processing
- P2002 catch returns 200 to the provider (prevents retry storms)
- Permanent validation failures (amount mismatch, etc.) return 200 with `ignored: true`
- Only signature failures return 400

## Operational Notes
- Table: `WebhookEvent` with columns: stripeEventId (unique), eventType, provider, status, processedAt
- Stripe handler: `src/modules/stripe/stripe.service.ts`
- Paystack handler: `src/modules/paystack/paystack.service.ts`
