# Communications providers and delivery paths

Handbook references: section 6.2 (Communication Center), 6.3 (provider reconciliation), 15.6 (channel matrix).

## Channels

| Channel | Provider | What "Sent" means | What "Delivered" means |
| --- | --- | --- | --- |
| In-app | Eki database (`Notification`, plus an admin `Message` for individual sends) | Stored in the recipient's inbox | Not applicable. "Read" is counted from `Notification.readAt`. |
| Push (iOS and Android) | Expo Push Service, which relays to APNs (iOS) and FCM (Android) | Expo accepted the message (a ticket with `status: ok`). This is NOT proof of delivery. | Only recorded when Expo returns a successful **receipt** for the ticket (`status: ok`). |
| Email | Resend (`RESEND_API_KEY`, `EMAIL_FROM`) | Resend accepted the message (message id stored in `CommunicationLog.providerRef`) | Not tracked (no Resend webhook is wired). Inbox delivery is never claimed. |
| SMS | none | Not offered. The admin UI hides SMS and the broadcast engine rejects it. | |

If `RESEND_API_KEY` is missing, `sendEmail` returns `false` in production (`{ok:false, error:"not_configured"}` from `sendEmailDetailed`).
A broadcast then reports email as `not_configured` and writes no "sent" rows. Outside production it logs and returns true so local OTP and
password-reset flows keep working.

## Real push path (iOS and Android)

1. The app registers an Expo push token (`PushToken`, `POST /api/push-tokens`).
2. The backend calls `POST https://exp.host/--/api/v2/push/send` (`src/lib/expo-push.ts`), one request per token. Optional `EXPO_ACCESS_TOKEN`
   attributes sends to the expo.dev project.
3. Expo returns a **ticket** per message. Accepted tickets are stored in `PushTicket` (with `logId` pointing at the broadcast's
   `CommunicationLog` row).
4. Expo hands the message to APNs or FCM using the credentials configured in EAS. There is no relay layer inside Eki, and Eki does not call FCM directly.
5. After at least 5 minutes the receipt sweep calls `POST https://exp.host/--/api/v2/push/getReceipts` (`checkPushReceipts`).
   - receipt `ok` -> `CommunicationLog.status = DELIVERED` (`statusDetail: provider_receipt_ok`)
   - receipt `error` -> `FAILED` with the Expo error (`DeviceNotRegistered`, `InvalidCredentials`, `MessageRateExceeded`, ...). `DeviceNotRegistered` also deletes the token.
   - no receipt yet -> the ticket is kept and retried; after 24 hours with no receipt the row is marked `FAILED: no_receipt_after_24h`.
6. `Broadcast.status` is recomputed from the per-recipient rows (`SENT`, `PARTIALLY_DELIVERED`, `FAILED`).

### Acceptance evidence still required (handbook 15.6)

This repository cannot prove device delivery. To accept push, send a test broadcast to an admin account that has logged into the current
TestFlight build and the agreed Android build, confirm foreground and background behaviour on the devices, and confirm the
`CommunicationLog` row reaches `DELIVERED`.

## Policy applied to broadcasts

Marketing category: requires `User.marketingConsentAt`; push excluded during quiet hours (22:00-07:00 UTC, server time, same constants as the
Automation Engine); one marketing broadcast per recipient per 24 hours (frequency cap); recipients who got an automation message in the last 24 hours are
excluded (automation conflict). Operational notices skip consent/quiet-hours/caps but still skip suspended, anonymised and no-device/no-email recipients.
Suspended accounts are always excluded. The sender is never a recipient. There is no separate per-channel preference table; the only stored
preference is `marketingConsentAt` (cleared by the unsubscribe link or the in-app preference).
Marketing emails carry a signed unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers. `GET|POST /api/unsubscribe?token=...` clears `marketingConsentAt`.
Set `PUBLIC_API_URL` (for example `https://api.example.com/api`) so the link points at the API host; otherwise it falls back to `<PUBLIC_STORE_BASE_URL>/api`.

## Emergency pause

`AdminPlatformSetting` keys `commsPaused` and `automationsPaused` (1 = paused). Toggled by a Super Administrator (`admin.*`, 2FA, reason, audited) from
Communications. Effects: broadcasts refuse to send (409 `COMMS_PAUSED`); the scheduled runner claims nothing; `automation_*` template sends and
`automationService.scheduleAutomation` are suppressed with reason `emergency_pause` (no dedupe key consumed, so they resume normally).
Transactional order/payment/verification messages are never paused.

## Scheduling

`vercel.json` runs `/api/internal/jobs/run-scheduled-communications` every 5 minutes (needs a Vercel plan that allows sub-daily crons; on Hobby only the daily
sweep runs, which also includes this job). The job sends due schedules (`SCHEDULED -> SENDING -> SENT|FAILED`, claimed atomically), pulls Expo receipts,
and refreshes broadcast statuses. A scheduled send therefore starts up to 5 minutes after `scheduledFor`, never before.
