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

## Paystack reconciliation — explicit launch-scope decision (2026-09)
Confirmed **out of scope for the current launch** rather than an oversight:
- `payment-provider.factory.ts` only routes a vendor to Paystack when their
  country is Nigeria/Ghana; the current launch's markets
  (`market-configuration.service.ts`'s `INITIAL_MARKETS`) are GB, US, CA,
  and the approved European countries — no African market is enabled.
- `PAYSTACK_SECRET_KEY` is not set in the production environment, so
  `paystack.isConfigured()` is `false` and Paystack calls are inert there
  today regardless of any vendor's country value.
- Building real Paystack reconciliation now would mean adding the
  transaction-list integration this ADR already flags as unbuilt, purely
  to satisfy a checklist item for a rail nothing in the current launch
  exercises — a real engineering-risk-for-no-current-benefit trade the
  architecture doc's own "do NOT break existing flows" instruction argues
  against. Revisit when Africa is actually enabled (see the market seed
  list's own comment on why Africa is deliberately absent from it).
