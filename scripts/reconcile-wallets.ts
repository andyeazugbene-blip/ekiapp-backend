/**
 * Wallet Ledger Reconciliation
 * Compares wallet balances against the sum of their transactions.
 * Safe to run in production — read-only.
 *
 * Usage: npx tsx scripts/reconcile-wallets.ts
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

async function main() {
  console.log("=== WALLET LEDGER RECONCILIATION ===\n");
  let mismatches = 0;

  // Vendor wallets
  const vendorWallets = await prisma.wallet.findMany({
    select: { id: true, vendorId: true, pendingBalance: true, availableBalance: true },
  });

  for (const wallet of vendorWallets) {
    const txSum = await prisma.walletTransaction.aggregate({
      where: { walletId: wallet.id },
      _sum: { amount: true },
    });
    const expectedTotal = txSum._sum?.amount ?? 0;
    const actualTotal = wallet.pendingBalance + wallet.availableBalance;

    if (expectedTotal !== actualTotal) {
      console.log(`  ❌ Vendor wallet ${wallet.id}: ledger=${expectedTotal} actual=${actualTotal} (diff=${actualTotal - expectedTotal})`);
      mismatches++;
    }
  }

  // Buyer wallets
  const buyerWallets = await prisma.buyerWallet.findMany({
    select: { id: true, buyerId: true, balance: true },
  });

  for (const wallet of buyerWallets) {
    const txSum = await prisma.buyerWalletTransaction.aggregate({
      where: { walletId: wallet.id },
      _sum: { amount: true },
    });
    const expectedBalance = txSum._sum?.amount ?? 0;

    if (expectedBalance !== wallet.balance) {
      console.log(`  ❌ Buyer wallet ${wallet.id}: ledger=${expectedBalance} actual=${wallet.balance} (diff=${wallet.balance - expectedBalance})`);
      mismatches++;
    }
  }

  console.log(`\nVendor wallets checked: ${vendorWallets.length}`);
  console.log(`Buyer wallets checked: ${buyerWallets.length}`);
  console.log(`Mismatches: ${mismatches}`);
  console.log(mismatches === 0 ? "\n✅ PASS — All wallets reconcile" : "\n❌ FAIL — Mismatches found");

  await prisma.$disconnect();
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
