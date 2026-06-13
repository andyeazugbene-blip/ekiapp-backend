/**
 * COMPLETE DB RESET + SEED
 * Run: npx tsx scripts/clean-seed.ts
 * WARNING: DELETES ALL DATA!
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const PASSWORD = "Abdou22314";

async function main() {
  console.log("🚨 DELETING ALL DATA...");

  // Delete in FK-safe order
  const tables = [
    "DeliveryOtp", "PaystackTransaction", "Dispute", "Shipment",
    "OrderItem", "WalletTransaction", "Payment", "Checkout", "Order",
    "CartItem", "Cart", "Product", "PromoRedemption", "PromoCode",
    "PayoutRequest", "PayoutMethod", "VendorBankAccount", "VerificationDocument",
    "VendorSubscription", "Wallet", "Vendor",
    "Review", "Message", "Conversation",
    "Notification", "PushToken",
    "BuyerWalletTransaction", "BuyerWallet",
    "Reward", "UserReward",
    "GiftCard", "PurchasedGiftCard",
    "Referral",
    "BuyerAddress", "EmailOtp",
    "UploadAsset", "SmsDelivery",
    "WebhookEvent", "AuditLog",
    "DeliveryMethod", "DeliveryZone",
    "PasswordResetToken", "EmailVerificationToken",
    "AdminTwoFactor", "AdminRoleAssignment", "AdminRole",
    "User",
  ];

  for (const t of tables) {
    try { await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`); }
    catch (e) { /* table might not exist */ }
  }
  console.log("✅ All data deleted");

  const hash = await bcrypt.hash(PASSWORD, 10);

  // ─── 1. Create vendor@eki.app (dual-role) ──────────────────────────
  const vendorUser = await prisma.user.create({
    data: {
      email: "vendor@eki.app",
      name: "Queen African Foods",
      password: hash,
      phone: "+447700900111",
      country: "United Kingdom",
      role: "VENDOR",
      emailVerifiedAt: new Date(),
      referralCode: "QUEENAFRO10",
      trustScore: 85,
    },
  });

  const vendor = await prisma.vendor.create({
    data: {
      userId: vendorUser.id,
      storeName: "Queen African Foods",
      storeSlug: "queen-african-foods",
      description: "Premium African foodstuff sourced directly from trusted suppliers.",
      contactEmail: "vendor@eki.app",
      contactPhone: "+447700900111",
      country: "United Kingdom",
      city: "London",
      currency: "EUR",
      verificationStatus: "VERIFIED",
    },
  });

  await prisma.wallet.create({
    data: { vendorId: vendor.id, currency: "EUR", pendingBalance: 0, availableBalance: 0 },
  });

  // ─── 2. Create buyer@eki.app ──────────────────────────────────────
  const buyerUser = await prisma.user.create({
    data: {
      email: "buyer@eki.app",
      name: "Amara Buyer",
      password: hash,
      phone: "+447700900222",
      country: "United Kingdom",
      role: "BUYER",
      emailVerifiedAt: new Date(),
      referralCode: "BUYERAMARA10",
      trustScore: 50,
    },
  });

  // Buyers wallet
  await prisma.buyerWallet.create({
    data: { buyerId: buyerUser.id, currency: "EUR", balance: 50000 }, // €500
  });

  // ─── 3. Create admin@eki.app ──────────────────────────────────────
  await prisma.user.create({
    data: {
      email: "admin@eki.app",
      name: "Admin",
      password: hash,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
    },
  });

  // ─── 4. Delivery Zones ────────────────────────────────────────────
  // Canada
  const canadaZone = await prisma.deliveryZone.create({
    data: {
      name: "Canada", country: "Canada", baseFeeAmount: 1500, feePerKgAmount: 500,
      currency: "EUR", isActive: true,
    },
  });
  await prisma.deliveryMethod.create({
    data: { deliveryZoneId: canadaZone.id, label: "Standard", priceAmount: 1500, minDays: 5, maxDays: 10, isActive: true },
  });
  await prisma.deliveryMethod.create({
    data: { deliveryZoneId: canadaZone.id, label: "Express", priceAmount: 3000, minDays: 2, maxDays: 4, isActive: true },
  });

  // USA
  const usaZone = await prisma.deliveryZone.create({
    data: {
      name: "United States", country: "United States", baseFeeAmount: 1200, feePerKgAmount: 400,
      currency: "EUR", isActive: true,
    },
  });
  await prisma.deliveryMethod.create({
    data: { deliveryZoneId: usaZone.id, label: "Standard", priceAmount: 1200, minDays: 4, maxDays: 8, isActive: true },
  });

  // UK
  const ukZone = await prisma.deliveryZone.create({
    data: {
      name: "United Kingdom", country: "United Kingdom", baseFeeAmount: 500, feePerKgAmount: 200,
      currency: "EUR", isActive: true,
    },
  });
  await prisma.deliveryMethod.create({
    data: { deliveryZoneId: ukZone.id, label: "Standard", priceAmount: 500, minDays: 2, maxDays: 5, isActive: true },
  });

  // ─── 5. Products ─────────────────────────────────────────────────
  const product1 = await prisma.product.create({
    data: {
      vendorId: vendor.id,
      title: "Dried Fish Pack (500g)",
      description: "Cleaned dried fish pack ideal for soups and stews. Premium quality.",
      priceInCents: 5500,
      currency: "EUR",
      stock: 50,
      weightGrams: 500,
      isActive: true,
      category: "Protein",
    },
  });

  const product2 = await prisma.product.create({
    data: {
      vendorId: vendor.id,
      title: "Egusi Ground (1kg)",
      description: "Premium ground egusi melon seeds for authentic Nigerian soups.",
      priceInCents: 850,
      currency: "EUR",
      stock: 100,
      weightGrams: 1000,
      isActive: true,
      category: "Soup Ingredients",
    },
  });

  console.log("✅ Products created");

  // ─── 6. Promo Code ────────────────────────────────────────────────
  await prisma.promoCode.create({
    data: {
      vendorId: vendor.id,
      code: "AFRO10",
      type: "PERCENTAGE",
      value: 10,
      minOrderAmount: 2000,
      maxUses: 100,
      isActive: true,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  });

  console.log("✅ Promo code created");

  // ─── 7. Orders ────────────────────────────────────────────────────
  const order1Number = "EKI-DEMO-001";
  const order2Number = "EKI-DEMO-002";

  // Order 1
  const checkout1 = await prisma.checkout.create({
    data: {
      buyerId: buyerUser.id,
      totalAmount: 7200,
      currency: "EUR",
      status: "SUCCEEDED",
      processedAt: new Date(),
      metadata: { stripeCurrency: "eur", walletDeduction: 0 },
    },
  });

  const order1 = await prisma.order.create({
    data: {
      checkoutId: checkout1.id,
      buyerId: buyerUser.id,
      vendorId: vendor.id,
      orderNumber: order1Number,
      status: "PAID",
      subtotalAmount: 5500,
      deliveryFeeAmount: 1200,
      platformFeeAmount: 550,
      vendorEarnings: 4950,
      totalAmount: 7200,
      currency: "EUR",
      deliveryZoneId: usaZone.id,
      deliveryAddress: "123 Main St, New York, NY 10001",
    },
  });

  await prisma.orderItem.create({
    data: {
      orderId: order1.id,
      productId: product1.id,
      vendorId: vendor.id,
      quantity: 1,
      unitAmount: 5500,
      totalAmount: 5500,
      currency: "EUR",
      productTitle: "Dried Fish Pack (500g)",
    },
  });

  const payment1 = await prisma.payment.create({
    data: {
      orderId: order1.id,
      amount: 7200,
      platformFeeAmount: 550,
      vendorEarningsAmount: 4950,
      currency: "EUR",
      status: "SUCCEEDED",
      provider: "stripe",
      stripePaymentIntentId: "pi_demo_" + order1.id.slice(-8),
      processedAt: new Date(),
    },
  });

  // Credit vendor wallet for order 1
  const wallet1 = await prisma.wallet.findUnique({ where: { vendorId: vendor.id } });
  if (wallet1) {
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet1.id, vendorId: vendor.id,
        orderId: order1.id, paymentId: payment1.id,
        type: "PAYMENT_PENDING_CREDIT", amount: 4950,
        currency: "EUR",
        description: `Pending credit for order ${order1Number}`,
      },
    });
    await prisma.wallet.update({
      where: { id: wallet1.id },
      data: { pendingBalance: { increment: 4950 } },
    });
  }

  // Order 2
  const checkout2 = await prisma.checkout.create({
    data: {
      buyerId: buyerUser.id,
      totalAmount: 2050,
      currency: "EUR",
      status: "SUCCEEDED",
      processedAt: new Date(),
      metadata: { stripeCurrency: "eur", walletDeduction: 0 },
    },
  });

  const order2 = await prisma.order.create({
    data: {
      checkoutId: checkout2.id,
      buyerId: buyerUser.id,
      vendorId: vendor.id,
      orderNumber: order2Number,
      status: "DELIVERED",
      subtotalAmount: 850,
      deliveryFeeAmount: 500,
      platformFeeAmount: 85,
      vendorEarnings: 765,
      totalAmount: 1350,
      currency: "EUR",
      deliveryZoneId: ukZone.id,
      deliveryAddress: "10 Downing St, London, SW1A 2AA",
      deliveredAt: new Date(),
    },
  });

  await prisma.orderItem.create({
    data: {
      orderId: order2.id, productId: product2.id, vendorId: vendor.id,
      quantity: 1, unitAmount: 850, totalAmount: 850,
      currency: "EUR", productTitle: "Egusi Ground (1kg)",
    },
  });

  await prisma.payment.create({
    data: {
      orderId: order2.id,
      amount: 1350,
      platformFeeAmount: 85,
      vendorEarningsAmount: 765,
      currency: "EUR",
      status: "SUCCEEDED",
      provider: "stripe",
      stripePaymentIntentId: "pi_demo_" + order2.id.slice(-8),
      processedAt: new Date(),
    },
  });

  // Credit vendor wallet for order 2
  if (wallet1) {
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet1.id, vendorId: vendor.id,
        orderId: order2.id, paymentId: payment1.id,
        type: "PAYMENT_PENDING_CREDIT", amount: 765,
        currency: "EUR",
        description: `Pending credit for order ${order2Number}`,
      },
    });
    await prisma.wallet.update({
      where: { id: wallet1.id },
      data: { pendingBalance: { increment: 765 } },
    });
  }

  console.log("✅ Orders created");

  // ─── 8. Conversation & Messages ──────────────────────────────────
  const conversation = await prisma.conversation.create({
    data: {
      type: "BUYER_VENDOR",
      participantA: buyerUser.id,
      participantB: vendorUser.id,
      orderId: order1.id,
      lastMessageAt: new Date(),
    },
  });

  // Buyer message
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderId: buyerUser.id,
      text: "Hi! I just placed an order for the dried fish. When will it be shipped?",
      createdAt: new Date(Date.now() - 7200000),
    },
  });

  // Vendor response
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderId: vendorUser.id,
      text: "Hello! Thank you for your order. I'll dispatch it tomorrow and you'll receive tracking details.",
      createdAt: new Date(Date.now() - 3600000),
    },
  });

  console.log("✅ Messages created");

  // ─── 9. Send Offer from vendor to buyer ──────────────────────────
  // Using the conversation's "admin broadcast" as offer
  await prisma.notification.create({
    data: {
      userId: buyerUser.id,
      type: "ORDER_PAID",
      title: "Special Offer from Queen African Foods",
      body: "Buy 2 packs of Egusi, get 10% off! Use code EGUSI10",
      data: { senderId: vendorUser.id, type: "offer" },
    },
  });

  console.log("✅ Offer sent");

  // ─── 10. Notifications ────────────────────────────────────────────
  await prisma.notification.createMany({
    data: [
      { userId: buyerUser.id, type: "ORDER_PAID", title: "Order placed", body: `Order ${order1Number} has been placed successfully.` },
      { userId: buyerUser.id, type: "ORDER_PAID", title: "Payment confirmed", body: `Payment for order ${order1Number} confirmed.` },
      { userId: vendorUser.id, type: "BALANCE_CREDITED", title: "New order received", body: `Order ${order1Number} has been paid.` },
      { userId: vendorUser.id, type: "BALANCE_CREDITED", title: "Delivery confirmed", body: `Order ${order2Number} delivery confirmed by buyer.` },
    ],
  });

  // ─── 11. Rewards & Gift Cards ─────────────────────────────────────
  await prisma.reward.create({
    data: { name: "Welcome Gift", description: "Welcome bonus for new users", type: "WALLET_BONUS", value: 500, currency: "EUR", isActive: true, maxClaims: 1000 },
  });
  await prisma.reward.create({
    data: { name: "Referral Bonus", description: "Refer a friend and earn", type: "WALLET_BONUS", value: 1000, currency: "EUR", isActive: true, maxClaims: 500 },
  });

  // Gift cards
  const gc1 = await prisma.giftCard.create({
    data: { title: "€25 Gift Card", description: "Perfect gift for food lovers", priceAmount: 2500, currency: "EUR", isActive: true },
  });
  const gc2 = await prisma.giftCard.create({
    data: { title: "€50 Gift Card", description: "Give the gift of African cuisine", priceAmount: 5000, currency: "EUR", isActive: true },
  });

  // Buyer purchased gift card
  await prisma.purchasedGiftCard.create({
    data: { buyerId: buyerUser.id, giftCardId: gc1.id, recipientEmail: "friend@example.com", amount: 2500, currency: "EUR" },
  });

  console.log("✅ Rewards & gift cards created");

  // ─── SUMMARY ──────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ✅ DATABASE SEEDED SUCCESSFULLY");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Accounts:`);
  console.log(`    vendor@eki.app / ${PASSWORD}  → VENDOR (dual-role)`);
  console.log(`    buyer@eki.app / ${PASSWORD}   → BUYER`);
  console.log(`    admin@eki.app / ${PASSWORD}   → ADMIN`);
  console.log(`  Products: ${2}`);
  console.log(`  Delivery Zones: Canada, USA, UK + methods`);
  console.log(`  Orders: ${2} (1 PAID, 1 DELIVERED)`);
  console.log(`  Messages: ${2} (buyer + vendor reply)`);
  console.log(`  Promo Code: AFRO10 (10% off)`);
  console.log(`  Wallet pending: €${(4950+765)/100}`);
  console.log(`  Buyer wallet: €500`);
  console.log(`  Gift cards: €25 + €50 + 1 purchased`);
  console.log(`  Rewards: Welcome Gift + Referral Bonus`);
  console.log(`  Offer sent from vendor to buyer`);
  console.log(`  Notifications: ${4}`);
  console.log("═══════════════════════════════════════════════════\n");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
