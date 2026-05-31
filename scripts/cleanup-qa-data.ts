/**
 * QA Data Cleanup Script
 * Safely removes all seeded QA test data.
 * 
 * Features:
 * - Dry-run mode by default
 * - Preserves DB integrity
 * - Only touches QA-prefixed data
 * - Comprehensive cleanup report
 * 
 * Usage:
 *   npm run cleanup:qa -- --dry-run (default)
 *   npm run cleanup:qa -- --confirm
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const PREFIX = process.env.QA_SEED_PREFIX || "SEED_QA_";
const DRY_RUN = !process.argv.includes("--confirm");

// ─── HELPERS ────────────────────────────────────────────────────────────────

function log(section: string, message: string) {
  console.log(`  [${section}] ${message}`);
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  QA DATA CLEANUP");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Prefix: ${PREFIX}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "CONFIRM - WILL DELETE"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (DRY_RUN) {
    console.log("  ℹ️  DRY RUN MODE - No data will be deleted");
    console.log("  ℹ️  Run with --confirm to actually delete\n");
  } else {
    console.log("  ⚠️  CONFIRM MODE - Data will be permanently deleted\n");
  }

  const report: any = {
    dryRun: DRY_RUN,
    timestamp: new Date().toISOString(),
    deleted: {},
  };

  // ─── FIND QA USERS ──────────────────────────────────────────────────────

  console.log("── FINDING QA DATA ──\n");

  const qaUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { startsWith: PREFIX.toLowerCase() } },
        { name: { startsWith: PREFIX } },
      ],
    },
    include: {
      vendor: true,
    },
  });

  log("USERS", `Found ${qaUsers.length} QA users`);

  const qaVendorIds = qaUsers.filter(u => u.vendor).map(u => u.vendor!.id);
  const qaUserIds = qaUsers.map(u => u.id);

  // ─── FIND QA PRODUCTS ───────────────────────────────────────────────────

  const qaProducts = await prisma.product.findMany({
    where: {
      OR: [
        { title: { startsWith: PREFIX } },
        { vendorId: { in: qaVendorIds } },
      ],
    },
  });

  log("PRODUCTS", `Found ${qaProducts.length} QA products`);

  const qaProductIds = qaProducts.map(p => p.id);

  // ─── FIND QA ORDERS ─────────────────────────────────────────────────────

  const qaOrders = await prisma.order.findMany({
    where: {
      OR: [
        { buyerId: { in: qaUserIds } },
        { vendorId: { in: qaVendorIds } },
      ],
    },
  });

  log("ORDERS", `Found ${qaOrders.length} QA orders`);

  const qaOrderIds = qaOrders.map(o => o.id);

  // ─── FIND QA COUPONS ────────────────────────────────────────────────────

  const qaCoupons = await prisma.promoCode.findMany({
    where: {
      code: { startsWith: PREFIX },
    },
  });

  log("COUPONS", `Found ${qaCoupons.length} QA coupons`);

  const qaCouponIds = qaCoupons.map(c => c.id);

  // ─── FIND QA REVIEWS ────────────────────────────────────────────────────

  const qaReviews = await prisma.review.findMany({
    where: {
      OR: [
        { buyerId: { in: qaUserIds } },
        { vendorId: { in: qaVendorIds } },
        { comment: { startsWith: PREFIX } },
      ],
    },
  });

  log("REVIEWS", `Found ${qaReviews.length} QA reviews`);

  // ─── FIND QA CARTS ──────────────────────────────────────────────────────

  const qaCarts = await prisma.cart.findMany({
    where: {
      buyerId: { in: qaUserIds },
    },
  });

  log("CARTS", `Found ${qaCarts.length} QA carts`);

  // ─── FIND QA WALLETS ────────────────────────────────────────────────────

  const qaVendorWallets = await prisma.wallet.findMany({
    where: {
      vendorId: { in: qaVendorIds },
    },
  });

  const qaBuyerWallets = await prisma.buyerWallet.findMany({
    where: {
      buyerId: { in: qaUserIds },
    },
  });

  log("WALLETS", `Found ${qaVendorWallets.length} vendor wallets, ${qaBuyerWallets.length} buyer wallets`);

  // ─── SUMMARY ────────────────────────────────────────────────────────────

  console.log("\n── CLEANUP SUMMARY ──\n");
  console.log(`  Users: ${qaUsers.length}`);
  console.log(`  Vendors: ${qaVendorIds.length}`);
  console.log(`  Products: ${qaProducts.length}`);
  console.log(`  Orders: ${qaOrders.length}`);
  console.log(`  Coupons: ${qaCoupons.length}`);
  console.log(`  Reviews: ${qaReviews.length}`);
  console.log(`  Carts: ${qaCarts.length}`);
  console.log(`  Vendor Wallets: ${qaVendorWallets.length}`);
  console.log(`  Buyer Wallets: ${qaBuyerWallets.length}\n`);

  if (DRY_RUN) {
    console.log("  ℹ️  DRY RUN - No changes made");
    console.log("  ℹ️  Run with --confirm to delete this data\n");
    return;
  }

  // ─── DELETE DATA ────────────────────────────────────────────────────────

  console.log("── DELETING DATA ──\n");

  // Delete in correct order to maintain referential integrity

  // 1. Reviews
  if (qaReviews.length > 0) {
    const result = await prisma.review.deleteMany({
      where: { id: { in: qaReviews.map(r => r.id) } },
    });
    log("DELETE", `Reviews: ${result.count}`);
    report.deleted.reviews = result.count;
  }

  // 2. Promo redemptions
  if (qaCouponIds.length > 0) {
    const redemptions = await prisma.promoRedemption.deleteMany({
      where: { promoCodeId: { in: qaCouponIds } },
    });
    log("DELETE", `Promo redemptions: ${redemptions.count}`);
    report.deleted.promoRedemptions = redemptions.count;
  }

  // 3. Promo codes
  if (qaCoupons.length > 0) {
    const result = await prisma.promoCode.deleteMany({
      where: { id: { in: qaCouponIds } },
    });
    log("DELETE", `Promo codes: ${result.count}`);
    report.deleted.promoCodes = result.count;
  }

  // 4. Cart items
  if (qaCarts.length > 0) {
    const cartItems = await prisma.cartItem.deleteMany({
      where: { cartId: { in: qaCarts.map(c => c.id) } },
    });
    log("DELETE", `Cart items: ${cartItems.count}`);
    report.deleted.cartItems = cartItems.count;
  }

  // 5. Carts
  if (qaCarts.length > 0) {
    const result = await prisma.cart.deleteMany({
      where: { id: { in: qaCarts.map(c => c.id) } },
    });
    log("DELETE", `Carts: ${result.count}`);
    report.deleted.carts = result.count;
  }

  // 6. Disputes
  if (qaOrderIds.length > 0) {
    const disputes = await prisma.dispute.deleteMany({
      where: { orderId: { in: qaOrderIds } },
    });
    log("DELETE", `Disputes: ${disputes.count}`);
    report.deleted.disputes = disputes.count;
  }

  // 7. Delivery OTPs
  if (qaOrderIds.length > 0) {
    const otps = await prisma.deliveryOtp.deleteMany({
      where: { orderId: { in: qaOrderIds } },
    });
    log("DELETE", `Delivery OTPs: ${otps.count}`);
    report.deleted.deliveryOtps = otps.count;
  }

  // 8. Paystack transactions
  if (qaOrderIds.length > 0) {
    const paystack = await prisma.paystackTransaction.deleteMany({
      where: { orderId: { in: qaOrderIds } },
    });
    log("DELETE", `Paystack transactions: ${paystack.count}`);
    report.deleted.paystackTransactions = paystack.count;
  }

  // 9. Wallet transactions
  if (qaVendorIds.length > 0) {
    const vendorTxs = await prisma.walletTransaction.deleteMany({
      where: { vendorId: { in: qaVendorIds } },
    });
    log("DELETE", `Vendor wallet transactions: ${vendorTxs.count}`);
    report.deleted.vendorWalletTransactions = vendorTxs.count;
  }

  if (qaUserIds.length > 0) {
    const buyerTxs = await prisma.buyerWalletTransaction.deleteMany({
      where: { buyerId: { in: qaUserIds } },
    });
    log("DELETE", `Buyer wallet transactions: ${buyerTxs.count}`);
    report.deleted.buyerWalletTransactions = buyerTxs.count;
  }

  // 10. Payments
  if (qaOrderIds.length > 0) {
    const payments = await prisma.payment.deleteMany({
      where: { orderId: { in: qaOrderIds } },
    });
    log("DELETE", `Payments: ${payments.count}`);
    report.deleted.payments = payments.count;
  }

  // 11. Order items
  if (qaOrderIds.length > 0) {
    const orderItems = await prisma.orderItem.deleteMany({
      where: { orderId: { in: qaOrderIds } },
    });
    log("DELETE", `Order items: ${orderItems.count}`);
    report.deleted.orderItems = orderItems.count;
  }

  // 12. Orders
  if (qaOrders.length > 0) {
    const result = await prisma.order.deleteMany({
      where: { id: { in: qaOrderIds } },
    });
    log("DELETE", `Orders: ${result.count}`);
    report.deleted.orders = result.count;
  }

  // 13. Notifications
  if (qaUserIds.length > 0) {
    const notifications = await prisma.notification.deleteMany({
      where: { userId: { in: qaUserIds } },
    });
    log("DELETE", `Notifications: ${notifications.count}`);
    report.deleted.notifications = notifications.count;
  }

  // 14. Messages & Conversations
  if (qaUserIds.length > 0) {
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { participantA: { in: qaUserIds } },
          { participantB: { in: qaUserIds } },
        ],
      },
    });
    
    if (conversations.length > 0) {
      const messages = await prisma.message.deleteMany({
        where: { conversationId: { in: conversations.map(c => c.id) } },
      });
      log("DELETE", `Messages: ${messages.count}`);
      report.deleted.messages = messages.count;
      
      const convResult = await prisma.conversation.deleteMany({
        where: { id: { in: conversations.map(c => c.id) } },
      });
      log("DELETE", `Conversations: ${convResult.count}`);
      report.deleted.conversations = convResult.count;
    }
  }

  // 15. Deactivate products (don't delete to preserve order history)
  if (qaProducts.length > 0) {
    const result = await prisma.product.updateMany({
      where: { id: { in: qaProductIds } },
      data: { isActive: false },
    });
    log("DEACTIVATE", `Products: ${result.count}`);
    report.deleted.productsDeactivated = result.count;
  }

  // 16. Delivery zones
  if (qaVendorIds.length > 0) {
    const zones = await prisma.deliveryZone.deleteMany({
      where: { vendorId: { in: qaVendorIds } },
    });
    log("DELETE", `Delivery zones: ${zones.count}`);
    report.deleted.deliveryZones = zones.count;
  }

  // 17. Vendor bank accounts
  if (qaVendorIds.length > 0) {
    const banks = await prisma.vendorBankAccount.deleteMany({
      where: { vendorId: { in: qaVendorIds } },
    });
    log("DELETE", `Vendor bank accounts: ${banks.count}`);
    report.deleted.vendorBankAccounts = banks.count;
  }

  // 18. Payout methods & requests
  if (qaVendorIds.length > 0) {
    const payoutRequests = await prisma.payoutRequest.deleteMany({
      where: { vendorId: { in: qaVendorIds } },
    });
    log("DELETE", `Payout requests: ${payoutRequests.count}`);
    report.deleted.payoutRequests = payoutRequests.count;
    
    const payoutMethods = await prisma.payoutMethod.deleteMany({
      where: { vendorId: { in: qaVendorIds } },
    });
    log("DELETE", `Payout methods: ${payoutMethods.count}`);
    report.deleted.payoutMethods = payoutMethods.count;
  }

  // 19. Wallets
  if (qaVendorWallets.length > 0) {
    const result = await prisma.wallet.deleteMany({
      where: { id: { in: qaVendorWallets.map(w => w.id) } },
    });
    log("DELETE", `Vendor wallets: ${result.count}`);
    report.deleted.vendorWallets = result.count;
  }

  if (qaBuyerWallets.length > 0) {
    const result = await prisma.buyerWallet.deleteMany({
      where: { id: { in: qaBuyerWallets.map(w => w.id) } },
    });
    log("DELETE", `Buyer wallets: ${result.count}`);
    report.deleted.buyerWallets = result.count;
  }

  // 20. Vendors (cascade will handle remaining relations)
  if (qaVendorIds.length > 0) {
    const result = await prisma.vendor.deleteMany({
      where: { id: { in: qaVendorIds } },
    });
    log("DELETE", `Vendors: ${result.count}`);
    report.deleted.vendors = result.count;
  }

  // 21. Users (cascade will handle remaining relations)
  if (qaUsers.length > 0) {
    const result = await prisma.user.deleteMany({
      where: { id: { in: qaUserIds } },
    });
    log("DELETE", `Users: ${result.count}`);
    report.deleted.users = result.count;
  }

  // ─── SAVE REPORT ────────────────────────────────────────────────────────

  console.log("\n── SAVING REPORT ──\n");

  const fs = await import("fs/promises");
  await fs.writeFile("QA_CLEANUP_REPORT.json", JSON.stringify(report, null, 2));
  log("SAVE", "Report saved to QA_CLEANUP_REPORT.json");

  // ─── FINAL SUMMARY ──────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  CLEANUP COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Total items deleted: ${Object.values(report.deleted).reduce((a: any, b: any) => a + b, 0)}`);
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  ✅ Report: QA_CLEANUP_REPORT.json\n`);
}

main()
  .catch((e) => {
    console.error("FATAL ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
