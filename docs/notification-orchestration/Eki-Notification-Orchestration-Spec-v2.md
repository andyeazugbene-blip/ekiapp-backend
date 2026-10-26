EKI — NOTIFICATION ORCHESTRATION  
Developer Specification v2.0  
25 October 2026 \| Implementation draft — production mapping required

1\. Executive build instruction  
Build one event-driven, state-aware notification service shared by all Eki modules. Every candidate must be checked at trigger time AND send time. No fabricated deep links, backend event names, deadlines, financial claims, or copy variants. This Google Doc is the architecture and release instruction; the 210-event legacy handbook is a source catalogue, not an executable registry. First release targets 40 events, subject to event mapping and live QA.

2\. Locked product decisions  
• Customer-facing name: Foodstuff Subscription. Do not use Regular Delivery in new copy.  
• Call marketplace purchasers buyers, and inventory foodstuff.  
• Activation journey: registration → store setup → first foodstuff → delivery → automatic verification → publication → share store → first paid order. Three listings are NOT a condition of activation.  
• Vendor-to-vendor invitation rewards are conditional Eki Membership credits, not immediate cash. Buyer-to-buyer store referrals are a separate vendor automation.  
• Community Buy minimum/goal/maximum are separate. Confirm deployed payment capture model before enabling payment-state copy.  
• Acquisition WhatsApp automation owns its assigned onboarding nudges. App notifications must coordinate and suppress duplicates.

3\. Ownership and channels  
ACQUISITION\_WHATSAPP: interested/unregistered prospects, registration assistance and assigned onboarding reminders. APP\_ORCHESTRATOR: order, stock, payment, delivery, security, product publication and in-app operations. VENDOR\_AUTOMATION: consent-based cart recovery, win-back, reorders, reviews, buyer referrals. EKI\_OPERATIONS: Foodstuff Subscription payment, renewal and price-approval service events. COMMUNITY\_BUY: participant, organiser and supplier campaign transitions. REFERRAL\_LEDGER: vendor invitation reward state.  
A shared task\_episode\_key \= user\_id \+ role \+ entity\_type \+ entity\_id \+ task\_key prevents competing WhatsApp and push reminders. If WhatsApp already delivered the same task reminder within the configured cooldown, suppress push unless a documented fallback policy applies. Critical transactional messages remain independently eligible.

4\. Processing pipeline  
Domain database transaction \+ transactional outbox → reliable event publisher → versioned event validator → notification candidate → recipient/role resolution → eligibility and consent policy → task episode deduplication → scheduling/quiet hours → send-time state recheck → verified template renderer → in-app inbox and eligible channel → provider receipt → click/task-completion attribution → audit history.  
Use an at-least-once delivery model with idempotent consumers. Retry temporary failures with exponential backoff; invalid device tokens are revoked. One event may create multiple role-specific candidates but never duplicate financial side effects. The inbox remains useful when push is disabled.

5\. Data contracts — required fields and allowed states  
DomainEvent {event\_id: UUID, event\_key: string, version: integer\>=1, occurred\_at: UTC ISO8601, aggregate\_type: enum, aggregate\_id: UUID, actor\_user\_id: UUID\|null, payload: object, tenant\_id: string}. Example: {"event\_id":"uuid","event\_key":"inventory.low\_stock","version":1,"occurred\_at":"2026-10-25T12:00:00Z","aggregate\_type":"foodstuff","aggregate\_id":"foodstuff\_uuid","actor\_user\_id":null,"payload":{"vendor\_id":"vendor\_uuid","available\_quantity":3,"threshold":5},"tenant\_id":"eki"}.  
NotificationRule {rule\_id: string, version: integer, enabled: boolean, recipient\_role: enum, priority: P0\|P1\|P2\|P3, trigger\_event: string, delay\_seconds: integer\>=0, eligibility\_key: string, stop\_condition\_key: string, channel\_policy: string, template\_id: string, destination\_key: string}.  
NotificationCandidate {candidate\_id: UUID, rule\_id: string, event\_id: UUID, recipient\_user\_id: UUID, role: enum, entity\_id: UUID, task\_episode\_key: string, due\_at: UTC ISO8601, expires\_at: UTC ISO8601, state: scheduled\|suppressed\|queued\|sent\|failed\|cancelled\|expired}.  
NotificationDelivery {delivery\_id: UUID, candidate\_id: UUID, channel: push\|in\_app\|email\|sms\|whatsapp, template\_version: string, variant\_id: string, provider\_message\_id: string\|null, status: queued\|sent\|delivered\|opened\|failed\|suppressed, attempt\_count: integer\>=0, last\_error: string\|null}.  
Preference {user\_id: UUID, role: enum, channel: enum, category: service\|marketing, consent: opted\_in\|opted\_out\|not\_required\_for\_service\|unknown, timezone: IANA string, quiet\_hours\_start: HH:MM, quiet\_hours\_end: HH:MM}.  
Outcome {candidate\_id: UUID, clicked\_at: UTC ISO8601\|null, completed\_at: UTC ISO8601\|null, completion\_event\_id: UUID\|null, attribution\_model: direct\_task\_completion\|assisted\|none}.  
Required fields must not be silently omitted. Any changed enum or field meaning requires a versioned migration.

