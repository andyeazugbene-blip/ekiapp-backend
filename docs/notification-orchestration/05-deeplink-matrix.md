# Deep-Link Matrix — All 15 Destination Keys

The mobile root notification handler supports the 15 v2 semantic destination keys in `data.destination`. A tap can arrive while the app is foregrounded or as a cold-start response; the handler deduplicates taps, holds them until authentication restores, marks persisted notifications read only for the signed-in user, and then applies role-gated routing. The messages and case screens reload data under the authenticated account, so a route parameter alone does not grant access. This is source evidence, not native device QA.

| Destination key | Real screen | Route | Params | Tap-wired today? |
|---|---|---|---|---|
| `store_setup` | Store setup screen | `/(vendor-onboarding)/setup-store` | Signed-in vendor | Yes; role-gated; fallback to vendor home |
| `foodstuff_editor` | Foodstuff edit/add | `/(vendor)/foodstuff-edit` or `foodstuff-add` | `productId`/`id` when editing | Yes; role-gated; missing id opens add form |
| `verification` | Verification intro | `/(vendor-verification)/index` | none | Yes; role-gated |
| `inventory_detail` | Product stock detail/list | `/(vendor)/foodstuff-detail` or `foodstuff?filter=low_stock` | `productId`/`id` optional | Yes; role-gated; missing id falls back to low-stock list |
| `order_detail` | Buyer/vendor/admin order screen or list | role-specific order route | `orderId`/`id` optional | Yes; role-specific fallback list |
| `store_share` | Store sharing screen | `/(vendor)/share-store-link` | none | Yes; role-gated |
| `first_sale` | Vendor sales-growth screen | `/(vendor)/grow-sales` | none | Yes; role-gated |
| `automation_detail` | Automation detail/center | `/(vendor)/automation-detail` or center | `automationType`/`type` optional | Yes; role-gated; missing type opens center |
| `checkout` | Buyer checkout | `/(buyer)/checkout` | cart state | Yes; role-gated |
| `foodstuff_subscription` | Subscription detail/list | `/(buyer)/regular-delivery-detail` or list | `subscriptionId`/`foodstuffSubscriptionId`/`id` optional | Yes; role-gated; missing id opens list |
| `community_buy_campaign` | Buyer/organiser/supplier campaign screen or list | role/audience-specific Community Buy route | `campaignId`/`id` optional | Yes; role/audience-gated; explicit fallback list |
| `membership` | Vendor plan screen | `/(vendor)/subscription-plans` | none | Yes; role-gated |
| `referral_rewards` | Buyer referral program | `/(buyer)/referral-program` | none | Yes; role-gated; reward-history-specific copy remains limited |
| `support_case` | Authenticated support thread or Community Buy case list | buyer/vendor messages list when `conversationId`; buyer Community Buy support list otherwise | `conversationId` or `campaignId`/`caseId` | Yes; role-gated; thread is reloaded from the signed-in user account |
| `admin_case` | Admin payment anomaly queue | `/(admin)/payment-anomalies` | `anomalyKey` optional | Yes for `critical_payment_anomaly`; admin-only with queue fallback |

## Source verification summary

All 15 destination keys have an explicit tap route or role-safe fallback in mobile `app/_layout.tsx`. Authentication restoration, cold-start response retrieval, duplicate-tap suppression, recipient notification read acknowledgement, and role-specific routing are implemented in source. Support thread IDs are reopened only through the signed-in user's conversations list; Community Buy case IDs are expanded only from the authenticated user's own-case response.

The mobile repository typecheck and PR preview checks pass. No iOS/Android device run has verified provider delivery, killed-app navigation, or cold-start behavior. The selected fallback for `referral_rewards` opens the existing referral program, which does not yet show vendor membership-credit history; R39 remains gated for that reason.