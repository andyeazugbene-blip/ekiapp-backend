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
| Event publisher/consumer | reliable, at-least-once | `eventOutboxService.dispatchBatch()` claims by compare-and-swap, recovers stale leases, runs DB-only consumers and commits consumer writes with DELIVERED state, retries exponentially, and dead-letters after 8 failures. `/api/internal/jobs/event-outbox` invokes registered consumers through the existing authenticated daily sweep. | **Consumer foundation implemented; no notification handlers are registered yet.** Events without a reviewed handler stay pending and are reported as unhandled. No unsupported event→rule mapping was invented. |
| Versioned event validation | `version` field, migration on meaning change | Outbox ingress/dispatch validate schema version 1, canonical event names from `EVENT_NAMES`, object payload shape, and valid occurrence dates. Unknown names/versions are rejected; malformed persisted records are dead-lettered. | **Envelope validation implemented; event-specific schemas remain to be mapped from the missing authoritative source.** |
| Notification candidate | `NotificationCandidate` (due_at, expires_at, state, task_episode_key) | `AutomationRun` (no `task_episode_key`, no `expires_at`) | **Partial.** `AutomationRun` already has most of the shape (id, type≈rule_id, recipientUserId, status, dedupeKey≈idempotency); missing `task_episode_key` and `expires_at`. |
| Recipient/role resolution | explicit | Implicit in each detector's query | **Implemented, not centralized.** Works; not a shared service. |
| Eligibility/consent | `Preference` (per-channel, per-category consent, timezone) | `User.marketingConsentAt` (one boolean-ish timestamp, no per-channel granularity), country-based quiet-hours heuristic (no real timezone) | **Partial, real gap.** No per-channel consent, no real per-user timezone. |
| Cross-channel task-episode dedup | `task_episode_key = user+role+entity_type+entity_id+task_key`, suppresses push if WhatsApp already sent | `dedupeKey` (single-channel, per automation type) | **Not implemented.** No WhatsApp integration exists at all to coordinate against — see `08-outstanding-decisions.md`. |
| Scheduling/quiet hours | per-user `Preference.quiet_hours_start/end` + timezone | Global 22:00–07:00 UTC window, approximated per-country — [automation.service.ts](../../src/modules/automation/automation.service.ts) `isQuietHoursWith`/`localQuietHoursToUtc` | **Partial, documented limitation already in the code's own comments.** |
| Send-time recheck | re-verify state right before send | Done per-detector (e.g. `REORDER_REMINDER` rechecks stock/availability at send time, not schedule time) | **Implemented for the automations fixed this week.** Not audited for all 40 rules. |
| Template rendering | versioned, variant_id | `CommunicationTemplate` (admin-editable, no version/variant tracking) | **Partial.** No versioning. |
| In-app inbox + channels | push/in_app/email/sms/whatsapp | push (Expo) / in_app / email only | **Partial.** No SMS (explicit product decision, documented elsewhere), no WhatsApp. |
| Provider receipt | `NotificationDelivery.status` (queued→sent→delivered→opened→failed) | `CommunicationLog.status` — distinguishes QUEUED/SENT/FAILED; "DELIVERED" only on a real receipt sweep | **Implemented, same honesty standard the spec asks for** (never claims delivered without a receipt). |
| Click/completion attribution | `Outcome` table | None | **Not started.** |
| Audit history | full | `AutomationRun` + `AuditLog` + `CommunicationLog` | **Implemented, fragmented across 3 tables rather than one `Outcome`/audit model.** |

## Remaining architecture work

The current deployment is Vercel serverless, so the outbox is drained by an authenticated poll on the existing cron rather than a persistent process. The new schema migration is additive and has not been applied to production. Domain producers must be moved into `enqueueTransactional` only where an existing real transaction and approved event contract are confirmed. The candidate lifecycle can reuse `AutomationRun`; per-channel `NotificationDelivery`, cross-channel task-episode coordination, and notification handlers still need implementation. WhatsApp provider receipt and cooldown behavior remain blocked until a provider is selected.

## What this pass actually did toward the target

1. Extended the existing `Event` table with an opt-in transactional outbox lifecycle while preserving all prior append-only event writes as `LOG_ONLY`.
2. Added an idempotent transactional enqueue API, v1 envelope validation, compare-and-swap claims, stale-lease recovery, exponential retry, dead-letter status, an authenticated internal sweep route, and tests for duplicate-safe enqueue, claim/consume, retry, and dead-letter behavior.
3. Did not add a parallel `NotificationCandidate` table: `AutomationRun` is the current candidate record and should be evolved. No domain producer or handler has been mapped to notification rules yet because the authoritative v2 event contract is still missing.
