# Database Report

> This report contains historical migration snapshots from earlier PRs. The current verification found no schema change in merged PR #47; see `11-final-verification-2026-10-27.md`. Statements about older open PRs below are historical, not live PR status.

## Current notification orchestration contract — 2026-10-27

The follow-up migration `20261027120000_notification_candidate_contract` adds candidate lifecycle and orchestration metadata to `Notification`/`NotificationDelivery`, role-scoped `NotificationPreference` and `NotificationOutcome` tables, and task-episode linkage on `CommunicationLog`. It is additive; no existing row is deleted or rewritten. `prisma validate` and client generation pass against the updated schema. Production migration has not been applied.

The contract is used by the gated event-backed notification path. Legacy automation rows may leave the new nullable candidate fields empty. Push dispatch records per-role/channel consent, defers noncritical notifications across configured quiet hours, checks WhatsApp delivery logs for the same task episode, and records send lifecycle; notification opens and selected verified completion events update outcomes.

## Migrations in this pass's PRs

**PR #5** (merged 2026-10-23):
- `20261022000000_add_registration_reminder_automation` — `ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'REGISTRATION_REMINDER'`.

**PR #6** (open):
- `20261025000000_split_first_sale_onboarding_rules` — adds `FIRST_PRODUCT_REMINDER`, `DELIVERY_SETUP_REMINDER`, `VERIFICATION_REMINDER` to the same enum, same `ADD VALUE IF NOT EXISTS` pattern.

Both are **purely additive, single-statement enum extensions** — the exact pattern already used successfully twice before in this repo's migration history (`20260910140000_add_new_automation_types`, confirmed by reading that file directly before writing these). No column changes, no table changes, no data migration, nothing destructive.

## Compatibility with the currently deployed version

Old code never references the new enum values, so it is unaffected whether the migration runs before or after the old code is still live. New code (post-PR-#6 deploy) does reference them, so the **safe order is migrate-then-deploy**, not the other way — this was learned the hard way this week: PR #5's migration was applied correctly, but two separate `AutomationRule` config rows (`FIRST_SALE.timing.frequencyCapDays`, `CART_RECOVERY.timing.frequencyCapDays`) had been seeded with stale pre-fix defaults and were NOT touched by the migration — only by a manually-run backfill script, run against production after the merge. That gap (code deployed, config not backfilled, bug stayed live) is the direct cause of last week's "still no notification" report from the client — documented here so it isn't repeated for PR #6's new rule types, which don't need a backfill (they're brand-new types with no pre-existing stale rows).

## Rollback / recovery

To roll back either migration: `ALTER TYPE` additions in Postgres cannot be cleanly reversed with a `DROP VALUE` (Postgres doesn't support removing an enum value if any row might reference it, and even if none do, the operation isn't supported pre-PG16 at all). The safe rollback is:
1. Revert the application code first (stop writing/reading the new type(s)).
2. Leave the enum value in place — an unused enum value is harmless.
3. Only if the value must truly be removed: a manual, out-of-band migration recreating the enum type without it, run only after confirming (via `SELECT DISTINCT type FROM "AutomationRule"`/`"AutomationRun"` or equivalent) that zero rows use it.

## Indexes / constraints for idempotency

`AutomationRun.dedupeKey` is the existing unique constraint this pass relies on for idempotency — confirmed present and unchanged; every new rule's dedupe key (`{id}:touch{N}`) goes through the same unique-constraint-backed `scheduleAutomation()` path as every other automation, not a new mechanism.

## Historical note from the earlier pass

At the earlier pass, `task_episode_key`, `Preference`, and `Outcome` were intentionally deferred. The new follow-up now adds those structures while retaining the remaining provider/runtime limitations in `08-outstanding-decisions.md`.
