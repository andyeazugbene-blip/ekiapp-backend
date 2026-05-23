# ADR-0002: Per-Vendor Currency Model

## Context
Vendors operate in different markets with different currencies. A UK vendor prices in GBP, a Nigerian vendor in NGN. A global DEFAULT_CURRENCY creates reconciliation problems.

## Decision
- `Vendor.currency` is required, derived from `Vendor.country` at creation time
- `Product.currency` always inherits from `Vendor.currency` (input.currency ignored)
- Supported whitelist: GBP, EUR, USD, NGN, GHS, KES, ZAR
- Country-to-currency mapping in `src/shared/currency.ts`

## Alternatives Considered
- **Global EUR default:** Breaks for non-EU vendors. Wallet/payout currency mismatch.
- **User-editable product currency:** Allows inconsistency within a vendor's catalog.
- **Multi-currency per vendor:** Over-engineering for current product scope.

## Consequences
- Buyer sees prices in vendor's currency (no platform-side FX)
- Buyer's bank handles FX if paying cross-currency
- Orders, payments, wallets all use vendor currency
- Frontend must display correct currency symbol per product
- Cannot mix currencies in a single cart (enforced by checkout validation)

## Operational Notes
- Migration `20260522_vendor_currency` backfills existing vendors
- Migration `20260522_currency_uppercase` normalizes all rows to uppercase
- `currencyFromCountry()` in `src/shared/currency.ts` is the single source of truth
