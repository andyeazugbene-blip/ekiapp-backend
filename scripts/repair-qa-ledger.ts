/**
 * QA Ledger Repair Script
 * Repairs wallet ledger rows and balances for QA-prefixed seed data only.
 *
 * Usage:
 *   npm run repair:qa-ledger
 *   npm run repair:qa-ledger -- --apply
 */
import {
  BuyerWalletTxType,
  PaymentStatus,
  PrismaClient,
  WalletTransactionType,
} from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

const PREFIX = process.env.QA_SEED_PREFIX || "SEED_QA_";
const APPLY = process.argv.includes("--apply");

function log(section: string, message: string) {
  console.log(`  [${section}] ${message}`);
}

function computeVendorLedger(
  transactions: Array<{ type: WalletTransactionType; amount: number }>,
) {
  let pending = 0;
  let available = 0;

  for (const tx of transactions) {
    if (tx.type === WalletTransactionType.PAYMENT_PENDING_CREDIT) {
      pending += tx.amount;
      continue;
    }
    if (tx.type === WalletTransactionType.PENDING_TO_AVAILABLE) {
      pending -= tx.amount;
      available += tx.amount;
      continue;
    }
    if (tx.type === WalletTransactionType.PAYOUT_DEBIT) {
      available -= tx.amount;
      continue;
    }
    if (tx.type === WalletTransactionType.ADJUSTMENT_CREDIT) {
      available += tx.amount;
      continue;
    }
    if (tx.type === WalletTransactionType.ADJUSTMENT_DEBIT) {
      pending += tx.amount;
    }
  }

  return { pending, available };
}

function computeBuyerBalance(
  transactions: Array<{ type: BuyerWalletTxType; amount: number }>,
) {
  let balance = 0;

  for (const tx of transactions) {
    if (
      tx.type === BuyerWalletTxType.TOP_UP ||
      tx.type === BuyerWalletTxType.REFERRAL_BONUS ||
      tx.type === BuyerWalletTxType.REFUND_CREDIT
    ) {
      balance += tx.amount;
      continue;
    }
    if (
      tx.type === BuyerWalletTxType.ORDER_DEBIT ||
      tx.type === BuyerWalletTxType.WITHDRAWAL
    ) {
      balance -= tx.amount;
    }
  }

  return balance;
}

