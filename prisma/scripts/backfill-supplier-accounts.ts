/**
 * Community Buy Workstream 1 — one-time (idempotent, safe to re-run)
 * backfill of SupplierAccount from every existing SupplierProfile.
 *
 * Deterministic, evidence-based classification (matches
 * supplierAccountService.syncSupplierAccountForProfile exactly, since this
 * script's loop body IS that function — not a separate, divergent copy):
 *   isRestricted=true                    -> RESTRICTED
 *   isVerified=true, isRestricted=false  -> APPROVED
 *   isVerified=false, isRestricted=false -> UNDER_REVIEW
 * NOT_STARTED/DRAFT/VERIFICATION_REQUIRED/INFORMATION_REQUIRED/PAUSED/
 * SUSPENDED/CLOSED are never fabricated from these two booleans.
 *
 * Run: npx tsx prisma/scripts/backfill-supplier-accounts.ts
 */
import { prisma } from "../../src/lib/prisma";
import { supplierAccountService } from "../../src/modules/community-buy/supplier-account.service";

async function main() {
  const profiles = await prisma.supplierProfile.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  console.log(`Total SupplierProfile rows to process: ${profiles.length}\n`);

  const counts: Record<string, number> = { APPROVED: 0, RESTRICTED: 0, UNDER_REVIEW: 0, SKIPPED: 0 };

  for (const { id } of profiles) {
    const result = await supplierAccountService.syncSupplierAccountForProfile(id);
    if (!result) {
      counts.SKIPPED += 1;
      console.log(`SupplierProfile ${id} -> SKIPPED (not found at read time)`);
      continue;
    }
    counts[result.state] = (counts[result.state] ?? 0) + 1;
    console.log(
      `SupplierProfile ${result.profileId} (Vendor ${result.vendorId}, User ${result.userId})\n` +
        `  -> ${result.state}. Evidence: ${result.reason}\n`,
    );
  }

  console.log("Counts:", counts, `Total SupplierProfile rows processed=${profiles.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
