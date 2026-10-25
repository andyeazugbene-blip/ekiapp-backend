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

## 4. Publishing the mobile branch

The mobile changes are committed locally on `feat/store-share-reminder-mobile` (`ff87a48`). Automatic approval review rejected the push because it could not verify trusted authorization to export mobile source to the remote. The earlier request was supplied as an attached text file, which the reviewer did not accept as trusted authorization. A direct in-chat authorization to push this branch is required before retrying.

## 5. Applying vendor referral Membership credits

The referral ledger records an earned free-month credit and notifies the referrer, but does not mutate Stripe subscription dates or invoices. Confirm the approved Stripe coupon/invoice-credit mechanism before implementing that financial side effect; do not infer billing changes from `Referral.creditedAt` alone.

## Remaining rules to verify

14 of the 40 rules (listed in `01-compliance-matrix.md`) remain individually unverified. They are outstanding engineering work, not client decisions; continue investigating them using the supplied source spec once available.
