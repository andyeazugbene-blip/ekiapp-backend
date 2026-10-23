/**
 * One-off backfill clearing the stale `timing.frequencyCapDays: 7` on an
 * already-seeded FIRST_SALE AutomationRule row.
 *
 * automationRulesService.ensureRules() only CREATES a rule row for a type
 * that has none — it "never touches existing rows" (its own doc comment).
 * An environment where an admin already opened the Automation Centre (which
 * calls ensureRules()) got a FIRST_SALE row seeded with the OLD default
 * (META.FIRST_SALE.frequencyCapDays: 7). getRuleGate() reads that row's
 * `timing` JSON and isEligible() in automation.service.ts applies it
 * (`timing?.frequencyCapDays ?? input.frequencyCapDays`) — so the stored
 * row keeps enforcing the old flat 7-day cap even after the code-level fix
 * (2026-10-22: real day 1/3/5/7 schedule, no frequencyCapDays in the
 * detector call itself) ships. This script closes that gap for an
 * environment that already seeded the row.
 *
 * Only clears the field if it's still exactly the old value (7) — an
 * admin's own deliberate override of this field is left untouched.
 *
 * Idempotent: running it again when the field is already null/not-7 is a
 * no-op.
 *
 * Usage:
 *   npm run backfill:first-sale-rule-timing -- --dry-run   (default)
 *   npm run backfill:first-sale-rule-timing -- --confirm   (applies)
 */
import "dotenv/config";
import { PrismaClient, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes("--confirm");
const KEY = "FIRST_SALE";

async function main() {
  const rule = await prisma.automationRule.findUnique({ where: { key: KEY } });
  if (!rule) {
    console.log(`No "${KEY}" AutomationRule row exists yet — nothing to backfill (it will seed without the cap on first use).`);
    return;
  }
  const timing = (rule.timing ?? {}) as Record<string, unknown>;
  if (timing.frequencyCapDays !== 7) {
    console.log(`"${KEY}".timing.frequencyCapDays is ${JSON.stringify(timing.frequencyCapDays)}, not the old default of 7 — leaving untouched (looks admin-set).`);
    return;
  }

  const newTiming = { ...timing, frequencyCapDays: null };
  console.log(`${DRY_RUN ? "[dry-run] would update" : "Updating"} "${KEY}".timing.frequencyCapDays: 7 -> null`);
  if (!DRY_RUN) {
    await prisma.automationRule.update({ where: { key: KEY }, data: { timing: newTiming as Prisma.InputJsonValue } });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
