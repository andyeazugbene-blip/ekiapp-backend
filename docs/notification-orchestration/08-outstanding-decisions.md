# Outstanding Decisions — Genuinely the Client's to Make

Business/infrastructure choices and one missing source artifact remain. The R06 question is answered by the existing Stripe Identity flow. R39's vendor referral credit is recorded as earned/owed; it is not an applied Membership credit, so billing-provider application remains unimplemented.

## 1. WhatsApp provider

`task_episode_key` cross-channel suppression (spec section 3/6) cannot be built in any real sense without knowing which WhatsApp provider/API Eki will use (Meta Cloud API direct, a BSP like Twilio/360dialog, etc.) — the suppression logic needs to know what "WhatsApp already delivered this" actually looks like from that provider. **Until this is decided, the field can exist in schema but has nothing to coordinate against.**

## 2. Vercel cron frequency / plan tier

The spec's 4h/24h/72h cadence needs a cron that runs more often than once a day. This is a Vercel account/billing decision (which plan tier, whether to add a second more-frequent cron), not something I should change unilaterally. **Options and consequences:**
- Stay on daily cron: cadence degrades to "fires on the first daily check after the threshold passes" — still correct and bounded, just not real-time.
- Add a sub-daily cron (needs a plan that supports it): true spec-compliant 4h/24h/72h timing.

## 3. Original 210-event legacy catalogue

The authoritative v2 Google Doc export is now copied to `docs/notification-orchestration/Eki-Notification-Orchestration-Spec-v2.md`. The original 210-event catalogue remains unavailable. Do not infer its IDs, event mappings, copy, routes, or stop conditions; reconcile it only when the original source is provided.

## 4. Applying vendor referral Membership credits

The referral ledger records an earned free-month credit and notifies the referrer, but does not mutate Stripe subscription dates or invoices. Confirm the approved Stripe coupon/invoice-credit mechanism before implementing that financial side effect; do not infer billing changes from `Referral.creditedAt` alone.

## 5. Mobile runtime QA and gated-rule verification

The mobile source maps all 15 specified semantic destination keys to real screens or explicit role-safe fallbacks; R28 general support threads open only through the authenticated buyer/vendor messages list, while Community Buy cases still expand only when returned by the authenticated reporter's own-case API. Typechecking and preview CI do not verify native notification delivery, cold-start/background behavior, or route ownership on iOS/Android devices. R04's exact copy is implemented, but its AutomationRule remains DRAFT pending Acquisition WhatsApp ownership/co-ordination and sub-daily timing support.

## 6. Remaining engineering work and gated rules

The rules formerly listed as not verified have now been inspected in code and their evidence or gaps recorded in `01-compliance-matrix.md`. The outbox/candidate/delivery path is implemented first for R28; other business events/rules still need reviewed mappings. Open engineering work includes remaining rule coverage, scheduler timing, distinct zero-stock semantics, dispute due-time reminders, and cross-product scope for Community Buy-only behaviors. R02, R14, R18, and R24 remain blocked on a real lifecycle/signal or client policy; none should be enabled from inferred state. Continue implementation where behavior is verified, and keep the affected rules gated until source semantics, tests, and approval are complete.

The v2 specification now supplies the proposed rule semantics and copy, but explicitly requires production event mapping and QA. The original 210-event legacy catalogue/handbook remains the single missing source artifact.
