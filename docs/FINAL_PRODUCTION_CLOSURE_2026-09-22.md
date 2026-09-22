# Eki — Final Production Closure Report

**Date**: 2026-09-22
**Scope**: "EKI — FINAL PRODUCTION CLOSURE" client directive — Community Buy Europe expansion, operational-threshold defaults, Android/iOS production builds + TestFlight, Community Buy financial gates, final regression.

---

## 1. Community Buy market configuration (FINAL)

**Enabled (43 markets)**: GB, US, CA, FR, ES, PT, CH, BE, IT, HR, DE, NL, AT, IE, LU, GR, CY, MT, SI, SK, EE, LV, LT, FI, PL, CZ, HU, RO, BG, DK, SE, NO, IS, LI, MC, AD, SM, BA, RS, ME, MK, AL, MD.

Every enabled market has: `communityBuyEnabled=true`, `organiserApplicationsEnabled=true`, `supplierApplicationsEnabled=true`, `communityBuyPaymentsEnabled=true`, `communityBuyPaymentMode=PLEDGE_THEN_CHARGE`, `paymentProvider=stripe`, `paymentMode=LIVE`, `identityProvider=stripe_identity`, and the correct local currency (see `src/modules/community-buy/market-configuration.service.ts` `INITIAL_MARKETS` / `src/shared/currency.ts` `MARKET_CODE_COUNTRY_NAMES` — the single source of truth, kept in sync).

**Disabled**: every African country — zero `MarketConfiguration` rows exist for Africa. Not a code gate; omission from the market list is what keeps it unavailable.

**Deliberately excluded from "Europe"** (no broader Europe registry existed anywhere in this codebase before this change — this list was built as a standard, defensible European-sovereign-state set, UN M49 "Europe" region, restricted to a real ISO 3166-1 alpha-2 code + a Stripe-supported currency):
- **Russia, Belarus, Ukraine** — none of RUB/BYN/UAH is Stripe-supported (checked against `STRIPE_SUPPORTED_CURRENCIES`); Russia/Belarus are also under active international sanctions and Ukraine is in active conflict.
- **Kosovo** — no standard, universally-assigned ISO 3166-1 alpha-2 code.
- **Vatican City** — a real ISO code but no realistic resident/commercial population to serve.

**Evidence**: LIVE-INFRA — `GET https://ekiapp-backend.vercel.app/api/community-buy/markets` returns all 43 markets in the enabled state described above, zero African entries, confirmed against the real production API after the production deploy that shipped this change. Also verified via direct psql query against the QA sandbox Postgres before deployment (`docker exec eki-qa-postgres psql ...`). AT (automated test): `market-configuration-launch.test.ts`, `market-country-normalization.test.ts` — both updated and passing.

