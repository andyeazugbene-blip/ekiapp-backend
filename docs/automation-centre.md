# Automation Centre

## What exists
- `AutomationRule` (one per `AutomationType`, key = type name, seeded idempotently on first admin read). Enforced by the engine: `state`, `timing.frequencyCapDays`, `timing.quietHoursStartUtc/EndUtc`, `channels` (writes the matching `CommunicationTemplate`). All other fields are descriptive.
- `automationService.scheduleAutomation` order: emergency pause -> rule state -> quiet hours -> eligibility. **Every** suppression writes an `AutomationRun` (`SUPPRESSED` + `suppressedReason`) under `<type>:<subject>:suppressed:<reason>:<day>`, so the real `<type>:<subject>` key is never consumed and the run can still happen later. Reasons: `emergency_pause`, `rule_paused|rule_archived|rule_draft|rule_test|rule_failed`, `quiet_hours`, `recipient_not_found`, `recipient_suspended`, `no_marketing_consent`, `vendor_disabled_automation`, `frequency_capped`, `duplicate_key`.
- Sweep (`automationDetectors.runSweep`) skips a detector whose rule is not ACTIVE and records `lastSkippedAt/lastSkipReason` on the rule plus an `automation_suppressed` event.
- Run states shown to admins: Suppressed, Failed, Triggered, Queued, **Handed to provider** (SENT), **Delivered** only when a `CommunicationLog` row has a provider receipt.
- Admin API (`/admin/automation/...`, `automation.read` / `automation.mutate`, mutations need 2FA + reason + audit): rules, patch, pause/resume/archive/duplicate/test, emergency-stop (+release), runs, runs/:id/retry, failures, performance; `GET /admin/events`.
- Retry: new run with key `<root>:retry:<n>` (unique), refused when an earlier retry succeeded; eligibility is re-checked.
- `Event` table + `eventsService.emit()` (fire-and-forget, never throws). Currently emitted by the automation engine and trial-ending handler only.
- Vendor trial ending: Stripe `customer.subscription.trial_will_end` -> `VENDOR_TRIAL_ENDING` automation (push, in-app, email), idempotent via `WebhookEvent` and the run dedupe key. Trial length stays 14 days (`GROWTH_TRIAL_DAYS`).

## Phase 5 backlog (NOT built)
- Event emits at payment, order-transition, subscription, communication and merchant-activation points; `public_store.*` audit rows are not yet mirrored into `Event`.
- Attribution / assisted / incremental revenue: out of scope until an approved comparison or holdout method exists. No such metric is shown.
- First Sale Campaign engine, First Sale Diagnostic, Post-sale transition, state-aware vendor dashboard, vendor referral programme and credit ledger, SMS (decision: no SMS).
- Low-stock alert carrying product ids / deep link and cart-recovery last-activity logic (`Cart` has no last-activity column; detector still uses item age).
- "Invalid token" as a distinct suppression reason (push layer reports it only in the channel log).
- Opened / clicked tracking; background job failures are not persisted as rows.
- Rule duplicates are DRAFT documentation copies; the engine only executes the rule keyed by an `AutomationType`.
