# ADR-0007: Internal Payment Provider Abstraction

## Context
The architecture doc requires business modules to depend on an internal
`PaymentProvider` interface rather than importing the Stripe SDK or the
Paystack client directly. The existing codebase (see ADR-0001) has ~2,500
lines of deeply tested, metadata-driven, multi-vendor checkout and webhook
logic (`payments.service.ts`, `stripe.service.ts`, `paystack.service.ts`)
calling Stripe/Paystack directly.

## Decision
Add the interface (`src/modules/payments/provider/payment-provider.interface.ts`)
and two adapters (`stripe-provider.ts`, `paystack-provider.ts`) that wrap
the existing `lib/stripe.ts` / `lib/paystack.ts` clients — no new Stripe/
Paystack logic, just a provider-neutral shape around calls already used
elsewhere.

**Do not** migrate the existing checkout/webhook hot paths onto this
interface in the same pass that introduces it. Those flows are
Serializable-transaction, idempotency-key, multi-vendor-split code with
zero test coverage for a generic interface layer — retrofitting them
without dedicated regression time risks the exact thing the architecture
doc explicitly forbids ("do NOT break existing Stripe/Paystack flows").

## Adoption Plan
1. New payment-related code goes through `PaymentProvider` from day one.
2. Migrate one isolated, already-idempotent flow at a time (e.g. the
   Community Buy refund requery path), with full before/after test runs.
3. Only once several flows are migrated and stable, consider migrating
   `payments.service.ts`'s core checkout path — that one last, since it's
   the highest-traffic and highest-risk.

## Known Gaps in the Adapters (disclosed, not silent)
- `paystackProvider.verifyTransfer` and `reconcileTransactions` throw
  `501 PROVIDER_NOT_IMPLEMENTED` — `lib/paystack.ts` has no transfer-status
  or transaction-list endpoint wired yet.
- `paystackProvider` has no customer/saved-payment-method/authorisation
  concept — Paystack's integration here is single-charge, redirect-based.
  Those interface methods throw `PROVIDER_UNSUPPORTED_OPERATION` rather
  than faking behavior the provider doesn't have.
