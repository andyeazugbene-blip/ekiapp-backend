# Architecture Report — Target Pipeline vs. Current State

Formalizes the ADR already discussed with the client (2026-10-25), with the client's "full rebuild per spec" decision on record.

## Target pipeline (spec section 4)

```
Domain transaction + outbox → event publisher → versioned validator → candidate
→ recipient/role resolution → eligibility/consent → task-episode dedup
→ scheduling/quiet-hours → send-time recheck → template renderer
→ in-app inbox + channels → provider receipt → attribution → audit history
```

## Component-by-component status

| Pipeline stage | Spec contract | Current equivalent | Status |
|---|---|---|---|
| Transactional outbox | `DomainEvent` | Existing `Event` table — [event-outbox.service.ts](../../src/modules/events/event-outbox.service.ts) adds schema version, unique dedupe key, delivery state, attempts, lease, and error fields. `eventsService.enqueueTransactional(tx, input, {dedupeKey})` writes through the caller's business transaction. | **Foundation implemented; producers still need reviewed per-event mappings.** Existing `emit()` callers remain log-only and were not silently changed. |
| Event publisher/consumer | reliable, at-least-once | `eventOutboxService.dispatchBatch()` claims by compare-and-swap, recovers stale leases, runs DB-only consumers and commits consumer writes with DELIVERED state, retries exponentially, and dead-letters after 8 failures. `/api/internal/jobs/event-outbox` invokes registered consumers through the existing authenticated sweep. A v1 `support_response_received` consumer maps verified general SUPPORT admin replies to R28. | **First real notification handler implemented (R28).** Other event names without a reviewed handler remain pending and are reported as unhandled. |
| Versioned event validation | `version` field, migration on meaning change | Outbox ingress/dispatch validate schema version 1, canonical event names from `EVENT_NAMES`, object payload shape, and valid occurrence dates. Unknown names/versions are rejected; malformed persisted records are dead-lettered. | **Envelope validation implemented; event-specific schemas remain to be mapped from the missing authoritative source.** |
| Notification candidate | `NotificationCandidate` (due_at, expires_at, state, task_episode_key) | Shared `Notification` now stores rule/version, event, role, category/priority, entity, unique task episode, due/expiry, template/variant and candidate lifecycle. Event-backed rules write it through the transactional outbox. | **Shared persistence contract implemented; producers remain rule-by-rule and gated where QA is pending.** |
| Recipient/role resolution | explicit | Implicit in each detector's query | **Implemented, not centralized.** Works; not a shared service. |
| Eligibility/consent | `Preference` (per-channel, per-category consent, timezone) | New role/channel/category preference rows include consent, IANA timezone and quiet hours; push dispatch checks service and marketing consent at send time. | **Implemented for push policy; other channels and legacy automation paths are not unified.** |
| Cross-channel task-episode dedup | `task_episode_key = user+role+entity_type+entity_id+task_key`, suppresses push only after WhatsApp delivery inside configured cooldown | Push policy requires the exact task episode, `channel=whatsapp`, `status=DELIVERED`, a positive `deliveredAt` receipt inside `NOTIFICATION_WHATSAPP_TASK_COOLDOWN_SECONDS`, and exempts critical transactional rules. The cooldown defaults to zero/unset, which disables suppression. | **Provider-neutral receipt lookup implemented; provider and approved cooldown configuration are absent, so no WhatsApp delivery or cross-channel suppression is currently claimed.** |
| Scheduling/quiet hours | per-user `Preference.quiet_hours_start/end` + timezone | New push preference policy defers non-P0 deliveries to recipient-local quiet-hour end; legacy automation still uses its existing global/country heuristic. | **Implemented for orchestration push candidates; legacy automations and scheduler cadence remain limited.** |
| Send-time recheck | re-verify state right before send | `dispatchRun()` now re-reads the active rule, global pause, recipient suspension/marketing consent, vendor toggle, frequency cap, and quiet-hours state immediately before provider dispatch; the candidate is marked `SUPPRESSED` with an explicit `send_time_*` reason when state changed. | **Shared pre-send checks implemented; domain-specific stop predicates and authoritative per-channel policy remain per-rule work.** |
| Template rendering | versioned, variant_id | Candidate and delivery persist templateVersion and variantId; current rule copy remains source-controlled. | **Metadata contract implemented; central verified template renderer is not.** |
| In-app inbox + channels | push/in_app/email/sms/whatsapp | R28 persists the in-app `Notification` and a per-channel `NotificationDelivery` push row; existing code also has Expo push / email. | **Push/in-app implemented for R28.** SMS and WhatsApp are not configured; other rules are not yet migrated to the shared delivery model. |
| Provider receipt | `NotificationDelivery.status` (queued→sent→delivered→opened→failed) | R28 `NotificationDelivery` tracks pending/processing/sent/delivered/retry/dead; `CommunicationLog` + `PushTicket` preserve attempt and Expo receipt evidence. | **Implemented for R28 push.** Delivery is not claimed at Expo ticket acceptance; only a positive receipt sets DELIVERED. Failed receipts and immediate send failures are retried with bounded backoff. |
| Click/completion attribution | `Outcome` table | Notification open records clickedAt; mapped source completion events and authenticated R09 sharing update outcome rows with completion event and attribution model. | **Implemented for tracked event-backed candidates; not yet universal across rules/channels.** |
| Audit history | full | `AutomationRun` + `AuditLog` + `CommunicationLog` | **Implemented, fragmented across 3 tables rather than one `Outcome`/audit model.** |

