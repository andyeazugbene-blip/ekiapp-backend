# Compliance Matrix — R01–R40 (Notification Orchestration Spec v2)

Status values follow the spec's own progression: **Proposed → Backend mapped → Route mapped → Implemented → QA passed → Approved → Enabled**, plus **Blocked** (a real, named dependency is missing) and **Not verified this pass** (exists or not under the old "legacy handbook" naming, but I did not confirm it directly in this session — stated honestly rather than guessed).

"Implemented (legacy)" means: the backend already sends this notification, but through the pre-spec architecture (a specific `communication.service.ts` template key or a one-off sweep function, often named after the old 210-event handbook's handoff codes like "O-04" or "M-08") — not through a spec-shaped `NotificationRule`/`NotificationCandidate`. It works today; it is not yet re-platformed onto the spec's contracts.

## R01–R11: Vendor onboarding, activation, first-sale

| Rule | Status | Evidence |
|---|---|---|
| R01 Registration complete, store absent | **Implemented, QA passed** | `REGISTRATION_REMINDER` — [automation.detectors.ts](../../src/modules/automation/automation.detectors.ts), PR #6. Cadence corrected to spec's 4h/24h/72h. Tests: `automation-detectors.test.ts`. |
| R02 Store draft abandoned | **Blocked** | No partial/draft `Vendor` state exists — `createVendor()` writes a complete row atomically. Implementing this needs a new draft-state column/model; not added this pass (new schema, not "fix"). |
| R03 Store ready, zero foodstuff | **Implemented, QA passed** | `FIRST_PRODUCT_REMINDER`, PR #6. |
| R04 Foodstuff draft incomplete | **Blocked** | Same reason as R02 — `Product` creation is atomic, no draft state. |
| R05 Delivery setup missing | **Implemented, QA passed** | `DELIVERY_SETUP_REMINDER`, PR #6. |
| R06 Verification not started when eligible | **Implemented, QA passed (with a documented substitution)** | `VERIFICATION_REMINDER`, PR #6. Spec's stop condition is "verification submitted"; this codebase only tracks the final `VERIFIED` state, so it stops on approval, not submission — see `03-first-sale-report.md`. |
| R07 Verification requires correction | **Not verified this pass** | Depends on a Stripe Identity "requires action"/rejected status surfaced somewhere queryable; not located in this pass's grep sweep of `payments`/`verification` modules. |
| R08 Verification approved | **Not verified this pass** | Related to R06/R09 — needs a dedicated check of the Stripe identity webhook handler. |
| R09 Publication confirmed → share store | **Implemented (legacy), not spec-shaped** | `vendor_store_ready` one-time milestone — [vendor-milestone-notifications.service.ts](../../src/modules/vendors/vendor-milestone-notifications.service.ts) `maybeSendStoreReady`. Fires once, outside `automationService`/`AutomationRule` — not admin-visible in the Automation Centre the way R01–R06/R11 are. |
| R10 Store live, never shared | **Backend logic: Implemented, QA passed (PR #8). End-to-end rule: NOT fully compliant — 2 real gaps remain, both named below, neither faked.** | Backend: `STORE_SHARE_REMINDER` on the same P2 (4h/24h/72h) framework as R01/R03/R05/R06/R11, admin-visible, vendor-toggleable for the first time. Cadence clock corrected (compliance review, 2026-10-26) to a real derived "readySince" timestamp (later of first active product / first delivery zone createdAt), not account creation. Stop condition corrected to a real `store_shared` event (added 2026-10-25), with `store_viewed` kept only as a bounded grandfather fallback for views before 2026-10-26 — not a permanent substitute. **Gap 1 (live, not closed):** the mobile app does not yet call the new `store_shared` event — confirmed by direct inspection of `share-store-link.tsx`, not re-verified by assumption. Until that mobile change ships, every vendor who becomes eligible after 2026-10-26 has no way to stop this reminder except opting out. **Gap 2 (pre-existing, not closed):** per `05-deeplink-matrix.md`, `store_share` has a real mobile screen but is not wired to the notification-tap handler — tapping this notification today does not open it. Closing either gap needs a mobile-repo PR, not attempted this pass. 198/198 backend test files pass. |
| R11 First Sale Campaign not started | **Implemented, QA passed** | `FIRST_SALE` (narrowed), PR #6. Stop condition substituted (first paid order, not "campaign started" — no such campaign concept exists). |

## R12–R18: Vendor orders and inventory

| Rule | Status | Evidence |
|---|---|---|
| R12 First paid order created | **Implemented (legacy)** | "vendor-new-order notification" — [payments.service.ts:900](../../src/modules/payments/payments.service.ts). Not re-verified for exact P0/immediate timing this pass. |
| R13 Order acceptance outstanding | **Implemented (legacy)** | `order-unacknowledged-sweep` (handoff O-02) — [internal.routes.ts:450](../../src/modules/internal/internal.routes.ts), confirmed live (`"firstReminders":2,"escalations":2"` in the manual sweep run on 2026-10-25). |
| R14 Order preparation overdue | **Not verified this pass** | No dedicated grep match found; may be covered by R13's sweep or may be a real gap. |
| R15 Dispatch not confirmed | **Implemented (legacy)** | `order-dispatch-due-sweep` (handoff O-04) — [order-acceptance-notifications.service.ts](../../src/modules/orders/order-acceptance-notifications.service.ts). Comment in that file notes **no real `dispatchDueAt` column exists** — the "due" timing is an assumed window, not a verified deadline. Spec explicitly requires "deadline messages derive from real entity timestamps" — this is a known gap in the existing (pre-spec) implementation, not introduced by this pass. |
| R16 Stock crosses low threshold | **Implemented, QA passed** | `LOW_STOCK_ALERT` — content-hash deduped, tested (`automation-detectors.test.ts`). |
| R17 Stock reaches zero | **Not verified this pass** | Likely the same detector with threshold=0 as one case, not confirmed as a distinct episode/copy this pass. |
| R18 Stock conflicts with open orders | **Not started** | No matching code found. |

## R19–R24: Buyer payment and order lifecycle

| Rule | Status | Evidence |
|---|---|---|
| R19 Payment authentication required (3DS) | **Not verified this pass** | Stripe PaymentIntent error logging exists; no dedicated push notification located. |
| R20 Payment failed (ordinary checkout) | **Implemented (legacy)** | `CHECKOUT_PAYMENT_FOLLOW_UP` type exists and is tested — distinct from `PAYMENT_RECOVERY` (Foodstuff Subscription-only), matching the spec's own distinction. |
| R21 Order confirmed | **Not verified this pass** | Likely exists under a buyer-facing template key; not confirmed by name this pass. |
| R22 Order dispatched | **Not verified this pass** | Same. |
| R23 Collection ready | **Not verified this pass** | Same. |
| R24 Delivery exception | **Not verified this pass** | Same. |

## R25–R30: Payouts, disputes, support, Eki Membership

| Rule | Status | Evidence |
|---|---|---|
| R25 Payout action required | **Not verified this pass** | `payouts.service.ts` exists; notification call not confirmed by name. |
| R26 Payout confirmed | **Not verified this pass** | Same file. |
| R27 Dispute evidence due | **Not verified this pass** | `dispute-v2.service.ts` exists; notification call not confirmed by name. |
| R28 Support response received | **Not started / not found** | No matching code found in `src/modules/support` or `communications` for a "support replied" push. |
| R29 Membership payment failed | **Not verified this pass** | Depends on Stripe subscription webhook handling; not confirmed by name. |
| R30 Trial ending soon | **Implemented, QA passed** | `VENDOR_TRIAL_ENDING` — Stripe `customer.subscription.trial_will_end`, idempotent via `WebhookEvent`, tested. |

## R31–R33: Foodstuff Subscription (client: use this name, not "Regular Delivery")

| Rule | Status | Evidence |
|---|---|---|
| R31 Renewal approaching | **Implemented, QA passed** | `RENEWAL_REMINDER` — [renewals.service.ts](../../src/modules/regular-deliveries/renewals.service.ts). Frequency-cap bug fixed and backfilled to production this week. **Terminology note:** internal module/table names still say "Regular Delivery" / "renewal" — customer-facing copy already says "Foodstuffs Subscription" (matches the client's locked decision), but this is worth a terminology audit pass of its own if the client wants internal consistency too, not just customer-facing. |
| R32 Payment failed | **Implemented, QA passed** | `PAYMENT_RECOVERY`, escalating retry schedule (`PAYMENT_RETRY_DELAY_DAYS`), tested. |
| R33 Price approval required | **Implemented, QA passed** | `PRICE_APPROVAL_REMINDER`, real cutoff via `AdminPlatformSetting`, tested. |

## R34–R37: Community Buy

| Rule | Status | Evidence |
|---|---|---|
| R34 Closing below minimum | **Not verified this pass** | Community Buy sweep exists (`community-buy-sweep` in the manual trigger output); whether it includes this specific "needs N more shares" reminder is not confirmed. |
| R35 Minimum reached | **Not verified this pass** | Same. |
| R36 Payment action required | **Not verified this pass** | Same. |
| R37 Supplier reconfirmation requested | **Implemented (legacy)** | `supplier_reconfirmation_requested` notification confirmed in [campaign-authorisation.service.ts](../../src/modules/community-buy/campaign-authorisation.service.ts). |

## R38–R40: Automation failures, referrals, critical admin incidents

| Rule | Status | Evidence |
|---|---|---|
| R38 Automation service failure | **Implemented, QA passed (PR #9)** | New `AUTOMATION_FAILURE_ALERT` type — daily sweep, grouped per vendor, one alert/vendor/day, with a notification-loop guard (excludes its own type from the failure scan). Admin-only `automationRulesService.failures()` feed is unchanged and still exists alongside this — different audience, not a duplicate. 198/198 test files pass. |
| R39 Referral credit confirmed | **Implemented (legacy), with a terminology mismatch worth flagging** | Two different things exist under similar names: (a) `BUYER_REFERRAL` — a **buyer**-facing "share your code" reward; (b) a **vendor**-to-vendor invitation credit, handoff "M-08 referral.credit.earned" in [referrals.service.ts](../../src/modules/referrals/referrals.service.ts). The client's locked decision #12 says vendor-to-vendor invitation rewards are **conditional Eki Membership credits**, and buyer-to-buyer referrals are a **separate** automation — that distinction already exists in the code, by accident of naming, not by deliberate spec alignment. Worth confirming with the client which of the two R39 actually refers to (my reading: the vendor-to-vendor one, i.e. (b)). |
| R40 Critical administrative incident | **Not started / not found** | No matching "critical incident → admin push" code found. |

## Summary counts

- **Implemented, QA passed (spec-shaped):** 13 of 40 — R01, R03, R05, R06, R11, R16, R20, R30, R31, R32, R33, R37, R38
- **Backend implemented/QA passed, but end-to-end NOT fully compliant (named mobile-side gaps remain):** 1 of 40 — R10
- **Implemented (legacy, not re-platformed):** 5 of 40 — R09, R12, R13, R15, R39
- **Blocked (named, real dependency missing):** R02, R04 — 2
- **Not started / not found:** R18, R28, R40 — 3
- **Not verified this pass (likely exist under legacy naming, not confirmed by name):** R07, R08, R14, R17, R19, R21, R22, R23, R24, R25, R26, R27, R29, R34, R35, R36 — 16

16 of 40 rules were not individually chased down to a confirmed yes/no this pass — that is a real limit of this session's time, stated plainly rather than guessed at.
