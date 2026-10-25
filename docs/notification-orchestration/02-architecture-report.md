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
| Transactional outbox | `DomainEvent` | `Event` table — [events.service.ts](../../src/modules/events/events.service.ts) `emit()` writes it already | **Exists, unconsumed.** Nothing drains this table. This is the real seed for Phase 1, not new infrastructure. |
| Event publisher/consumer | reliable, at-least-once | None — no queue, no worker process | **Not started.** Vercel serverless has no long-running consumer; see scheduler report for the real constraint. |
| Versioned event validation | `version` field, migration on meaning change | None | **Not started.** |
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

## Why this is not done in one pass

Per the ADR: Vercel serverless has no persistent consumer process, so "event-driven" here must mean **poll-and-drain on the existing cron for P2/P3, synchronous direct calls for P0/P1** (already how most P0/P1 events work today) — not a literal message bus. Building `task_episode_key` cross-channel suppression is specified but **unimplementable until a WhatsApp provider is chosen** — the field can exist, it has nothing to coordinate against yet.

## What this pass actually did toward the target

1. Confirmed the `Event`/outbox seed already exists and is the right Phase-0 foundation (no new table needed to start).
2. Implemented the spec's **P2 cadence model** (4h/24h/72h, max 3 sends, attempt-every-due-threshold idempotency) for the 5 vendor-onboarding rules — this is the first real instance of spec-shaped timing logic in the codebase, reusable for the next rules.
3. Did **not** add `task_episode_key`, `Preference`, or `Outcome` tables this pass — adding them without a consumer or a WhatsApp integration to use them would be schema for its own sake, not a safe increment. They're the next concrete step once a WhatsApp decision is made.
