# Outstanding Decisions — Genuinely the Client's to Make

Four real decisions block further progress. Everything else in the compliance matrix that isn't "implemented" is an engineering task, not a decision.

## 1. WhatsApp provider

`task_episode_key` cross-channel suppression (spec section 3/6) cannot be built in any real sense without knowing which WhatsApp provider/API Eki will use (Meta Cloud API direct, a BSP like Twilio/360dialog, etc.) — the suppression logic needs to know what "WhatsApp already delivered this" actually looks like from that provider. **Until this is decided, the field can exist in schema but has nothing to coordinate against.**

## 2. Vercel cron frequency / plan tier

The spec's 4h/24h/72h cadence needs a cron that runs more often than once a day. This is a Vercel account/billing decision (which plan tier, whether to add a second more-frequent cron), not something I should change unilaterally. **Options and consequences:**
- Stay on daily cron: cadence degrades to "fires on the first daily check after the threshold passes" — still correct and bounded, just not real-time.
- Add a sub-daily cron (needs a plan that supports it): true spec-compliant 4h/24h/72h timing.

## 3. R39 — which referral reward is actually meant

The spec's R39 ("referral credit confirmed") could map to either of two different existing things: a buyer-to-buyer share-code reward (`BUYER_REFERRAL`), or a vendor-to-vendor invitation Membership credit (handoff "M-08" in `referrals.service.ts`). The client's own locked decision #12 says these are deliberately separate automations — I read R39 as the vendor-to-vendor one, but this should be confirmed rather than assumed before any further work on it.

## 4. R06/R07/R08 — verification "submitted" state

Fixing the documented substitution in R06 (nudges even after submission, because this codebase has no "submitted, pending" state) needs either a new timestamp column or reading an intermediate Stripe Identity status. Low cost either way, but it's new schema — flagging for a go-ahead rather than adding it unasked.

## Not a decision — a scope confirmation

16 of the 40 rules (listed in `01-compliance-matrix.md`) were not individually verified implemented-or-not this pass, for time reasons, not because they're blocked on anything. If the client wants those chased down to a confirmed status next, that's scheduling, not a decision — happy to continue.
