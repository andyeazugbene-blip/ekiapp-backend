/**
 * Flag known QA / seed accounts as test records (isTest = true) so they are
 * excluded from production dashboard + analytics metrics by default
 * (handbook 2.1 L139, 14.12).
 *
 * DRY-RUN BY DEFAULT: prints what WOULD be flagged and changes nothing.
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/flag-test-data.ts            # dry run
 *   DATABASE_URL=postgresql://... npx tsx scripts/flag-test-data.ts --apply    # write
 *
 * Deliberately does NOT load dotenv: you must pass DATABASE_URL explicitly so
 * the target database is always a conscious choice. Refuses --apply when
 * NODE_ENV=production unless --i-know-this-is-production is also given.
 *
 * Matching (case-insensitive, ADMIN accounts are never touched):
 *   email ends with @local.test | @seed.test | @test.local | @example.test
 *   email starts with qa+ | test@ | test+
 *   email contains +qa@ | +test@
 * Flagging a user also flags their vendor, the orders they bought or sold and
 * those orders' payments (same cascade as PATCH /admin/users/:id/test-flag).
 * Not audited per row (no acting admin); the run summary is logged instead.
 */
import { PrismaClient } from "@prisma/client";

export const TEST_EMAIL_PATTERNS = {
  endsWith: ["@local.test", "@seed.test", "@test.local", "@example.test"],
  startsWith: ["qa+", "test@", "test+"],
  contains: ["+qa@", "+test@"],
} as const;

export function buildTestEmailWhere() {
  const mode = "insensitive" as const;
  return {
    role: { not: "ADMIN" as const },
    isTest: false,
    OR: [
      ...TEST_EMAIL_PATTERNS.endsWith.map((v) => ({ email: { endsWith: v, mode } })),
      ...TEST_EMAIL_PATTERNS.startsWith.map((v) => ({ email: { startsWith: v, mode } })),
      ...TEST_EMAIL_PATTERNS.contains.map((v) => ({ email: { contains: v, mode } })),
    ],
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const prodOk = process.argv.includes("--i-know-this-is-production");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set explicitly (dotenv is intentionally not loaded).");
    process.exit(1);
  }
  if (apply && process.env.NODE_ENV === "production" && !prodOk) {
    console.error("Refusing --apply with NODE_ENV=production without --i-know-this-is-production.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      where: buildTestEmailWhere(),
      select: { id: true, email: true, role: true, vendor: { select: { id: true, storeName: true } } },
      orderBy: { createdAt: "asc" },
    });
    console.log(`${apply ? "APPLY" : "DRY RUN"}: ${users.length} account(s) match test patterns`);

    let totals = { users: 0, vendors: 0, orders: 0, payments: 0 };
    for (const u of users) {
      const orderWhere = u.vendor ? { OR: [{ buyerId: u.id }, { vendorId: u.vendor.id }] } : { buyerId: u.id };
      const [orders, payments] = await Promise.all([
        prisma.order.count({ where: { ...orderWhere, isTest: false } }),
        prisma.payment.count({ where: { order: orderWhere, isTest: false } }),
      ]);
      console.log(
        `  ${u.email} [${u.role}]${u.vendor ? ` vendor="${u.vendor.storeName}"` : ""} -> orders:${orders} payments:${payments}`,
      );
      if (apply) {
        const [, v, o, p] = await prisma.$transaction([
          prisma.user.update({ where: { id: u.id }, data: { isTest: true } }),
          prisma.vendor.updateMany({ where: { userId: u.id }, data: { isTest: true } }),
          prisma.order.updateMany({ where: orderWhere, data: { isTest: true } }),
          prisma.payment.updateMany({ where: { order: orderWhere }, data: { isTest: true } }),
        ]);
        totals = { users: totals.users + 1, vendors: totals.vendors + v.count, orders: totals.orders + o.count, payments: totals.payments + p.count };
      }
    }
    console.log(apply ? `Flagged: ${JSON.stringify(totals)}` : "Dry run only. Re-run with --apply to write.");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
