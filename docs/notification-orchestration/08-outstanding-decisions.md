# Outstanding Decisions — Genuinely the Client's to Make

Business/infrastructure choices and one missing source artifact remain. The R06 question is answered by the existing Stripe Identity flow. R39's vendor referral credit is recorded as earned/owed; it is not an applied Membership credit, so billing-provider application remains unimplemented.

## 1. WhatsApp provider

The shared policy can consume provider-neutral positive delivery evidence from `CommunicationLog`; it requires exact task episode, WhatsApp channel, `DELIVERED`, and a real `deliveredAt` inside the configured cooldown. `NOTIFICATION_WHATSAPP_TASK_COOLDOWN_SECONDS` defaults to zero, so absent an approved cooldown, push suppression is disabled. The client must select/configure a WhatsApp provider and receipt adapter, and approve the cooldown and service-message exemptions. No provider integration or WhatsApp delivery is claimed.

## 2. Sub-daily scheduler execution and credential verification

The ten-minute GitHub Actions workflow is not verified operational: run `40468800224` logged five 401 responses with an empty bearer header, and the last two recorded scheduled runs were about 5h 37m apart. The repository lists a `CRON_SECRET` name, but the owner must verify its value matches the Vercel environment secret and that the workflow is enabled; do not disclose the value. Code now fails visibly when the secret is unavailable or calls fail. The Vercel cron remains daily. If GitHub's best-effort schedule cannot meet the needed cadence, select a scheduler/platform with an acceptable timing SLA; a Vercel plan change is a billing decision. No secret or plan changes were made. Keep R30 and other cadence-dependent gates off until successful sub-daily runs and end-to-end timing are evidenced.

## 3. Original 210-event legacy catalogue

The authoritative v2 Google Doc export is copied to `docs/notification-orchestration/Eki-Notification-Orchestration-Spec-v2.md`. Searching the available project trees found references to the 210-event source, but not the original handbook/catalogue itself. Do not infer its IDs, event mappings, copy, routes, or stop conditions. The source-backed row template, validation rules, and exact handoff requirements are in `210-event-reconciliation.md`; the client must supply the original editable handbook or lossless export with stable IDs and source page/row references.

## 4. Applying vendor referral Membership credits

The referral ledger records a configured credit-month reward as earned/owed and notifies the referrer, but does not mutate Stripe subscription dates or invoices. To finish R39, the client must approve: (1) the exact reward value and unit (free Membership months, fixed currency credit, or an existing Stripe coupon ID), (2) eligible Membership product/price and currency scope, (3) when to apply it (first invoice, next renewal, or another named invoice), (4) expiry and stacking rules, and (5) what happens on referral disqualification, subscription cancellation, refund, or chargeback. Also identify the existing Stripe mechanism/owner if one is already approved. Do not infer billing changes from `Referral.creditedAt` alone.

## 5. Mobile runtime QA and gated-rule verification

The mobile source maps all 15 semantic destination keys to routes or role-safe fallbacks, and PR #5 source maps R40 `admin_case` to an authenticated admin queue. The mobile PR #5 state could not be refreshed during this pass because GitHub API access was unavailable; it was reported open and mergeable at the last check. Typechecking and preview CI do not verify native notification delivery, cold-start/background behavior, or route ownership on iOS/Android devices. Staging setup and the precise R40 device matrix are in `09-mobile-runtime-qa.md`. R04 remains DRAFT pending Acquisition WhatsApp ownership/coordination and sub-daily timing support.

## 6. Remaining engineering work and gated rules

The rules formerly listed as not verified have now been inspected in code and their evidence or gaps recorded in `01-compliance-matrix.md`. R02 needs a confirmed store-draft lifecycle/source and abandonment semantics; R14 needs the actual preparation deadline source written by the order workflow; R23 needs the ordinary-order collection-ready transition and accountable producer; R39 needs the approved credit mechanism and reward terms above. The outbox/candidate/delivery path is implemented for verified rules; other business events still need reviewed mappings. R24 is scoped to explicit vendor-reported `DELAYED`, not a carrier-verified exception. Scheduler execution, native route/device QA, provider integration, and business approval remain external gates. None should be enabled from inferred state.

The v2 specification now supplies the proposed rule semantics and copy, but explicitly requires production event mapping and QA. The original 210-event legacy catalogue/handbook remains the single missing source artifact.
