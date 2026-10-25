# Database Report

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

## What was deliberately NOT added this pass

`task_episode_key`, `Preference`, `Outcome` tables from the spec's full data contract — not added. Adding them now, with no WhatsApp integration to coordinate against and no event-consumer to populate `Outcome`, would be schema sitting unused — the same mistake as leaving a stale config value around, just at table-creation time instead of row-update time. They're the concrete next step once the WhatsApp provider decision (see `08-outstanding-decisions.md`) is made.