6\. Timing and frequency  
P0 critical: immediate on confirmed event or actual deadline; P1 operational: immediate or safely batched; P2 task recovery: proposed 4h, 24h, 72h after inactivity, maximum three sends per unresolved episode; P3 optional growth: maximum one per day and three per rolling seven days, subject to consent. All timing is configurable. Deadline messages derive from real entity timestamps. Stop on completion, cancellation, restriction, opt-out, incompatible state, expired offer or duplicate cross-channel episode. Stock thresholds alert once per crossing, not daily while stock stays low.

7\. Screen and deep-link mapping (unverified — developer must complete)  
Destination key \| Intended screen \| Actual iOS/Android route \| Params \| Auth/fallback  
store\_setup \| Vendor setup \| TO MAP \| vendor\_id \| TO MAP  
foodstuff\_editor \| Foodstuff editor \| TO MAP \| foodstuff\_id \| TO MAP  
verification \| Secure verification \| TO MAP \| verification\_session \| TO MAP  
inventory\_detail \| Stock item \| TO MAP \| foodstuff\_id \| TO MAP  
order\_detail \| Order detail \| TO MAP \| order\_id \| TO MAP  
store\_share \| Store sharing \| TO MAP \| store\_id \| TO MAP  
first\_sale \| First Sale Campaign \| TO MAP \| vendor\_id \| TO MAP  
automation\_detail \| Automation detail \| TO MAP \| automation\_id \| TO MAP  
checkout \| Buyer checkout \| TO MAP \| cart\_id \| TO MAP  
foodstuff\_subscription \| Subscription detail \| TO MAP \| subscription\_id \| TO MAP  
community\_buy\_campaign \| Community Buy detail \| TO MAP \| campaign\_id \| TO MAP  
membership \| Eki Membership \| TO MAP \| membership\_id \| TO MAP  
referral\_rewards \| Referral ledger \| TO MAP \| vendor\_id \| TO MAP  
support\_case \| Support thread \| TO MAP \| case\_id \| TO MAP  
admin\_case \| Role-restricted case \| TO MAP \| case\_id \| TO MAP  
All old synthetic codes (aut1/, adm12/, etc.) are retired. Destination keys are semantic labels, not executable routes.

8\. Worked implementation example — low stock  
1\. Stock changes from 7 to 3; configured threshold is 5\. Database commits quantity and outbox event atomically.  
2\. Consumer deduplicates event\_id; inventory.low\_stock candidate is created for correct vendor and foodstuff.  
3\. At send time reread stock: send only if available\_quantity \<= threshold, listing active and threshold episode unsent.  
4\. Copy: TITLE “Your {foodstuff} is running low”; BODY “Only {quantity} left. Update your stock when you restock.” CTA “Update stock”.  
5\. Resolve inventory\_detail via verified route; authenticated vendor can access only own stock item.  
6\. Log event, candidate, template version, provider result, click and stock-update completion.  
7\. Stop when stock recovers above threshold; later crossing opens a new episode. QA: duplicate event one push; replenished before send zero push; wrong vendor zero push; valid tap opens correct item.