async function main() {
  console.log("=== QA LEDGER REPAIR ===");
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const qaUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { startsWith: PREFIX.toLowerCase() } },
        { name: { startsWith: PREFIX } },
      ],
    },
    include: { vendor: true },
  });

  const qaUserIds = qaUsers.map((user) => user.id);
  const qaVendorIds = qaUsers.flatMap((user) => (user.vendor ? [user.vendor.id] : []));

  let createdBuyerTransactions = 0;
  let createdVendorTransactions = 0;
  let updatedBuyerWallets = 0;
  let updatedVendorWallets = 0;

  const buyerWallets = await prisma.buyerWallet.findMany({
    where: { buyerId: { in: qaUserIds } },
  });

  for (const wallet of buyerWallets) {
    let transactions = await prisma.buyerWalletTransaction.findMany({
      where: { walletId: wallet.id },
      select: { id: true, type: true, amount: true, paymentIntentId: true },
      orderBy: { createdAt: "asc" },
    });

    if (transactions.length === 0 && wallet.balance > 0) {
      const seedPaymentIntentId = `qa_seed_wallet_${wallet.buyerId}`;
      log("BUYER", `Backfill top-up ledger for wallet ${wallet.id} (${wallet.balance})`);
      if (APPLY) {
        await prisma.buyerWalletTransaction.create({
          data: {
            walletId: wallet.id,
            buyerId: wallet.buyerId,
            type: BuyerWalletTxType.TOP_UP,
            amount: wallet.balance,
            currency: wallet.currency,
            description: `QA seed wallet balance backfill for ${wallet.buyerId}`,
            paymentIntentId: seedPaymentIntentId,
          },
        });
      }
      createdBuyerTransactions++;
      transactions = [
        ...transactions,
        {
          id: seedPaymentIntentId,
          type: BuyerWalletTxType.TOP_UP,
          amount: wallet.balance,
          paymentIntentId: seedPaymentIntentId,
        },
      ];
    }

    const expectedBalance = computeBuyerBalance(transactions);
    if (expectedBalance !== wallet.balance) {
      log("BUYER", `Align wallet ${wallet.id}: ${wallet.balance} -> ${expectedBalance}`);
      if (APPLY) {
        await prisma.buyerWallet.update({
          where: { id: wallet.id },
          data: { balance: expectedBalance },
        });
      }
      updatedBuyerWallets++;
    }
  }

  const vendorWallets = await prisma.wallet.findMany({
    where: { vendorId: { in: qaVendorIds } },
  });

  const paidStatuses = new Set([
    "PAID",
    "PROCESSING",
    "DELIVERED",
    "DISPUTED",
    "VENDOR_CONFIRMED",
    "DISPATCHED",
  ]);

  for (const wallet of vendorWallets) {
    const orders = await prisma.order.findMany({
      where: { vendorId: wallet.vendorId },
      include: {
        payment: {
          select: {
            id: true,
            status: true,
            vendorEarningsAmount: true,
            currency: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    let transactions = await prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      select: { id: true, type: true, amount: true, orderId: true, paymentId: true },
      orderBy: { createdAt: "asc" },
    });

    const hasTx = (type: WalletTransactionType, orderId: string, paymentId?: string | null) =>
      transactions.some(
        (tx) =>
          tx.type === type &&
          tx.orderId === orderId &&
          (paymentId === undefined || tx.paymentId === paymentId),
      );

    for (const order of orders) {
      if (!order.payment || order.payment.status !== PaymentStatus.SUCCEEDED || order.vendorEarnings <= 0) {
        continue;
      }

      const amount = order.payment.vendorEarningsAmount;
      const currency = order.payment.currency;

      if (
        (paidStatuses.has(order.status) || order.status === "COMPLETED" || order.status === "REFUNDED") &&
        !hasTx(WalletTransactionType.PAYMENT_PENDING_CREDIT, order.id, order.payment.id)
      ) {
        log("VENDOR", `Backfill pending credit for order ${order.orderNumber}`);
        if (APPLY) {
          const created = await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: wallet.vendorId,
              orderId: order.id,
              paymentId: order.payment.id,
              type: WalletTransactionType.PAYMENT_PENDING_CREDIT,
              amount,
              currency,
              description: `QA ledger repair pending credit for order ${order.id}`,
            },
          });
          transactions.push({
            id: created.id,
            type: created.type,
            amount: created.amount,
            orderId: created.orderId,
            paymentId: created.paymentId,
          });
        } else {
          transactions.push({
            id: `preview-credit-${order.id}`,
            type: WalletTransactionType.PAYMENT_PENDING_CREDIT,
            amount,
            orderId: order.id,
            paymentId: order.payment.id,
          });
        }
        createdVendorTransactions++;
      }

      if (
        order.status === "COMPLETED" &&
        !hasTx(WalletTransactionType.PENDING_TO_AVAILABLE, order.id, order.payment.id)
      ) {
        log("VENDOR", `Backfill release entry for order ${order.orderNumber}`);
        if (APPLY) {
          const created = await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: wallet.vendorId,
              orderId: order.id,
              paymentId: order.payment.id,
              type: WalletTransactionType.PENDING_TO_AVAILABLE,
              amount,
              currency,
              description: `QA ledger repair release for order ${order.id}`,
            },
          });
          transactions.push({
            id: created.id,
            type: created.type,
            amount: created.amount,
            orderId: created.orderId,
            paymentId: created.paymentId,
          });
        } else {
          transactions.push({
            id: `preview-release-${order.id}`,
            type: WalletTransactionType.PENDING_TO_AVAILABLE,
            amount,
            orderId: order.id,
            paymentId: order.payment.id,
          });
        }
        createdVendorTransactions++;
      }

      if (
        order.status === "REFUNDED" &&
        !hasTx(WalletTransactionType.ADJUSTMENT_DEBIT, order.id)
      ) {
        log("VENDOR", `Backfill refund reversal for order ${order.orderNumber}`);
        if (APPLY) {
          const created = await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: wallet.vendorId,
              orderId: order.id,
              type: WalletTransactionType.ADJUSTMENT_DEBIT,
              amount: -amount,
              currency,
              description: `QA ledger repair refund reversal for order ${order.id}`,
            },
          });
          transactions.push({
            id: created.id,
            type: created.type,
            amount: created.amount,
            orderId: created.orderId,
            paymentId: created.paymentId,
          });
        } else {
          transactions.push({
            id: `preview-refund-${order.id}`,
            type: WalletTransactionType.ADJUSTMENT_DEBIT,
            amount: -amount,
            orderId: order.id,
            paymentId: null,
          });
        }
        createdVendorTransactions++;
      }
    }

    const expected = computeVendorLedger(
      transactions.map((tx) => ({ type: tx.type, amount: tx.amount })),
    );

    if (
      expected.pending !== wallet.pendingBalance ||
      expected.available !== wallet.availableBalance
    ) {
      log(
        "VENDOR",
        `Align wallet ${wallet.id}: pending ${wallet.pendingBalance} -> ${expected.pending}, available ${wallet.availableBalance} -> ${expected.available}`,
      );
      if (APPLY) {
        await prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            pendingBalance: expected.pending,
            availableBalance: expected.available,
          },
        });
      }
      updatedVendorWallets++;
    }
  }

  const report = {
    prefix: PREFIX,
    apply: APPLY,
    qaUsers: qaUsers.length,
    qaVendors: qaVendorIds.length,
    createdBuyerTransactions,
    createdVendorTransactions,
    updatedBuyerWallets,
    updatedVendorWallets,
    timestamp: new Date().toISOString(),
  };

  const fs = await import("fs/promises");
  await fs.writeFile("QA_LEDGER_REPAIR_REPORT.json", JSON.stringify(report, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log(`Buyer transactions created: ${createdBuyerTransactions}`);
  console.log(`Vendor transactions created: ${createdVendorTransactions}`);
  console.log(`Buyer wallets aligned: ${updatedBuyerWallets}`);
  console.log(`Vendor wallets aligned: ${updatedVendorWallets}`);
  console.log(`Report: QA_LEDGER_REPAIR_REPORT.json`);
  console.log(APPLY ? "\nAPPLY complete" : "\nDRY RUN complete");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("FATAL:", error);
  await prisma.$disconnect();
  process.exit(1);
});
