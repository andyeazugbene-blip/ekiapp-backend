# Compliance Matrix — R01–R40 (Notification Orchestration Spec v2)

Status values follow the spec's own progression: **Proposed → Backend mapped → Route mapped → Implemented → QA passed → Approved → Enabled**, plus **Blocked** (a real, named dependency is missing) and **Not verified this pass** (exists or not under the old "legacy handbook" naming, but I did not confirm it directly in this session — stated honestly rather than guessed).

"Implemented (legacy)" means: the backend already sends this notification, but through the pre-spec architecture (a specific `communication.service.ts` template key or a one-off sweep function, often named after the old 210-event handbook's handoff codes like "O-04" or "M-08") — not through a spec-shaped `NotificationRule`/`NotificationCandidate`. It works today; it is not yet re-platformed onto the spec's contracts.

## R01–R11: Vendor onboarding, activation, first-sale

| Rule | Status | Evidence |
|---|---|---|
| R01 Registration complete, store absent | **Implemented, QA passed** | `REGISTRATION_REMINDER` — [automation.detectors.ts](../../src/modules/automation/automation.detectors.ts), PR #6. Cadence corrected to spec's 4h/24h/72h. Tests: `automation-detectors.test.ts`. |
| R02 Store draft abandoned | **Blocked** | No partial/draft `Vendor` state exists — `createVendor()` writes a complete row atomically. Implementing this needs a new draft-state column/model; not added this pass (new schema, not "fix"). |
| R03 Store ready, zero foodstuff | **Implemented, QA passed** | `FIRST_PRODUCT_REMINDER`, PR #6. |
| R04 Foodstuff draft incomplete | **Detector implemented; activation fail-closed pending source approval** | `DRAFT_PRODUCT_REMINDER` queries `Product.status = DRAFT` and applies the existing completeness contract (at least one image and a positive price); complete-but-unpublished drafts are excluded. It uses the 4h/24h/72h capped P2 cadence from `updatedAt`, owner `vendor.userId`, and stops when the product becomes complete or leaves DRAFT. The additive enum migration and detector tests are in merged PR #16. New rules default to DRAFT; both Automation Centre activation paths reject ACTIVE unless `R04_ENABLEMENT_APPROVED=true`. The authoritative v2 source is still missing, so exact copy and policy remain unverified and the flag is not enabled. Regression tests cover blocked/approved activation. |
| R05 Delivery setup missing | **Implemented, QA passed** | `DELIVERY_SETUP_REMINDER`, PR #6. |
| R06 Verification not started when eligible | **Implemented; stop condition corrected and focused test added** | `VERIFICATION_REMINDER` now stops once a Stripe Identity session ID exists, using the real `Vendor.stripeVerificationSessionId` written by `createStripeVerificationSession()`. It still excludes verified vendors and requires product + delivery setup. Tests cover both reminder eligibility and the submitted/session stop condition. |
| R07 Verification requires correction | **Implemented (legacy); QA passed** | Stripe Identity `requires_input` webhook persists `stripeIdentityStatus` and sends `vendor_verification_rejected` to the vendor with the provider's reason. Evidence/tests: [stripe-identity.service.ts](../../src/modules/verification/stripe-identity.service.ts), [stripe-identity.test.ts](../../src/tests/stripe-identity.test.ts). The mobile handler routes that type to the rejected verification screen. |
| R08 Verification approved | **Implemented (legacy); QA passed** | Stripe Identity `verified` webhook persists the verified state and sends `vendor_verification_approved`; it also triggers eligible product activation. Evidence/tests: [stripe-identity.service.ts](../../src/modules/verification/stripe-identity.service.ts), [stripe-identity.test.ts](../../src/tests/stripe-identity.test.ts). The mobile handler routes the approval notification. |
| R09 Publication confirmed → share store | **Implemented (legacy), not spec-shaped** | `vendor_store_ready` one-time milestone — [vendor-milestone-notifications.service.ts](../../src/modules/vendors/vendor-milestone-notifications.service.ts) `maybeSendStoreReady`. Fires once, outside `automationService`/`AutomationRule` — not admin-visible in the Automation Centre the way R01–R06/R11 are. |
| R10 Store live, never shared | **Implemented; backend tests pass, mobile runtime QA pending** | Backend: `STORE_SHARE_REMINDER` uses the shared P2 4h/24h/72h framework and the later of the first active product's real `publishedAt` and first delivery zone `createdAt` as `readySince`. Active legacy products without `publishedAt` are not assigned a guessed date and are skipped. `store_shared` is distinct from `store_viewed`; the public endpoint requires the authenticated store owner for `share` events. Mobile calls it only when the native share API reports `sharedAction` and opens `/(vendor)/share-store-link` when `automation_store_share_reminder` is tapped. `store_viewed` remains a bounded grandfather fallback for events before 2026-10-26. Device-level share-result behavior still needs iOS/Android QA. The daily Vercel cron cannot guarantee 4h/24h/72h send timing; see `04-scheduler-report.md`. |
| R11 First Sale Campaign not started | **Implemented, QA passed** | `FIRST_SALE` (narrowed), PR #6. Stop condition substituted (first paid order, not "campaign started" — no such campaign concept exists). |

## R12–R18: Vendor orders and inventory

| Rule | Status | Evidence |
|---|---|---|
| R12 First paid order created | **Implemented (legacy)** | "vendor-new-order notification" — [payments.service.ts:900](../../src/modules/payments/payments.service.ts). Not re-verified for exact P0/immediate timing this pass. |
| R13 Order acceptance outstanding | **Implemented (legacy)** | `order-unacknowledged-sweep` (handoff O-02) — [internal.routes.ts:450](../../src/modules/internal/internal.routes.ts), confirmed live (`"firstReminders":2,"escalations":2"` in the manual sweep run on 2026-10-25). |
| R14 Order preparation overdue | **Blocked pending real preparation deadline** | The order model has no preparation due timestamp or preparation-specific deadline. R13 is acceptance, while R15 derives an assumed dispatch window from `vendorConfirmedAt`; neither is proof of preparation being overdue. No deadline or cadence was invented. |
| R15 Dispatch not confirmed | **Implemented (legacy)** | `order-dispatch-due-sweep` (handoff O-04) — [order-acceptance-notifications.service.ts](../../src/modules/orders/order-acceptance-notifications.service.ts). Comment in that file notes **no real `dispatchDueAt` column exists** — the "due" timing is an assumed window, not a verified deadline. Spec explicitly requires "deadline messages derive from real entity timestamps" — this is a known gap in the existing (pre-spec) implementation, not introduced by this pass. |
| R16 Stock crosses low threshold | **Implemented, QA passed** | `LOW_STOCK_ALERT` — content-hash deduped, tested (`automation-detectors.test.ts`). |
| R17 Stock reaches zero | **Partially covered by R16; distinct rule unverified** | `detectLowStockAlert()` queries active products with `stock <= 5`, so zero stock is included in the same vendor-level set and gets a generic “running low” alert. It does not distinguish a zero-stock transition, use R17-specific copy, or prove the client’s R17 episode policy. Keep distinct R17 disabled pending the v2 mapping. |
| R18 Stock conflicts with open orders | **Blocked pending a verifiable conflict signal and exact rule policy** | Checkout paths decrement `Product.stock` atomically when creating a pending order, so pending quantities are already removed from available stock; failed pending orders restore stock exactly once through the guarded recovery path. There is no separate reservation ledger or `reservedStock` field. Comparing open-order quantities with current stock would double-count reservations and create false alerts. Manual stock edits do not preserve an authoritative pre-edit quantity to compare. |

## R19–R24: Buyer payment and order lifecycle

| Rule | Status | Evidence |
|---|---|---|
| R19 Payment authentication required (3DS) | **Native checkout path implemented; QA pending** | Stripe maps `requires_action` to `REQUIRES_ACTION`; the mobile checkout presents Stripe PaymentSheet with the client secret and Stripe return URL, so authentication is handled in the live checkout rather than by a later push. No separate 3DS push path was found. Native iOS/Android challenge and return testing is still required. |
| R20 Payment failed (ordinary checkout) | **Implemented (legacy)** | `CHECKOUT_PAYMENT_FOLLOW_UP` type exists and is tested — distinct from `PAYMENT_RECOVERY` (Foodstuff Subscription-only), matching the spec's own distinction. |
| R21 Order confirmed | **Implemented (legacy); trigger semantics need v2 confirmation** | Stripe success emits buyer `order_paid` after payment is confirmed and sends the buyer-facing confirmation communication. The separate `buyer_order_confirmed` communication is log-only, not a push. Mobile routes `order_paid` to the order destination. |
| R22 Order dispatched | **Implemented (legacy); QA pending** | `ordersService` sends buyer `order_status` and `buyer_order_shipped` when an order transitions to `DISPATCHED`; the mobile tap handler routes both to the buyer order. No mobile device tap QA in this pass. |
| R23 Collection ready | **Implemented for Community Buy only; general order scope unverified** | Community Buy fulfilment sends “ready for collection” notifications to organiser and participants when fulfilment becomes ready. The ordinary order model has no equivalent collection-ready transition in this path. Do not count this as general-order coverage without the source mapping. |
| R24 Delivery exception | **Blocked pending a real exception signal and policy** | Shipment/order statuses expose normal progression, but no verified carrier exception state, exception producer, or exception notification was found. Do not infer an exception from a delayed delivery. |

## R25–R30: Payouts, disputes, support, Eki Membership

| Rule | Status | Evidence |
|---|---|---|
| R25 Payout action required | **Partially implemented; action-required trigger unverified** | Payout request creation notifies the vendor (`PAYOUT_REQUESTED`). No verified action-required alert to an admin/vendor was found for a payout paused or requiring additional information. |
| R26 Payout confirmed | **Implemented (legacy); QA pending** | Payout approval and successful payment paths send `PAYOUT_APPROVED` and `PAYOUT_PAID` notifications to the vendor. These are separate from a requested payout. |
| R27 Dispute evidence due | **Partially implemented; due-time reminder missing** | `adminRequestEvidence()` records a real `respondByAt` and immediately notifies the selected buyer/vendor with the deadline. No scheduled notification at/near the deadline or overdue reminder was found. Any reminder cadence remains gated on source policy. |
| R28 Support response received | **Implemented (legacy) for Community Buy cases; general support scope unverified** | `supportCaseService.adminUpdate()` sends `support_case_response` only when `customerVisibleResponse` changes, and targets the case's `participantId` (the reporter), with `caseId` and `campaignId`. No-op re-saves and admin-only field changes do not notify. Evidence/tests: [support-case.service.ts](../../src/modules/community-buy/support-case.service.ts) and [community-buy-support-case.test.ts](../../src/tests/community-buy-support-case.test.ts). The repository has no general support-case model in this path; the original spec is needed to confirm whether this narrow workflow fully covers R28. |
| R29 Membership payment failed | **Implemented (legacy); grace/retry behavior needs v2 confirmation** | Stripe `invoice.payment_failed` for vendor Membership subscriptions updates the subscription to past due and sends a vendor notification; focused webhook tests exist. Exact client retry/grace copy and timing need source verification. |
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
| R34 Closing below minimum | **Partially implemented; trigger/cadence mapping unverified** | The Community Buy authorisation path tells the organiser when the campaign is below its minimum and gives the actual authorised quantity, minimum, and decision deadline. It is tied to the below-minimum rescue decision, not verified as a general closing-soon reminder. |
| R35 Minimum reached | **Partially implemented; semantics differ by campaign mode** | Pledge-mode contributions call `notifyProgressMilestone()`; its milestone target is `goalShares` when present, falling back to `minimumShares`, and it dedupes by milestone/recipient. The authorisation-mode path emits a target-reached event when its minimum is met. A unified R35 notification across modes and the exact mapping to “minimum reached” are not verified. |
| R36 Payment action required | **Implemented for Community Buy; ordinary checkout scope unverified** | When a Community Buy hold returns Stripe `requires_action`, the participant receives “Confirm your card” with a campaign destination. Ordinary checkout handles 3DS in the active PaymentSheet flow (R19); no separate recovery notification was found. |
| R37 Supplier reconfirmation requested | **Implemented (legacy)** | `supplier_reconfirmation_requested` notification confirmed in [campaign-authorisation.service.ts](../../src/modules/community-buy/campaign-authorisation.service.ts). |

## R38–R40: Automation failures, referrals, critical admin incidents

| Rule | Status | Evidence |
|---|---|---|
| R38 Automation service failure | **Implemented, QA passed (PR #9)** | New `AUTOMATION_FAILURE_ALERT` type — daily sweep, grouped per vendor, one alert/vendor/day, with a notification-loop guard (excludes its own type from the failure scan). Admin-only `automationRulesService.failures()` feed is unchanged and still exists alongside this — different audience, not a duplicate. 198/198 test files pass. |
| R39 Referral credit confirmed | **Partially implemented (legacy); vendor-to-vendor mapping verified** | The earlier handoff's locked decision #12 defines vendor-to-vendor rewards as conditional Eki Membership credits and buyer referrals as separate. `creditVendorReferralOnMembershipQualified()` reads the real `Referral` ledger, checks verification + active product + active zone + first Membership payment, claims `creditedAt` idempotently, reads configurable credit months, audits, and notifies. It deliberately does not apply a Stripe coupon/invoice credit, so the financial benefit is recorded but not automatically applied. Evidence/tests: [referrals.service.ts](../../src/modules/referrals/referrals.service.ts), [vendor-referral-credit.test.ts](../../src/tests/vendor-referral-credit.test.ts). |
| R40 Critical administrative incident | **Partially implemented; notifications fail closed and remain disabled** | Backend PR #15 records verified payment/ledger anomalies. Outbound alerts require `R40_PAYMENT_ANOMALY_ALERTS_ENABLED=true`; absent/other values suppress delivery while preserving anomaly records. Mobile PR #5 adds the authenticated admin payment-anomaly queue route and existing `reports.read` API boundary. The shared outbox consumer foundation is being added, but there is not yet an approved R40 event handler/candidate delivery path. This covers payment/ledger anomalies only; full v2 incident signals, approved severity/copy, native-device QA, and production runtime verification remain dependencies. Do not enable the flag until those are completed. |

## Summary counts

- **Implemented, QA passed (spec-shaped):** 12 of 40 — R01, R03, R05, R06, R11, R16, R30, R31, R32, R33, R37, R38
- **Implemented on backend and mobile source; backend tests/typechecks pass, mobile runtime QA and production timing remain outstanding:** 1 of 40 — R10
- **Implemented (legacy, not re-platformed):** R07–R09, R12–R13, R15, R20–R22, R26, R29, R37
- **Partial or scoped:** R04, R17, R23, R25, R27–R28, R34–R36, R39–R40
- **Blocked on source semantics or a real signal:** R02, R14, R18, R24
- **Native flow with device QA pending:** R19

The previously unverified rules above were inspected in code during this pass. These are implementation mappings, not a claim of v2 approval or enablement. Exact acceptance still depends on the missing authoritative v2 specification and original 210-event catalogue; rules with unverified policy, copy, timing, or signals remain gated.
