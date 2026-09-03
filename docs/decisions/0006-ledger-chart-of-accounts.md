# ADR-0006: Internal Ledger — Chart of Accounts (Engineering Default)

## Context
The A→Z gap-closure pass (2026-09) added a double-entry ledger
(`LedgerAccount`/`LedgerEntry`, `src/modules/ledger/ledger.service.ts`) as
additive bookkeeping alongside the existing `Payment`/`Order`/`Wallet`
records. The architecture doc requires the framework but explicitly does
not specify which account each event should post to — that's an accounting
policy decision, not an engineering one.

## Decision
Ship the technical framework (append-only entries, reversing corrections,
balanced compound postings) with a DEFAULT chart of accounts wired into the
two highest-volume payment paths:

- `LedgerAccountType.PROVIDER_CASH` — debited for the full amount when a
  Stripe card payment or Paystack escrow payment is captured.
- `LedgerAccountType.VENDOR_PAYABLE` (per vendor) — credited for
  `vendorEarningsAmount`.
- `LedgerAccountType.PLATFORM_FEE_REVENUE` — credited for `platformFeeAmount`.
- On refund: every entry for the original `businessRefType`/`businessRefId`
  is reversed (opposite direction, same accounts), via `reverseEntries()`.

This mapping is **not** confirmed accounting policy. It has not been
reviewed by finance. It is the engineering team's best-effort default so
the framework is exercised by real money movement instead of sitting
unused, and so real balances exist to review once policy is confirmed.

## Not Yet Wired
Community Buy contributions, wallet top-ups, gift card purchases, vendor
subscription billing, and payouts-to-bank (`PayoutRequest`) do not post
ledger entries yet. Wiring these is mechanical (same pattern) but was left
undone this pass rather than rushed across every financial code path
without dedicated review time.

## Required Before This Is Load-Bearing
1. Finance/business sign-off on the account mapping above (does platform
   fee revenue recognize at capture or at settlement? does a chargeback
   post differently from a buyer-initiated refund? etc.).
2. Wiring the remaining event types listed above.
3. A reconciliation job that actually populates `ReconciliationRun`/
   `ReconciliationDifference` — the models exist; nothing runs them yet.

Until then, treat ledger balances as directionally useful, not authoritative.
