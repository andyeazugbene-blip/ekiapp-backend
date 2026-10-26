# Outstanding Decisions — Genuinely the Client's to Make

Two business/infrastructure choices and two missing artifacts/access items remain. The R06 and R39 questions from the earlier version are resolved by existing code and the locked referral decision; they are no longer client decisions.

## 1. WhatsApp provider

`task_episode_key` cross-channel suppression (spec section 3/6) cannot be built in any real sense without knowing which WhatsApp provider/API Eki will use (Meta Cloud API direct, a BSP like Twilio/360dialog, etc.) — the suppression logic needs to know what "WhatsApp already delivered this" actually looks like from that provider. **Until this is decided, the field can exist in schema but has nothing to coordinate against.**

## 2. Vercel cron frequency / plan tier

The spec's 4h/24h/72h cadence needs a cron that runs more often than once a day. This is a Vercel account/billing decision (which plan tier, whether to add a second more-frequent cron), not something I should change unilaterally. **Options and consequences:**
- Stay on daily cron: cadence degrades to "fires on the first daily check after the threshold passes" — still correct and bounded, just not real-time.
- Add a sub-daily cron (needs a plan that supports it): true spec-compliant 4h/24h/72h timing.

## 3. Original v2 specification and legacy catalogue

The current workspace does not contain the authoritative Notification Orchestration Developer Specification v2.0 or the original 210-event catalogue. The R01–R40 matrix and the earlier v1 gap analysis are secondary sources; they do not contain the full trigger/copy/recipient/destination evidence needed to safely finish every rule or reconcile each catalogue ID. Provide or point to those exact source files so implementation can continue without guessing client-defined behavior.

## 4. Applying vendor referral Membership credits

The referral ledger records an earned free-month credit and notifies the referrer, but does not mutate Stripe subscription dates or invoices. Confirm the approved Stripe coupon/invoice-credit mechanism before implementing that financial side effect; do not infer billing changes from `Referral.creditedAt` alone.

## 5. Mobile runtime QA and R04 copy approval

Semantic route keys now have role-gated mappings or explicit fallbacks in source, including the R40 payment-anomaly queue. Notification taps are held until authentication restores the recipient's role, and duplicate live/cold-start responses are deduplicated. Typechecking and preview CI do not verify native notification delivery, background behavior, or route ownership on iOS/Android devices. Generic support-case detail is still unavailable because the client app and backend expose only Community Buy support cases; other roles fall back to their support entry point. R04's detector is implemented but its AutomationRule defaults to DRAFT until the exact v2 copy and policy are checked.

## 6. Remaining engineering work and gated rules

The rules formerly listed as “not verified” have now been inspected and their evidence or gaps recorded in `01-compliance-matrix.md`. Open engineering work includes the spec-shaped event/outbox/candidate/delivery pipeline, scheduler timing, distinct zero-stock semantics, dispute due-time reminders, and cross-product scope for Community Buy-only behaviors. R02, R14, R18, and R24 remain blocked on a real lifecycle/signal or client policy; none should be enabled from inferred state. Continue implementation where behavior is verified, and keep the affected rules gated until source semantics, tests, and approval are complete.

The v2 specification and original 210-event catalogue are still the required sources for exact rule semantics, event IDs, recipient/copy mappings, and completion claims. Their required filenames are the client's `Notification Orchestration Developer Specification v2.0` and the original 210-event legacy catalogue/handbook; neither is present in the current workspace search.