**Migration**: `prisma/migrations/20260921234014_community_buy_europe_expansion` — `INSERT ... ON CONFLICT ("countryCode") DO UPDATE` (never a plain `UPDATE`, which would silently no-op on rows that don't exist yet — the exact bug found and fixed during the original 10-market rollout).

---

## 2. Operational thresholds — default to 1

`PRICE_APPROVAL_TIMEOUT_HOURS`, `FULFILMENT_STALE_THRESHOLD_HOURS`, `PAYOUT_STUCK_THRESHOLD_HOURS` now default to **1** instead of being unconfigured. Implemented entirely in the DB/configuration layer:

- `adminPlatformSettingsService.ensureDefaults()` (new) — mirrors `marketConfigurationService.ensureDefaults()`'s existing pattern. Called from `getValue()`/`list()`. Seeds any of the three keys with no row yet to value `1`, using `upsert({ update: {} , create: {...} })` — an already-existing row is never touched, even under a race.
- `prisma/migrations/20260921234202_operational_threshold_defaults` — one-time data migration, `INSERT ... ON CONFLICT ("key") DO NOTHING`, so an already-running production environment gets the default immediately at deploy time rather than waiting for its first read.
- No `.env`/hardcoded fallback anywhere — `config/env.ts`'s three threshold getters and their `env.*` fields were already deleted in the prior session; nothing was reintroduced.

**Evidence**: LIVE-LOCAL — verified directly against the real QA Postgres instance: `FULFILMENT_STALE_THRESHOLD_HOURS` and `PAYOUT_STUCK_THRESHOLD_HOURS` were correctly seeded to `1`, while `PRICE_APPROVAL_TIMEOUT_HOURS` (which had already been set to `48` by a real admin earlier in this engagement, via the real admin-web UI) was **left untouched at 48** — direct, real proof that the "never overwrite an existing configured value" guarantee holds. Production: the matching migration shipped in the same deploy as the market-configuration migration above; since that deploy succeeded and the market data is confirmed live (§1), the threshold migration in the same `prisma migrate deploy` run also succeeded (a failure would have failed the whole `vercel-build` step and the deploy). Not independently re-queried against production via an authenticated admin call — no real production admin credentials were available in this environment. AT: `admin-platform-settings.test.ts` — updated with new default/no-overwrite/partial-seed test cases, all passing.

---

## 3. Community Buy financial gates (production)

| Gate | Before this session | After this session | Action |
|---|---|---|---|
| `COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED` | `true` (set 1 day prior) | `true` | none needed |
| `COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED` | unset (OFF) | `true` | added to production, this session |
| `COMMUNITY_BUY_ORGANISER_PAYOUT_ENABLED` | unset (OFF) | `true` | added to production, this session |
| `COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED` | unset (OFF) | `true` | added to production, this session |

Set via `vercel env add <KEY> production --value true` against the real `ekiapp-backend` Vercel project (confirmed authenticated as `andyeazugbene-blip`, the real project owner), with explicit user confirmation obtained before making this change given it directly gates real Stripe transfers to real supplier/organiser bank accounts. Three of the four gates are captured as **module-level constants at import time** (`campaign-payout.service.ts`, `organiser-fee.service.ts`, `organiser-payout.service.ts`) — a live process would not pick up a newly-added env var without restarting, so an explicit production redeploy was triggered (`vercel redeploy`, deployment `dpl_J38or99T5YGXtmSjj4vz2hPJE1Af`, created 2026-09-22 00:55:41 UTC+1) to guarantee every running instance reads the new values. That deployment is confirmed **Ready** and aliased to all production domains (`www.culinarytales.app`, `ekiapp-backend.vercel.app`, `culinarytales.app`) — reconfirmed healthy via `GET /api/health/detailed` after the redeploy.

No application-level security, authorization, or ledger logic was changed to accomplish this — only the pre-existing, already-tested env-var gates were set to the values the client explicitly approved. Supplier/organiser payout paths (`releaseSupplierPayment()`, `organiserFeeService`, `organiserPayoutService`) remain gated behind their existing admin authentication, 2FA, and four-eyes-approval checks exactly as before.

**Evidence**: LIVE-INFRA — `vercel env ls production` confirms all four keys present in Production immediately after the change; the redeploy is confirmed `Ready` and live. Not verified via an actual campaign payout (no real financial transaction was created to "prove" this, per standing instruction not to create transactions solely to demonstrate configuration).

---

## 4. Mobile release builds

### iOS — PRODUCTION BUILD + TESTFLIGHT SUBMITTED

- Build: version `1.5.6`, build number `119`, commit `fa99f56`, SDK 57, profile `production`, distribution `store`.
- Build ID: `97f11524-2442-4f86-a770-9649fd5008eb` — **Status: finished**. Real `.ipa`: `https://expo.dev/artifacts/eas/zLhvy5jykoPxYm8HfF7I3i6NetrDIPWNLZbBps3Zpuk.ipa`.
- Credentials verified live and valid before building: Distribution Certificate (expires 2027-09-04), Provisioning Profile (active, expires 2027-09-04), Apple Team `83BMQKN6K7` (EHIMA GROUP LTD).
- TestFlight submission: `eas submit --platform ios` — **confirmed successful**: *"Your binary has been successfully uploaded to App Store Connect!"* Submission ID `d37dbe4e-4fde-4ed3-b6d1-02af1b1158d9`, ASC App ID `6776307497`.
- Apple's own post-upload processing (typically 5–10 minutes) was not independently re-confirmed from this environment (no App Store Connect dashboard login available here) — direct link for the client to confirm: `https://appstoreconnect.apple.com/apps/6776307497/testflight/ios`.

### Android — NOT rebuilt this session (explicit client choice)

The client explicitly chose iOS-only for this closure pass. No new Android build was triggered. Last known production Android build remains current: version `1.5.6`, version code `107`, build ID `bc9b50b4-2fb4-45e8-92cd-6198b9b8ed22`, status finished (from a prior session, commit `5693b78`) — matches the version code currently in `app.json`, so it is not stale relative to the current release.

**Evidence**: LIVE-INFRA (real EAS/Apple API calls, real build artifact, real ASC submission confirmation) — the strongest evidence tier available short of a physical device install.

---

## 5. Final regression (this session)

| Area | Result |
|---|---|
| Backend test suite | **2398/2398 passed** (148 files) |
| Backend typecheck (`tsc --noEmit`) | Clean |
| Backend scaffolding/no-mock scan | Clean (453 files scanned) |
| Backend `prisma migrate status` | Up to date, no drift |
| Mobile typecheck | Clean |
| Mobile `check:no-mock-data` | Pass (169 files) |
| Mobile `check:no-screenshot-ui` | Pass |
| Mobile `check:no-old-domain` | Pass (282 files) |
| Mobile `check:release-config` | Pass |
| Mobile `check:tab-registration` | Pass |
| Mobile `check:hero-four-entry-points` | Pass |
| Mobile `check:supplier-routing-and-copy` | Pass |
| Mobile `check:domains` (live) | Pass — 6/6 live checks (primary/www domain, API health, store routes) |
| Admin-web typecheck | Clean |
| Admin-web lint | Clean (1 pre-existing, unrelated warning: `community-data-access/page.tsx` missing `useEffect` dep) |
| Admin-web production build | Succeeds, all routes compile |

---

## 6. Live financial E2E — per client instruction

Per explicit client direction, buyer payment, application fee, vendor balance, payout, refund, dispute/chargeback, webhook reconciliation, Community Buy pledge→charge, supplier settlement, and payment recovery were **already established and verified in prior sessions** of this engagement and were **not re-tested with new real transactions** this session — no new live charge, refund, transfer, or payout was created solely to "re-prove" configuration. Read-only checks (health endpoint, market API, deployment status) were used wherever verification was needed instead.

---

## 7. Production external configuration — read-only verification this session

- `GET /api/health/detailed` (live, checked before and after the redeploy in §3): `database: ok`, `stripe: ok (live)`, `stripe_raw: ok`, `storage: ok`, `paystack: skipped (PAYSTACK_SECRET_KEY not configured)` — expected and correct, since Africa (the only market that would need Paystack) is not part of this launch.
- `vercel env ls production` (real, authenticated): confirmed `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `S3_*`, `JWT_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `CRON_SECRET`, `TURNSTILE_SECRET_KEY`, and all four Community Buy gates are present in Production. `PAYSTACK_SECRET_KEY` confirmed absent (expected).
- `vercel.json` confirms a daily cron (`/api/internal/jobs/daily-sweep`) is registered.
- No new production configuration investigation beyond what this closure pass needed — per client instruction not to restart already-completed system investigations from prior sessions.

---

## 8. Known limitations / remaining external actions

1. **iOS TestFlight processing** — upload confirmed successful; Apple's own "finished processing" state was not independently re-confirmed from this environment. Client should check `https://appstoreconnect.apple.com/apps/6776307497/testflight/ios` directly.
2. **Android production build** — not rebuilt this session (client's explicit choice to do iOS only this pass). The existing production build (version 1.5.6, code 107) remains current; a fresh Android build can be run identically to the iOS one whenever the client wants it (`eas build --platform android --profile production --non-interactive`).
3. **Operational-threshold defaults in production** — inferred successful (same deploy that successfully shipped the market-configuration data), not independently re-queried via an authenticated production admin call (no real production admin credentials were available in this environment).
4. **Paystack / African markets** — still unconfigured, as required; not a blocker for this launch.
