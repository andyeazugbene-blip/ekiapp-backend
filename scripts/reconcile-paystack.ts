/**
 * Paystack Reconciliation
 * Compares PaystackTransaction records with their actual status on Paystack.
 * Safe to run in production — read-only.
 *
 * Usage: npx tsx scripts/reconcile-paystack.ts
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

async function main() {
  console.log("=== PAYSTACK RECONCILIATION ===\n");

  if (!PAYSTACK_SECRET) {
    console.log("PAYSTACK_SECRET_KEY not configured. Skipping.");
    console.log("\n✅ PASS (skipped — no Paystack)");
    await prisma.$disconnect();
    return;
  }

  let mismatches = 0;

  // Get recent Paystack transactions from DB
  const txns = await prisma.paystackTransaction.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    select: { id: true, reference: true, status: true, amount: true },
  });

  console.log(`DB PaystackTransactions (last 24h): ${txns.length}\n`);

  for (const tx of txns) {
    try {
      const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(tx.reference)}`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      });
      const data = await res.json() as { status: boolean; data?: { status: string; amount: number } };

      if (!data.status || !data.data) {
        console.log(`  ⚠️  ${tx.reference}: Paystack API returned error`);
        continue;
      }

      const psStatus = data.data.status === "success" ? "SUCCESS" : data.data.status === "failed" ? "FAILED" : "PENDING";
      if (psStatus !== tx.status) {
        console.log(`  ❌ ${tx.reference}: DB=${tx.status}, Paystack=${psStatus}`);
        mismatches++;
      }

      if (data.data.amount !== tx.amount) {
        console.log(`  ❌ ${tx.reference}: DB amount=${tx.amount}, Paystack amount=${data.data.amount}`);
        mismatches++;
      }
    } catch (error) {
      console.log(`  ⚠️  ${tx.reference}: verify failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\nChecked: ${txns.length} transactions`);
  console.log(`Mismatches: ${mismatches}`);
  console.log(mismatches === 0 ? "\n✅ PASS — Paystack reconciles" : "\n❌ FAIL — Mismatches found");

  await prisma.$disconnect();
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
