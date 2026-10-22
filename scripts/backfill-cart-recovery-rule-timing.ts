/**
 * One-off backfill clearing the stale `timing.frequencyCapDays: 1` on an
 * already-seeded CART_RECOVERY AutomationRule row.
 *
 * Same situation as backfill-first-sale-rule-timing.ts: automationRulesService
 * .ensureRules() only CREATES a rule row for a type that has none, so an
 * environment where this rule already seeded keeps enforcing the OLD
 * frequencyCapDays even after the 2026-10-22 code fix (bounded two-touch
 * schedule, no per-call frequencyCapDays) ships, because getRuleGate()
 * reads the STORED row's timing and isEligible() applies it on top of
 * whatever the detector passes.
 *
 * Only clears the field if it's still exactly the old value (1) — an
 * admin's own deliberate override is left untouched.
 *
 * Usage:
 *   npm run backfill:cart-recovery-rule-timing -- --dry-run   (default)
 *   npm run backfill:cart-recovery-rule-timing -- --confirm   (applies)
 */
import "dotenv/config";
import { PrismaClient, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes("--confirm");
const KEY = "CART_RECOVERY";

async function main() {
  const rule = await prisma.automationRule.findUnique({ where: { key: KEY } });
  if (!rule) {
    console.log(`No "${KEY}" AutomationRule row exists yet — nothing to backfill (it will seed without the cap on first use).`);
    return;
  }
  const timing = (rule.timing ?? {}) as Record<string, unknown>;
  if (timing.frequencyCapDays !== 1) {
    console.log(`"${KEY}".timing.frequencyCapDays is ${JSON.stringify(timing.frequencyCapDays)}, not the old default of 1 — leaving untouched (looks admin-set).`);
    return;
  }

  const newTiming = { ...timing, frequencyCapDays: null };
  console.log(`${DRY_RUN ? "[dry-run] would update" : "Updating"} "${KEY}".timing.frequencyCapDays: 1 -> null`);
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
