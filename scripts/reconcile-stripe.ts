/**
 * Stripe Reconciliation
 * Compares recent Stripe PaymentIntents with local DB records.
 * Safe to run in production — read-only.
 *
 * Usage: npx tsx scripts/reconcile-stripe.ts
 */
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import "dotenv/config";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

async function main() {
  console.log("=== STRIPE RECONCILIATION ===\n");
  let mismatches = 0;

  // Get recent succeeded PIs from Stripe (last 24h)
  const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const pis = await stripe.paymentIntents.list({ limit: 100, created: { gte: since } });

  console.log(`Stripe PaymentIntents (last 24h): ${pis.data.length}\n`);

  for (const pi of pis.data) {
    if (pi.status !== "succeeded") continue;
    const checkoutId = pi.metadata?.checkoutId;
    if (!checkoutId) continue;

    const checkout = await prisma.checkout.findUnique({
      where: { id: checkoutId },
      select: { id: true, status: true, totalAmount: true },
    });

    if (!checkout) {
      console.log(`  ❌ PI ${pi.id}: checkout ${checkoutId} NOT FOUND in DB`);
      mismatches++;
      continue;
    }

    if (checkout.status !== "SUCCEEDED") {
      console.log(`  ❌ PI ${pi.id}: Stripe=succeeded, DB=${checkout.status}`);
      mismatches++;
    }

    if (checkout.totalAmount !== pi.amount) {
      console.log(`  ❌ PI ${pi.id}: Stripe amount=${pi.amount}, DB amount=${checkout.totalAmount}`);
      mismatches++;
    }
  }

  // Check for DB checkouts marked SUCCEEDED without a matching Stripe PI
  const recentCheckouts = await prisma.checkout.findMany({
    where: { status: "SUCCEEDED", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, stripePaymentIntentId: { not: null } },
    select: { id: true, stripePaymentIntentId: true, totalAmount: true },
  });

  for (const co of recentCheckouts) {
    if (!co.stripePaymentIntentId) continue;
    try {
      const pi = await stripe.paymentIntents.retrieve(co.stripePaymentIntentId);
      if (pi.status !== "succeeded") {
        console.log(`  ❌ Checkout ${co.id}: DB=SUCCEEDED, Stripe=${pi.status}`);
        mismatches++;
      }
    } catch {
      console.log(`  ❌ Checkout ${co.id}: PI ${co.stripePaymentIntentId} not found on Stripe`);
      mismatches++;
    }
  }

  console.log(`\nChecked: ${pis.data.filter(p => p.status === "succeeded").length} Stripe PIs, ${recentCheckouts.length} DB checkouts`);
  console.log(`Mismatches: ${mismatches}`);
  console.log(mismatches === 0 ? "\n✅ PASS — Stripe reconciles" : "\n❌ FAIL — Mismatches found");

  await prisma.$disconnect();
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