9\. Release 1 — candidate 40-event implementation inventory  
Each ID is a proposed business rule, NOT a claim about an existing backend event. Before enabling, developer must supply actual producer, event/state query, route, eligibility, delay, stop, and iOS/Android test evidence.  
R01 \| Vendor \| P2  
Trigger: Registration complete, store absent  
Timing: 4h inactivity  
TITLE: Start setting up your Eki store  
BODY: Add your business details to begin.  
CTA: Set up store \| Destination key: store\_setup  
STOP: store setup completed \| Owner: Acquisition WhatsApp primary  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R02 \| Vendor \| P2  
Trigger: Store draft abandoned  
Timing: 4h inactivity  
TITLE: Your store setup is saved  
BODY: Continue from where you stopped.  
CTA: Continue setup \| Destination key: store\_setup  
STOP: store completed \| Owner: Acquisition WhatsApp primary  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R03 \| Vendor \| P2  
Trigger: Store ready, zero foodstuff  
Timing: 4h inactivity  
TITLE: Add your first foodstuff  
BODY: Start with the foodstuff your buyers ask for most.  
CTA: Add foodstuff \| Destination key: foodstuff\_editor  
STOP: first foodstuff saved \| Owner: Acquisition WhatsApp primary  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R04 \| Vendor \| P2  
Trigger: Foodstuff draft incomplete  
Timing: 4h inactivity  
TITLE: Your foodstuff listing is nearly ready  
BODY: Finish the remaining details.  
CTA: Finish listing \| Destination key: foodstuff\_editor  
STOP: draft completed \| Owner: Acquisition WhatsApp primary  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R05 \| Vendor \| P2  
Trigger: Delivery setup missing  
Timing: 4h inactivity  
TITLE: Set up how buyers receive your foodstuff  
BODY: Add delivery or collection options.  
CTA: Set delivery \| Destination key: store\_setup  
STOP: delivery configured \| Owner: Acquisition WhatsApp primary  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R06 \| Vendor \| P2  
Trigger: Verification not started when eligible  
Timing: 4h inactivity  
TITLE: Your store is close to opening  
BODY: Complete secure verification to continue.  
CTA: Verify \| Destination key: verification  
STOP: verification submitted \| Owner: Acquisition WhatsApp primary  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R07 \| Vendor \| P1  
Trigger: Verification requires correction  
Timing: on provider status  
TITLE: Your verification needs attention  
BODY: Review the secure step that needs correcting.  
CTA: Continue verification \| Destination key: verification  
STOP: provider requirement resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R08 \| Vendor \| P1  
Trigger: Verification approved  
Timing: on confirmed status  
TITLE: Your verification is complete  
BODY: We are checking which foodstuff can now be published.  
CTA: View status \| Destination key: verification  
STOP: publication evaluated \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R09 \| Vendor \| P1  
Trigger: Publication confirmed  
Timing: on confirmed publication  
TITLE: Your foodstuff is now visible  
BODY: Share your store with buyers.  
CTA: Share store \| Destination key: store\_share  
STOP: sent once per activation \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R10 \| Vendor \| P2  
Trigger: Store live, never shared  
Timing: 24h after publication  
TITLE: Your store link is ready  
BODY: Share it with people who already buy from you.  
CTA: Share store \| Destination key: store\_share  
STOP: store shared or opt-out \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R11 \| Vendor \| P2  
Trigger: First Sale Campaign not started  
Timing: 24h after activation  
TITLE: Work towards your first order  
BODY: Open your First Sale Campaign for the next step.  
CTA: Get first order \| Destination key: first\_sale  
STOP: campaign started \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R12 \| Vendor \| P0  
Trigger: First paid order created  
Timing: immediate  
TITLE: You have a new paid order  
BODY: Review the order and confirm fulfilment.  
CTA: View order \| Destination key: order\_detail  
STOP: order acknowledged \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R13 \| Vendor \| P1  
Trigger: Order acceptance outstanding  
Timing: SLA-based  
TITLE: An order needs your response  
BODY: Review order {order\_id} before {deadline}.  
CTA: Review order \| Destination key: order\_detail  
STOP: accepted/rejected/expired \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R14 \| Vendor \| P1  
Trigger: Order preparation overdue  
Timing: actual deadline  
TITLE: Update this order's preparation status  
BODY: Order {order\_id} needs an update.  
CTA: Update order \| Destination key: order\_detail  
STOP: preparation resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R15 \| Vendor \| P1  
Trigger: Dispatch not confirmed  
Timing: actual deadline  
TITLE: Your order needs a dispatch update  
BODY: Confirm the next fulfilment step.  
CTA: Update dispatch \| Destination key: order\_detail  
STOP: dispatched/cancelled \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R16 \| Vendor \| P1  
Trigger: Stock crosses low threshold  
Timing: immediate  
TITLE: Your {foodstuff} is running low  
BODY: Only {quantity} left. Check your stock.  
CTA: Update stock \| Destination key: inventory\_detail  
STOP: stock above threshold \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R17 \| Vendor \| P1  
Trigger: Stock reaches zero  
Timing: immediate  
TITLE: {foodstuff} is out of stock  
BODY: Restock it when available.  
CTA: Restock \| Destination key: inventory\_detail  
STOP: stock positive \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R18 \| Vendor \| P1  
Trigger: Stock conflicts with open orders  
Timing: immediate  
TITLE: Check stock for an active order  
BODY: Available quantity may not cover outstanding orders.  
CTA: Review stock \| Destination key: inventory\_detail  
STOP: shortfall resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R19 \| Buyer \| P0  
Trigger: Payment authentication required  
Timing: immediate  
TITLE: Your bank needs confirmation  
BODY: Complete the secure payment step.  
CTA: Confirm payment \| Destination key: checkout  
STOP: payment resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R20 \| Buyer \| P0  
Trigger: Payment failed  
Timing: immediate  
TITLE: Your payment did not go through  
BODY: Review your payment method to continue.  
CTA: Review payment \| Destination key: checkout  
STOP: payment resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R21 \| Buyer \| P0  
Trigger: Order confirmed  
Timing: immediate  
TITLE: Your order is confirmed  
BODY: Track your foodstuff order in Eki.  
CTA: Track order \| Destination key: order\_detail  
STOP: sent once \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R22 \| Buyer \| P1  
Trigger: Order dispatched  
Timing: on verified dispatch  
TITLE: Your foodstuff is on its way  
BODY: View the latest delivery information.  
CTA: Track delivery \| Destination key: order\_detail  
STOP: sent once \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R23 \| Buyer \| P1  
Trigger: Collection ready  
Timing: on confirmed ready  
TITLE: Your foodstuff is ready to collect  
BODY: View the collection instructions.  
CTA: View collection \| Destination key: order\_detail  
STOP: collected/cancelled \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R24 \| Buyer \| P1  
Trigger: Delivery exception  
Timing: on verified exception  
TITLE: Your delivery needs attention  
BODY: Review the available next steps.  
CTA: Resolve delivery \| Destination key: order\_detail  
STOP: issue resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R25 \| Vendor \| P0  
Trigger: Payout action required  
Timing: immediate  
TITLE: Your payout needs attention  
BODY: Review the secure payment-provider requirement.  
CTA: Resolve payout \| Destination key: membership  
STOP: payout resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R26 \| Vendor \| P1  
Trigger: Payout confirmed  
Timing: on provider confirmation  
TITLE: Your payout has been completed  
BODY: View the transaction details.  
CTA: View payout \| Destination key: membership  
STOP: sent once \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R27 \| Vendor \| P1  
Trigger: Dispute evidence due  
Timing: real deadline  
TITLE: A dispute needs your response  
BODY: Submit the requested information before {deadline}.  
CTA: View dispute \| Destination key: support\_case  
STOP: response submitted/closed \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R28 \| Buyer \| P1  
Trigger: Support response received  
Timing: on response  
TITLE: Eki Support has replied  
BODY: Open your case to read the update.  
CTA: Open support \| Destination key: support\_case  
STOP: read/closed \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R29 \| Vendor \| P1  
Trigger: Membership payment failed  
Timing: immediate  
TITLE: Your Eki Membership payment needs attention  
BODY: Update your billing details.  
CTA: Update billing \| Destination key: membership  
STOP: payment resolved \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R30 \| Vendor \| P1  
Trigger: Trial ending soon  
Timing: 7 days before real end  
TITLE: Your Eki Membership trial is ending  
BODY: Review your actual billing date and terms.  
CTA: View membership \| Destination key: membership  
STOP: renewed/cancelled \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R31 \| Buyer \| P1  
Trigger: Foodstuff Subscription renewal approaching  
Timing: configured renewal notice  
TITLE: Your next Foodstuff Subscription is coming up  
BODY: Review your next foodstuff delivery.  
CTA: View subscription \| Destination key: foodstuff\_subscription  
STOP: renewal processed/cancelled \| Owner: Eki operations  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R32 \| Buyer \| P0  
Trigger: Foodstuff Subscription payment failed  
Timing: immediate  
TITLE: Your subscription payment needs attention  
BODY: Update your payment method.  
CTA: Review payment \| Destination key: foodstuff\_subscription  
STOP: payment resolved \| Owner: Eki operations  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R33 \| Buyer \| P1  
Trigger: Foodstuff Subscription price approval required  
Timing: real cutoff  
TITLE: Review the price for your next delivery  
BODY: Approve or decline the updated amount before {cutoff}.  
CTA: Review price \| Destination key: foodstuff\_subscription  
STOP: decision recorded \| Owner: Eki operations  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R34 \| Organiser \| P1  
Trigger: Community Buy closing below minimum  
Timing: actual campaign deadline  
TITLE: Your Community Buy needs {remaining} shares  
BODY: Review your available options before {deadline}.  
CTA: View campaign \| Destination key: community\_buy\_campaign  
STOP: minimum met/closed \| Owner: Community Buy  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R35 \| Organiser \| P1  
Trigger: Community Buy minimum reached  
Timing: on confirmed contributions  
TITLE: Your Community Buy reached its minimum  
BODY: Review the campaign's next step.  
CTA: View campaign \| Destination key: community\_buy\_campaign  
STOP: sent once \| Owner: Community Buy  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R36 \| Participant \| P0  
Trigger: Community Buy payment action required  
Timing: immediate  
TITLE: Your Community Buy payment needs attention  
BODY: Complete the required secure payment step.  
CTA: Review payment \| Destination key: community\_buy\_campaign  
STOP: payment resolved \| Owner: Community Buy  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R37 \| Supplier \| P1  
Trigger: Supplier reconfirmation requested  
Timing: actual deadline  
TITLE: Please confirm your Community Buy supply  
BODY: Review quantity and fulfilment terms.  
CTA: Confirm supply \| Destination key: community\_buy\_campaign  
STOP: confirmed/declined \| Owner: Community Buy  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R38 \| Vendor \| P1  
Trigger: Automation service failure  
Timing: on failure  
TITLE: An Eki automation needs attention  
BODY: Review the failed automation and next step.  
CTA: View automation \| Destination key: automation\_detail  
STOP: recovered/paused \| Owner: App  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R39 \| Vendor \| P1  
Trigger: Referral credit confirmed  
Timing: on ledger release  
TITLE: Your referral reward has been applied  
BODY: View your Eki Membership credit.  
CTA: View reward \| Destination key: referral\_rewards  
STOP: sent once \| Owner: Referral ledger  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

