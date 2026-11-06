# Phase 1 notification events

The Phase 1 specification requires these events in the registry, with IDs, priorities and stop conditions. All of them go through `notifyUserInAppAndEmail`, so push, email and the inbox share one path. Each uses a dedupe key where a repeat is possible.

| ID (`event`) | To | Message | Opens | Priority | Stop condition |
| :---- | :---- | :---- | :---- | :---- | :---- |
| `supplier_offer_approved` | Supplier | "Your bulk offer for [foodstuff] is live. Organisers can now build Community Buys on it." | Offer | High | Sent once per approval |
| `review_information_required` | Submitter | "We need one more detail before [your offer / your Community Buy] goes live." | Missing item | High | Request resubmitted or withdrawn |
| `review_rejected` | Submitter | "[Item] wasn't approved: [reason]. You can edit and resubmit." | Draft | High | Sent once per decision |
| `offer_campaign_live` | Organiser | "Your Community Buy is live. Share it to reach the minimum." | Share card | High | Once per campaign (dedupe key) |
| `offer_campaign_started` | Supplier | "A Community Buy for [foodstuff] has started on your offer." | Supplier orders | Normal | Once per campaign (dedupe key) |
| `vendor_starts_supplying` | Vendor | "Your business details are already saved. Add your first bulk offer." | S5 | Normal | Once per account (dedupe key) |
| `demand_digest` | Admin | Daily summary of foodstuff requests | Demand list | Low | Once per admin per day. Nothing sent on a day with no requests |
| `campaign_interest_open` | Someone who showed interest | "[Title] is now open on Eki. Join before the deadline." | Campaign | Normal | Once per person per campaign. A guest's email is cleared afterwards |
| `extension_reconfirm` | Offer's supplier | "The organiser of [title] has asked for a later deadline." | Supply bulk orders | High | Supplier answers, or the request is decided |
| `demand_match` | Supplier | "Organisers are asking for [foodstuff]. Add a bulk offer if you can supply it." | Supply bulk orders | Normal | Once per supplier, foodstuff and week |

## Scheduling

`demand-digest` and `demand-matching` run in the daily Vercel sweep. The others are sent when the event happens.