## Remaining architecture work

The current deployment is Vercel serverless, so outbox and delivery work use authenticated poll jobs; the existing Vercel cron runs daily, limiting retry and P2 timing. The sub-daily GitHub Actions scheduler has a recent run with five HTTP 401s and multi-hour gaps; its code now fails visibly, but runtime remains unverified. The candidate-contract migration is additive and has not been applied to production. R28, R07–R09, and R12/R21/R22 have reviewed event-backed paths; additional producers must move into `enqueueTransactional` only where real transactions and approved contracts are confirmed. WhatsApp suppression now requires a bounded configured cooldown and delivered receipt timestamp; no provider, receipt, or cooldown configuration is present.

## What this pass actually did toward the target

- Added shared send-time revalidation to the existing `AutomationRun` path, including regression coverage for a recipient becoming unavailable after initial eligibility. This closes a state-change gap for current synchronous runs and future queued retries; it does not replace event-driven candidate creation or provider-delivery retries.

1. Extended the existing `Event` table with an opt-in transactional outbox lifecycle while preserving all prior append-only event writes as `LOG_ONLY`.
2. Added an idempotent transactional enqueue API, v1 envelope validation, compare-and-swap claims, stale-lease recovery, exponential retry, dead-letter status, an authenticated internal sweep route, and tests for duplicate-safe enqueue, claim/consume, retry, and dead-letter behavior.
3. At the time of the original outbox-foundation pass, did not add a parallel `NotificationCandidate` table; existing `AutomationRun` remains the candidate for legacy automation rules. The later R28 implementation evidence above records the first concrete event producer and consumer.

## R28 implementation evidence — 2026-10-26

- General support admin replies now write a versioned outbox event in the message transaction. The registered consumer verifies the actual SUPPORT conversation, admin sender, non-admin recipient membership, unread reply, and open state before creating the exact v2 inbox candidate and unique push delivery.
- The authenticated delivery sweep rechecks current thread/message/recipient state before dispatch. Each attempt writes a `CommunicationLog`; Expo ticket receipts update the delivery outcome and failed receipts enter bounded backoff. The existing daily cron is the only configured retry cadence.
- Focused evidence: `core-event-handlers.test.ts`, `notification-delivery.test.ts`, and `event-outbox.test.ts`; backend build and Prisma validation passed on this feature branch. Native device QA and production migration application remain outstanding.
