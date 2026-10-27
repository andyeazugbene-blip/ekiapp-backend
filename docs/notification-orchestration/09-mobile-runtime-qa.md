# Mobile notification runtime QA — R40 and semantic destinations

## Evidence boundary

Mobile PR #5 (`feat/r40-payment-anomaly-mobile-destination`, head `72355b0675e0788fc263f977cbc73ba9bdc27708`, base mobile main `ac1cf5e8e27d71f53fc7abe290219a07fd835a5c`) was reviewed from the clean detached worktree `ekiapp-mobile-pr5-qa`. Its source handles live notification taps and `getLastNotificationResponseAsync()` cold-start responses, queues taps until auth restoration, deduplicates a request/action pair, registers Expo tokens after authenticated state restoration, and only routes `admin_case` when role is `admin` and event is `critical_payment_anomaly` or `critical_incident`. The payment incident screen orders an exact `anomalyKey` match first, calls authenticated `adminService` methods, displays empty/error states, and supports authorized resolution. Backend routes require `reports.read` for listing and `reports.mutate` for scan/review/escalate/resolve. A type-only `*.css` declaration was added to the existing NativeWind declaration file to satisfy TypeScript 6 for the existing global stylesheet import. PR #5 remains open, clean, and mergeable; it has no reviews, Vercel and preview comments pass, and no CI test job is listed. Source review/typecheck is not runtime QA. The PR base was not refreshed because there are no source changes on mobile main since the PR base SHA.

The mobile package has no unit-test runner or routing test harness. No app code change is made solely to add a parallel test stack. The available checks are source typechecking and repository scripts; actual notification delivery, native taps, session restoration, and API permission behavior require the staging device matrix below. Android SDK/`adb`/emulator were unavailable in this environment; no physical-device QA was performed.

## R40 staging setup and safe trigger

Use only a staging/test backend and a dedicated test admin with explicit `reports.read` and `reports.mutate` permissions. Confirm `R40_PAYMENT_ANOMALY_ALERTS_ENABLED` and the required outbox/delivery sweep are enabled only in that staging environment. Generate a real test-mode payment/ledger inconsistency using the approved staging fixture or Stripe test mode, then use the existing anomaly scan. Do not create or alter a production payment anomaly to test a notification. Do not treat a simulated payment as proof of live payment status.

```sh
export API_BASE_URL='https://<staging-host>/api'
export ADMIN_TEST_TOKEN='<short-lived staging admin token>'
curl --fail-with-body -H "Authorization: Bearer $ADMIN_TEST_TOKEN" "$API_BASE_URL/admin/payment-anomalies"
curl --fail-with-body -X POST -H "Authorization: Bearer $ADMIN_TEST_TOKEN" "$API_BASE_URL/admin/payment-anomalies/scan"
curl --fail-with-body -H "Authorization: Bearer $ADMIN_TEST_TOKEN" "$API_BASE_URL/admin/payment-anomalies"
```

Use the incident returned by the authenticated list/scan as the expected `dedupeKey` in the push payload. Confirm the staging outbox consumer materializes one candidate per eligible active admin, that the delivery row and push attempt are durable, and that only a positive provider receipt moves delivery to delivered. Resolve the incident through the authorized endpoint/screen, then verify a queued candidate is suppressed at send time. The scan operation is a staging-only mutable action and requires `reports.mutate`.

## Device test matrix

| Case | Setup/action | Expected evidence |
|---|---|---|
| Authorized admin | Active admin with `reports.read`; open queue and receive R40 push | GET succeeds; exact `anomalyKey` item sorts first/highlights; candidate and delivery IDs are traceable |
| Admin mutation | Admin with `reports.mutate` resolves a staging incident | POST succeeds, audit is recorded, incident is resolved, pending delivery stops |
| Admin lacking read permission | Authenticated admin without `reports.read` opens notification | API returns 403; screen shows safe error; no incident data appears |
| Buyer/vendor recipient | Use role-scoped staging account and attempt queue route/API | Role guard/API denies access; no incident data appears |
| Unauthenticated cold start | Clear session, tap R40 push from terminated app | Tap remains pending through auth initialization; after login as authorized admin it opens queue and marks only the recipient's inbox row read |
| Background tap | Put authenticated app in background and tap push | Same authenticated route and correct incident highlight; a duplicate response does not navigate twice |
| Terminated tap | Force-stop app and tap OS notification | Last-response path restores session and opens queue once |
| Stale/resolved incident | Resolve staging incident before tap/send | Queue may show resolved state or empty safe state; send-time check suppresses pending push |
| Missing push token | Remove test device token and run delivery sweep | Candidate remains retryable with bounded backoff; no false delivered receipt |
| Provider failure | Use a test provider failure/invalid test token | Failed receipt is recorded and retried/dead-lettered per policy; no delivered state is claimed |

## Semantic destination source review

The checked-in [`05-deeplink-matrix.md`](05-deeplink-matrix.md) maps the 15 semantic destination keys to source routes and role fallbacks. PR #5 adds the `admin_case` R40 destination. Review status is source mapping only: route existence does not prove native runtime or authorization. The destination set is `store_setup`, `foodstuff_editor`, `verification`, `inventory_detail`, `order_detail`, `store_share`, `first_sale`, `automation_detail`, `checkout`, `foodstuff_subscription`, `community_buy_campaign`, `support_case`, `dispute_case`, `membership`, and `admin_case`. Each needs role-appropriate device tap testing, including missing entity IDs and stale/deleted entities; authenticated backend ownership checks remain authoritative.

## Commands

From a clean mobile PR worktree, run:

```sh
npm run typecheck
npm run check:domains
npm run check:tab-registration
npm run check:automation-managed-types-viewable
npm run check:release-config
```

If Android tooling is installed and an authorized staging device/emulator is available, first set up the staging build configuration and then use `npx expo run:android`; install/tap QA must be recorded separately from compilation. No production endpoint, token, or test incident belongs in committed files.