R40 \| Admin \| P0  
Trigger: Critical payment or outbox failure  
Timing: on confirmed incident  
TITLE: A critical Eki process needs attention  
BODY: Open the incident and review the failed job.  
CTA: View incident \| Destination key: admin\_case  
STOP: incident resolved \| Owner: Admin  
Mapping status: UNVERIFIED; developer to supply real backend event and mobile route.

10\. Copy variation strategy  
Only create genuine variants for selected high-impact recovery messages; do not manufacture alternatives by concatenating the same title and body. Example first foodstuff: A helpful — “Start with your first foodstuff / Add a photo, price and the details buyers need.” B progress — “Your store is taking shape / One foodstuff listing is the next step towards opening your store.” C benefit — “Show buyers what you sell / Start with the foodstuff people ask you for most.”  
Low stock: A practical — “Your {foodstuff} is running low / Only {quantity} left.” B commercial — “Keep {foodstuff} available / Your stock reached its alert level.” C critical only at configured critical threshold — “Almost sold out: {foodstuff} / Check the remaining quantity.”  
Vendor invitations: A community — “Know another foodstuff seller? / Invite them to Eki.” B reward — “Your network could earn you a membership credit / A qualifying referral may earn a free month.” C direct — “Share your vendor invitation link / Track eligible referrals and reward progress.”

11\. Acceptance criteria  
For each enabled event, show real backend producer, payload, eligibility recheck, idempotency key, channel selection, copy version, route, send result, stop rule and outcome log. Test duplicate webhooks, state change before scheduled send, cross-channel WhatsApp suppression, opt-out, invalid tokens, role changes, deep-link authentication, iOS and Android. Never use simulated payment success as proof of live financial status. Feature state: Proposed → Backend mapped → Route mapped → Implemented → QA passed → Approved → Enabled.

12\. Full catalogue handoff and open dependencies  
The legacy 210-event handbook remains a discovery inventory. Do not import its 630 purported copy versions, synthetic deep links or unverified event keys into production. Convert each legacy record to the same schema as Release 1, preserving ID and business intent; add exact event mapping, source status, delay, eligibility, stop, owner, channel, baseline copy and QA evidence. Mark unimplemented workflows disabled. This Google Doc is a build specification and first-release matrix, not evidence that the full 210 events have been production-mapped.

