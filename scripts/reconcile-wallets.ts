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
const PREFIX = process.env.QA_SEED_PREFIX || "SEED_QA_";
const QA_ONLY = process.argv.includes("--qa-only");

function sumAmounts(values: Array<number | null | undefined>): number {
  return values.reduce((sum, value) => sum + (value ?? 0), 0);
}

async function main() {
  console.log("=== WALLET LEDGER RECONCILIATION ===\n");
  console.log(`Scope: ${QA_ONLY ? `QA only (${PREFIX})` : "all wallets"}\n`);
  let mismatches = 0;

  let qaUserIds: string[] = [];
  let qaVendorIds: string[] = [];

  if (QA_ONLY) {
    const qaUsers = await prisma.user.findMany({
      where: {
        OR: [
          { email: { startsWith: PREFIX.toLowerCase() } },
          { name: { startsWith: PREFIX } },
        ],
      },
      include: { vendor: true },
    });

    qaUserIds = qaUsers.map((user) => user.id);
    qaVendorIds = qaUsers.flatMap((user) => (user.vendor ? [user.vendor.id] : []));
  }

  // Vendor wallets
  const vendorWallets = await prisma.wallet.findMany({
    where: QA_ONLY ? { vendorId: { in: qaVendorIds } } : undefined,
    select: { id: true, vendorId: true, pendingBalance: true, availableBalance: true },
  });

  for (const wallet of vendorWallets) {
    const transactions = await prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      select: { type: true, amount: true },
    });

    const expectedPending = sumAmounts(
      transactions.map((tx) => {
        if (tx.type === "PAYMENT_PENDING_CREDIT") return tx.amount;
        if (tx.type === "PENDING_TO_AVAILABLE") return -tx.amount;
        if (tx.type === "ADJUSTMENT_DEBIT") return tx.amount;
        return 0;
      }),
    );

    const expectedAvailable = sumAmounts(
      transactions.map((tx) => {
        if (tx.type === "PENDING_TO_AVAILABLE") return tx.amount;
        if (tx.type === "PAYOUT_DEBIT") return -tx.amount;
        if (tx.type === "ADJUSTMENT_CREDIT") return tx.amount;
        return 0;
      }),
    );

    if (expectedPending !== wallet.pendingBalance || expectedAvailable !== wallet.availableBalance) {
      console.log(
        `  ❌ Vendor wallet ${wallet.id}: pending ledger=${expectedPending} actual=${wallet.pendingBalance}, available ledger=${expectedAvailable} actual=${wallet.availableBalance}`,
      );
      mismatches++;
    }
  }

  // Buyer wallets
  const buyerWallets = await prisma.buyerWallet.findMany({
    where: QA_ONLY ? { buyerId: { in: qaUserIds } } : undefined,
    select: { id: true, buyerId: true, balance: true },
  });

  for (const wallet of buyerWallets) {
    const transactions = await prisma.buyerWalletTransaction.findMany({
      where: { walletId: wallet.id },
      select: { type: true, amount: true },
    });

    const expectedBalance = sumAmounts(
      transactions.map((tx) => {
        if (tx.type === "TOP_UP" || tx.type === "REFERRAL_BONUS" || tx.type === "REFUND_CREDIT") {
          return tx.amount;
        }
        if (tx.type === "ORDER_DEBIT" || tx.type === "WITHDRAWAL") {
          return -tx.amount;
        }
        return 0;
      }),
    );

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
