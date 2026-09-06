/**
 * One-off backfill for the vendor multi-market migration.
 *
 * Every existing vendor's CURRENT Vendor.country becomes their initial
 * VendorMarketAssignment — never every market, never a guess: exactly the
 * one market they already have. Uses the real resolveMarketCode() resolver
 * (src/shared/currency.ts) so a legacy vendor whose country predates the
 * launch-market list still gets a row preserving their data, just under a
 * non-canonical marketCode that can never match a real launch-market gate
 * (correct — they were never actually approved for one).
 *
 * Idempotent: vendorMarketsService.ensureInitialAssignment() upserts, so
 * running this more than once is a no-op for vendors already backfilled.
 *
 * Usage:
 *   npm run backfill:vendor-markets -- --dry-run   (default, no writes)
 *   npm run backfill:vendor-markets -- --confirm   (applies)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

import { vendorMarketsService } from "../src/modules/vendors/vendor-markets.service";

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes("--confirm");

async function main() {
  const vendors = await prisma.vendor.findMany({
    select: { id: true, storeName: true, country: true },
  });

  const withCountry = vendors.filter((v) => v.country && v.country.trim().length > 0);
  const withoutCountry = vendors.length - withCountry.length;

  console.log(`Found ${vendors.length} vendors (${withCountry.length} with a country, ${withoutCountry} without — skipped, nothing to backfill).`);
  console.log(DRY_RUN ? "DRY RUN — no writes will be made. Pass --confirm to apply." : "CONFIRM — writing assignments now.");

  let created = 0;
  for (const vendor of withCountry) {
    if (DRY_RUN) {
      const already = await prisma.vendorMarketAssignment.findFirst({ where: { vendorId: vendor.id } });
      console.log(`${already ? "SKIP (exists)" : "WOULD CREATE"}  ${vendor.storeName}  country="${vendor.country}"`);
      if (!already) created += 1;
      continue;
    }
    const before = await prisma.vendorMarketAssignment.count({ where: { vendorId: vendor.id } });
    await vendorMarketsService.ensureInitialAssignment(vendor.id, vendor.country!);
    const after = await prisma.vendorMarketAssignment.count({ where: { vendorId: vendor.id } });
    if (after > before) created += 1;
  }

  console.log(`${DRY_RUN ? "Would create" : "Created"} ${created} new assignment(s). ${withCountry.length - created} vendor(s) already had one.`);
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
