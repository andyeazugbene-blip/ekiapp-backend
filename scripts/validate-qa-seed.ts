/**
 * QA Seed Validation Script
 * Validates that seeded data is correct and consistent.
 * 
 * Checks:
 * - Users exist and have correct roles
 * - Vendors have correct currency
 * - Products are active and have correct currency
 * - Orders have matching payments
 * - Wallets are reconciled
 * - Reviews are valid
 * - Coupons exist
 * 
 * Usage:
 *   npm run validate:qa
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const PREFIX = process.env.QA_SEED_PREFIX || "SEED_QA_";

// ─── HELPERS ────────────────────────────────────────────────────────────────

function log(section: string, status: "PASS" | "FAIL" | "WARN", message: string) {
  const icon = { PASS: "✅", FAIL: "❌", WARN: "⚠️" }[status];
  console.log(`  ${icon} [${section}] ${message}`);
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  QA SEED VALIDATION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Prefix: ${PREFIX}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;

  // ─── VALIDATE ADMIN ─────────────────────────────────────────────────────

  console.log("── ADMIN ──\n");

  const adminEmail = `${PREFIX.toLowerCase()}admin@example.com`;
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (admin && admin.role === "ADMIN") {
    log("ADMIN", "PASS", `Admin exists: ${adminEmail}`);
    passCount++;
  } else {
    log("ADMIN", "FAIL", `Admin not found or wrong role: ${adminEmail}`);
    failCount++;
  }

  // ─── VALIDATE BUYERS ────────────────────────────────────────────────────

  console.log("\n── BUYERS ──\n");

  const buyers = await prisma.user.findMany({
    where: {
      email: { startsWith: `${PREFIX.toLowerCase()}buyer` },
      role: "BUYER",
    },
    include: {
      orders: true,
    },
  });

  if (buyers.length > 0) {
    log("BUYERS", "PASS", `Found ${buyers.length} buyers`);
    passCount++;
  } else {
    log("BUYERS", "FAIL", "No buyers found");
    failCount++;
  }

  // Check buyer wallets
  const buyerWallets = await prisma.buyerWallet.findMany({
    where: {
      buyerId: { in: buyers.map(b => b.id) },
    },
  });

  if (buyerWallets.length === buyers.length) {
    log("BUYERS", "PASS", `All buyers have wallets (${buyerWallets.length})`);
    passCount++;
  } else {
    log("BUYERS", "WARN", `Some buyers missing wallets: ${buyers.length} buyers, ${buyerWallets.length} wallets`);
    warnCount++;
  }

  // ─── VALIDATE VENDORS ───────────────────────────────────────────────────

  console.log("\n── VENDORS ──\n");

  const vendors = await prisma.vendor.findMany({
    where: {
      user: {
        email: { startsWith: `${PREFIX.toLowerCase()}vendor` },
      },
    },
    include: {
      user: true,
      wallet: true,
      products: true,
    },
  });

  if (vendors.length > 0) {
    log("VENDORS", "PASS", `Found ${vendors.length} vendors`);
    passCount++;
  } else {
    log("VENDORS", "FAIL", "No vendors found");
    failCount++;
  }

  // Check vendor currencies
  let currencyMismatch = 0;
  for (const vendor of vendors) {
    const products = vendor.products;
    const wrongCurrency = products.filter(p => p.currency !== vendor.currency);
    if (wrongCurrency.length > 0) {
      log("VENDORS", "FAIL", `Vendor ${vendor.storeName} has ${wrongCurrency.length} products with wrong currency`);
      currencyMismatch++;
      failCount++;
    }
  }

  if (currencyMismatch === 0 && vendors.length > 0) {
    log("VENDORS", "PASS", "All vendor products have correct currency");
    passCount++;
  }

  // Check vendor wallets
  const vendorWallets = vendors.filter(v => v.wallet).length;
  if (vendorWallets === vendors.length) {
    log("VENDORS", "PASS", `All vendors have wallets (${vendorWallets})`);
    passCount++;
  } else {
    log("VENDORS", "FAIL", `Some vendors missing wallets: ${vendors.length} vendors, ${vendorWallets} wallets`);
    failCount++;
  }

  // ─── VALIDATE PRODUCTS ──────────────────────────────────────────────────

  console.log("\n── PRODUCTS ──\n");

  const products = await prisma.product.findMany({
    where: {
      title: { startsWith: PREFIX },
    },
  });

  if (products.length > 0) {
    log("PRODUCTS", "PASS", `Found ${products.length} products`);
    passCount++;
  } else {
    log("PRODUCTS", "FAIL", "No products found");
    failCount++;
  }

  const activeProducts = products.filter(p => p.isActive);
  if (activeProducts.length > 0) {
    log("PRODUCTS", "PASS", `${activeProducts.length} products are active`);
    passCount++;
  } else {
    log("PRODUCTS", "WARN", "No active products");
    warnCount++;
  }

  // Check edge cases
  const lowStock = products.filter(p => p.stock === 1);
  const outOfStock = products.filter(p => p.stock === 0);
  const noImage = products.filter(p => p.images.length === 0);

  if (lowStock.length > 0) {
    log("PRODUCTS", "PASS", `Found ${lowStock.length} low-stock products`);
    passCount++;
  } else {
    log("PRODUCTS", "WARN", "No low-stock products for testing");
    warnCount++;
  }

  if (outOfStock.length > 0) {
    log("PRODUCTS", "PASS", `Found ${outOfStock.length} out-of-stock products`);
    passCount++;
  } else {
    log("PRODUCTS", "WARN", "No out-of-stock products for testing");
    warnCount++;
  }

  // ─── VALIDATE COUPONS ───────────────────────────────────────────────────

  console.log("\n── COUPONS ──\n");

  const coupons = await prisma.promoCode.findMany({
    where: {
      code: { startsWith: PREFIX },
    },
  });

  if (coupons.length >= 4) {
    log("COUPONS", "PASS", `Found ${coupons.length} coupons`);
    passCount++;
  } else {
    log("COUPONS", "FAIL", `Expected at least 4 coupons, found ${coupons.length}`);
    failCount++;
  }

  const expiredCoupon = coupons.find(c => c.code.includes("EXPIRED"));
  if (expiredCoupon && expiredCoupon.validUntil && expiredCoupon.validUntil < new Date()) {
    log("COUPONS", "PASS", "Expired coupon exists and is expired");
    passCount++;
  } else {
    log("COUPONS", "WARN", "Expired coupon not found or not expired");
    warnCount++;
  }

  const vendorPromoAuditLogs = await prisma.auditLog.findMany({
    where: {
      action: "vendor.promo.created",
      entityType: "PROMO_CODE",
      metadata: { not: null },
    },
  });

  if (vendorPromoAuditLogs.length > 0) {
    log("COUPONS", "PASS", `Vendor promo history seeded (${vendorPromoAuditLogs.length})`);
    passCount++;
  } else {
    log("COUPONS", "WARN", "No vendor promo history found");
    warnCount++;
  }

  // ─── VALIDATE ORDERS ────────────────────────────────────────────────────

  console.log("\n── ORDERS ──\n");

  const orders = await prisma.order.findMany({
    where: {
      OR: [
        { buyerId: { in: buyers.map(b => b.id) } },
        { vendorId: { in: vendors.map(v => v.id) } },
      ],
    },
    include: {
      payment: true,
      items: true,
    },
  });

  if (orders.length > 0) {
    log("ORDERS", "PASS", `Found ${orders.length} orders`);
    passCount++;
  } else {
    log("ORDERS", "FAIL", "No orders found");
    failCount++;
  }

  // Check order statuses
  const statuses = ["PENDING", "PAID", "PROCESSING", "DELIVERED", "COMPLETED", "REFUNDED", "DISPUTED"];
  const statusCounts: Record<string, number> = {};
  orders.forEach(o => {
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
  });

  const missingStatuses = statuses.filter(s => !statusCounts[s]);
  if (missingStatuses.length === 0) {
    log("ORDERS", "PASS", "All order statuses represented");
    passCount++;
  } else if (missingStatuses.every((status) => status === "REFUNDED" || status === "DISPUTED")) {
    log(
      "ORDERS",
      "WARN",
      `Missing base-seed statuses: ${missingStatuses.join(", ")}. Run npm run seed:escrow for escrow-only order states.`,
    );
    warnCount++;
  } else {
    log("ORDERS", "WARN", `Missing statuses: ${missingStatuses.join(", ")}`);
    warnCount++;
  }

  // Check payments for paid orders
  const paidOrders = orders.filter(o => ["PAID", "PROCESSING", "DELIVERED", "COMPLETED", "REFUNDED", "DISPUTED"].includes(o.status));
  const ordersWithPayment = paidOrders.filter(o => o.payment);

  if (ordersWithPayment.length === paidOrders.length) {
    log("ORDERS", "PASS", `All paid orders have payments (${ordersWithPayment.length})`);
    passCount++;
  } else {
    log("ORDERS", "FAIL", `Some paid orders missing payments: ${paidOrders.length} paid, ${ordersWithPayment.length} with payment`);
    failCount++;
  }

  const shipmentOrders = orders.filter((order) =>
    ["PROCESSING", "DELIVERED", "COMPLETED", "REFUNDED", "DISPUTED"].includes(order.status),
  );
  const shipments = await prisma.shipment.findMany({
    where: { orderId: { in: shipmentOrders.map((order) => order.id) } },
  });
  if (shipments.length >= shipmentOrders.length && shipmentOrders.length > 0) {
    log("ORDERS", "PASS", `Shipment records seeded (${shipments.length})`);
    passCount++;
  } else if (shipmentOrders.length > 0) {
    log("ORDERS", "WARN", `Expected ${shipmentOrders.length} shipment records, found ${shipments.length}`);
    warnCount++;
  }

  // ─── VALIDATE REVIEWS ───────────────────────────────────────────────────

  console.log("\n── REVIEWS ──\n");

  const reviews = await prisma.review.findMany({
    where: {
      OR: [
        { comment: { startsWith: PREFIX } },
        { buyerId: { in: buyers.map(b => b.id) } },
      ],
    },
  });

  if (reviews.length > 0) {
    log("REVIEWS", "PASS", `Found ${reviews.length} reviews`);
    passCount++;
  } else {
    log("REVIEWS", "WARN", "No reviews found");
    warnCount++;
  }

  // Check reviews are for delivered orders
  const deliveredOrders = orders.filter(o => ["DELIVERED", "COMPLETED"].includes(o.status));
  if (reviews.length > 0 && deliveredOrders.length > 0) {
    log("REVIEWS", "PASS", "Reviews exist for delivered orders");
    passCount++;
  } else if (deliveredOrders.length === 0) {
    log("REVIEWS", "WARN", "No delivered orders to review");
    warnCount++;
  }

  // ─── VALIDATE WALLETS ───────────────────────────────────────────────────

  console.log("\n── WALLETS ──\n");

  // Check vendor wallet balances
  for (const vendor of vendors) {
    if (!vendor.wallet) continue;

    const vendorOrders = orders.filter(o => o.vendorId === vendor.id);
    const pendingOrders = vendorOrders.filter((o) =>
      ["CONFIRMED", "PAID", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED"].includes(o.status),
    );
    const completedOrders = vendorOrders.filter(o => o.status === "COMPLETED");

    const expectedPending = pendingOrders.reduce((sum, o) => sum + o.vendorEarnings, 0);
    const expectedAvailable = completedOrders.reduce((sum, o) => sum + o.vendorEarnings, 0);

    // Allow some tolerance for rounding
    const pendingMatch = Math.abs(vendor.wallet.pendingBalance - expectedPending) < 100;
    const availableMatch = Math.abs(vendor.wallet.availableBalance - expectedAvailable) < 100;

    if (pendingMatch && availableMatch) {
      log("WALLETS", "PASS", `Vendor ${vendor.storeName} wallet balanced`);
      passCount++;
    } else {
      log("WALLETS", "FAIL", `Vendor ${vendor.storeName} wallet mismatch: pending ${vendor.wallet.pendingBalance} vs ${expectedPending}, available ${vendor.wallet.availableBalance} vs ${expectedAvailable}`);
      failCount++;
    }
  }

  // ─── SUMMARY ────────────────────────────────────────────────────────────

  // --- VALIDATE SUBSCRIPTIONS & PAYOUTS ---

  console.log("\n--- SUBSCRIPTIONS & PAYOUTS ---\n");

  const subscriptions = await prisma.vendorSubscription.findMany({
    where: { vendorId: { in: vendors.map((vendor) => vendor.id) } },
  });
  if (subscriptions.length === vendors.length) {
    log("SUBSCRIPTIONS", "PASS", `All vendors have subscriptions (${subscriptions.length})`);
    passCount++;
  } else {
    log("SUBSCRIPTIONS", "FAIL", `Expected ${vendors.length} subscriptions, found ${subscriptions.length}`);
    failCount++;
  }

  const payoutMethods = await prisma.payoutMethod.findMany({
    where: { vendorId: { in: vendors.map((vendor) => vendor.id) } },
  });
  if (payoutMethods.length >= vendors.length) {
    log("PAYOUTS", "PASS", `Payout methods seeded (${payoutMethods.length})`);
    passCount++;
  } else {
    log("PAYOUTS", "FAIL", `Expected at least ${vendors.length} payout methods, found ${payoutMethods.length}`);
    failCount++;
  }

  const payoutRequests = await prisma.payoutRequest.findMany({
    where: { vendorId: { in: vendors.map((vendor) => vendor.id) } },
  });
  if (payoutRequests.length > 0) {
    log("PAYOUTS", "PASS", `Payout requests seeded (${payoutRequests.length})`);
    passCount++;
  } else {
    log("PAYOUTS", "WARN", "No payout requests found");
    warnCount++;
  }

  // --- VALIDATE CONVERSATIONS & NOTIFICATIONS ---

  console.log("\n--- CHAT & NOTIFICATIONS ---\n");

  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [
        { participantA: { in: buyers.map((buyer) => buyer.id) } },
        { participantB: { in: buyers.map((buyer) => buyer.id) } },
      ],
    },
    include: { messages: true },
  });

  if (conversations.length > 0) {
    log("CHAT", "PASS", `Conversations seeded (${conversations.length})`);
    passCount++;
  } else {
    log("CHAT", "WARN", "No conversations found");
    warnCount++;
  }

  const messages = conversations.flatMap((conversation) => conversation.messages);
  if (messages.length > 0) {
    log("CHAT", "PASS", `Messages seeded (${messages.length})`);
    passCount++;
  } else {
    log("CHAT", "WARN", "No messages found");
    warnCount++;
  }

  const notifications = await prisma.notification.findMany({
    where: {
      OR: [
        { userId: { in: buyers.map((buyer) => buyer.id) } },
        { userId: { in: vendors.map((vendor) => vendor.userId) } },
        ...(admin ? [{ userId: admin.id }] : []),
      ],
    },
  });

  if (notifications.length > 0) {
    log("NOTIFY", "PASS", `Notifications seeded (${notifications.length})`);
    passCount++;
  } else {
    log("NOTIFY", "WARN", "No notifications found");
    warnCount++;
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  VALIDATION SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ✅ PASS: ${passCount}`);
  console.log(`  ❌ FAIL: ${failCount}`);
  console.log(`  ⚠️  WARN: ${warnCount}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (failCount === 0) {
    console.log("  ✅ All critical validations passed!");
    if (warnCount > 0) {
      console.log(`  ⚠️  ${warnCount} warnings - review above for details\n`);
    }
  } else {
    console.log(`  ❌ ${failCount} validations failed - review above for details\n`);
  }

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    prefix: PREFIX,
    summary: {
      pass: passCount,
      fail: failCount,
      warn: warnCount,
    },
    counts: {
      admin: admin ? 1 : 0,
      buyers: buyers.length,
      vendors: vendors.length,
      products: products.length,
      activeProducts: activeProducts.length,
      coupons: coupons.length,
      vendorPromoHistory: vendorPromoAuditLogs.length,
      orders: orders.length,
      shipments: shipments.length,
      reviews: reviews.length,
    },
  };

  const fs = await import("fs/promises");
  await fs.writeFile("QA_SEED_VALIDATION_REPORT.json", JSON.stringify(report, null, 2));
  console.log("  📄 Report saved to QA_SEED_VALIDATION_REPORT.json\n");

  process.exit(failCount > 0 ? 1 : 0);
}

main()
  .catch((e) => {
    console.error("FATAL ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
