/**
 * One-off backfill for adding the "email" channel to the FIRST_SALE
 * onboarding automation's CommunicationTemplate row.
 *
 * ensureTemplate() in automation.service.ts only CREATES the
 * CommunicationTemplate for a type when no row exists yet — once a vendor
 * environment has already run the sweep once, a FIRST_SALE row with the
 * old `["push", "in_app"]` channels is sitting in the DB and the new
 * DEFAULT_TEMPLATES.FIRST_SALE.channels (`["push", "in_app", "email"]`) in
 * code never reaches it on its own. This script closes that gap for an
 * already-running environment.
 *
 * Only touches the row if it still has the exact old channel set and an
 * admin hasn't since hand-edited it away from "email" on purpose — an
 * admin's own edit (any channel list other than the original push+in_app)
 * is left untouched.
 *
 * Idempotent: running it again when the row already includes "email" is a
 * no-op.
 *
 * Usage:
 *   npm run backfill:first-sale-email -- --dry-run   (default, no writes)
 *   npm run backfill:first-sale-email -- --confirm   (applies)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes("--confirm");
const KEY = "automation_first_sale";
const OLD_CHANNELS = ["push", "in_app"];

function sameChannelSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

async function main() {
  const existing = await prisma.communicationTemplate.findUnique({ where: { key: KEY } });
  if (!existing) {
    console.log(`No "${KEY}" template row exists yet — nothing to backfill (it will be created with email included on first real use).`);
    return;
  }
  if (existing.channels.includes("email")) {
    console.log(`"${KEY}" already includes email — nothing to do.`);
    return;
  }
  if (!sameChannelSet(existing.channels, OLD_CHANNELS)) {
    console.log(`"${KEY}" channels (${existing.channels.join(", ")}) were hand-edited away from the original default — leaving untouched. Add email via the admin Communications UI if desired.`);
    return;
  }

  const newChannels = [...OLD_CHANNELS, "email"];
  console.log(`${DRY_RUN ? "[dry-run] would update" : "Updating"} "${KEY}" channels: ${existing.channels.join(", ")} -> ${newChannels.join(", ")}`);
  if (!DRY_RUN) {
    await prisma.communicationTemplate.update({ where: { key: KEY }, data: { channels: newChannels } });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
