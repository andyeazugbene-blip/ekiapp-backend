import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export async function adminResetUsers(_req: Request, res: Response): Promise<void> {
  const start = Date.now();
  const hash = await bcrypt.hash("Abdou22314", 10);
  const emails = ["vendor@eki.app", "buyer@eki.app", "admin@eki.app"];

  // Reset session replication to bypass FK checks
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } });
  for (const u of users) {
    const v = await prisma.vendor.findUnique({ where: { userId: u.id } });
    if (v) {
      await prisma.walletTransaction.deleteMany({ where: { vendorId: v.id } });
      await prisma.wallet.deleteMany({ where: { vendorId: v.id } });
      const vids = (await prisma.order.findMany({ where: { vendorId: v.id }, select: { id: true } })).map(x => x.id);
      if (vids.length > 0) {
        await prisma.walletTransaction.deleteMany({ where: { payment: { orderId: { in: vids } } } });
        await prisma.payment.deleteMany({ where: { orderId: { in: vids } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: vids } } });
        await prisma.deliveryOtp.deleteMany({ where: { orderId: { in: vids } } });
        await prisma.paystackTransaction.deleteMany({ where: { orderId: { in: vids } } });
        await prisma.dispute.deleteMany({ where: { orderId: { in: vids } } });
        await prisma.order.deleteMany({ where: { id: { in: vids } } });
      }
      await prisma.cartItem.deleteMany({ where: { product: { vendorId: v.id } } });
      await prisma.product.deleteMany({ where: { vendorId: v.id } });
      await prisma.payoutRequest.deleteMany({ where: { vendorId: v.id } });
      await prisma.payoutMethod.deleteMany({ where: { vendorId: v.id } });
      await prisma.vendorBankAccount.deleteMany({ where: { vendorId: v.id } });
      await prisma.verificationDocument.deleteMany({ where: { vendorId: v.id } });
      await prisma.vendorSubscription.deleteMany({ where: { vendorId: v.id } });
      await prisma.vendor.deleteMany({ where: { id: v.id } });
    }
    await prisma.cartItem.deleteMany({ where: { cart: { buyerId: u.id } } });
    await prisma.cart.deleteMany({ where: { buyerId: u.id } });
    await prisma.notification.deleteMany({ where: { userId: u.id } });
    await prisma.pushToken.deleteMany({ where: { userId: u.id } });
    await prisma.review.deleteMany({ where: { buyerId: u.id } });
    await prisma.buyerWalletTransaction.deleteMany({ where: { buyerId: u.id } });
    await prisma.buyerWallet.deleteMany({ where: { buyerId: u.id } });
    await prisma.purchasedGiftCard.deleteMany({ where: { buyerId: u.id } });
    const boids = (await prisma.order.findMany({ where: { buyerId: u.id }, select: { id: true } })).map(x => x.id);
    if (boids.length > 0) {
      await prisma.walletTransaction.deleteMany({ where: { payment: { orderId: { in: boids } } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: boids } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: boids } } });
      await prisma.order.deleteMany({ where: { id: { in: boids } } });
      await prisma.checkout.deleteMany({ where: { id: { in: (await prisma.checkout.findMany({ where: { buyerId: u.id }, select: { id: true } })).map(x => x.id) } } });
    }
    await prisma.user.deleteMany({ where: { id: u.id } });
  }

  logger.info("All data deleted");

  // ─── Users ──────────────────────────────────────────────────
  const vu = await prisma.user.create({ data: { email: "vendor@eki.app", name: "Queen African Foods", password: hash, phone: "+447700900111", country: "United Kingdom", role: "VENDOR", emailVerifiedAt: new Date(), referralCode: "QUEENAFRO10", trustScore: 85 } });
  const bu = await prisma.user.create({ data: { email: "buyer@eki.app", name: "Amara Buyer", password: hash, phone: "+447700900222", country: "United Kingdom", role: "BUYER", emailVerifiedAt: new Date(), referralCode: "BUYERAMARA10", trustScore: 50 } });
  await prisma.user.create({ data: { email: "admin@eki.app", name: "Admin", password: hash, role: "ADMIN", emailVerifiedAt: new Date() } });

  // ─── Vendor ─────────────────────────────────────────────────
  const v = await prisma.vendor.create({ data: { userId: vu.id, storeName: "Queen African Foods", storeSlug: "queen-african-foods", description: "Premium African foodstuff sourced directly from trusted suppliers.", contactEmail: "vendor@eki.app", contactPhone: "+447700900111", country: "United Kingdom", city: "London", currency: "EUR", verificationStatus: "VERIFIED" } });
  const w = await prisma.wallet.create({ data: { vendorId: v.id, currency: "EUR", pendingBalance: 0, availableBalance: 0 } });
  await prisma.buyerWallet.create({ data: { buyerId: bu.id, currency: "EUR", balance: 50000 } });

  // ─── Delivery Zones ──────────────────────────────────────────
  const ca = await prisma.deliveryZone.create({ data: { name: "Canada", country: "Canada", baseFeeAmount: 1500, feePerKgAmount: 500, currency: "EUR", isActive: true } });
  await prisma.deliveryMethod.create({ data: { deliveryZoneId: ca.id, label: "Standard", priceAmount: 1500, minDays: 5, maxDays: 10, isActive: true } });
  await prisma.deliveryMethod.create({ data: { deliveryZoneId: ca.id, label: "Express", priceAmount: 3000, minDays: 2, maxDays: 4, isActive: true } });
  const us = await prisma.deliveryZone.create({ data: { name: "United States", country: "United States", baseFeeAmount: 1200, feePerKgAmount: 400, currency: "EUR", isActive: true } });
  await prisma.deliveryMethod.create({ data: { deliveryZoneId: us.id, label: "Standard", priceAmount: 1200, minDays: 4, maxDays: 8, isActive: true } });
  const uk = await prisma.deliveryZone.create({ data: { name: "United Kingdom", country: "United Kingdom", baseFeeAmount: 500, feePerKgAmount: 200, currency: "EUR", isActive: true } });
  await prisma.deliveryMethod.create({ data: { deliveryZoneId: uk.id, label: "Standard", priceAmount: 500, minDays: 2, maxDays: 5, isActive: true } });

  // ─── Products ────────────────────────────────────────────────
  const p1 = await prisma.product.create({ data: { vendorId: v.id, title: "Dried Fish Pack (500g)", description: "Cleaned dried fish pack ideal for soups and stews. Premium quality.", priceInCents: 5500, currency: "EUR", stock: 50, weightGrams: 500, isActive: true, category: "Protein" } });
  const p2 = await prisma.product.create({ data: { vendorId: v.id, title: "Egusi Ground (1kg)", description: "Premium ground egusi melon seeds for authentic Nigerian soups.", priceInCents: 850, currency: "EUR", stock: 100, weightGrams: 1000, isActive: true, category: "Soup Ingredients" } });

  // ─── Promo Code ──────────────────────────────────────────────
  await prisma.promoCode.create({ data: { vendorId: v.id, code: "AFRO10", type: "PERCENTAGE", value: 10, minOrderAmount: 2000, maxUses: 100, isActive: true, validFrom: new Date(), validUntil: new Date(Date.now() + 90 * 86400000) } });

  // ─── Order 1 (PAID - USA) ───────────────────────────────────
  const co1 = await prisma.checkout.create({ data: { buyerId: bu.id, totalAmount: 7200, currency: "EUR", status: "SUCCEEDED", processedAt: new Date(), metadata: { stripeCurrency: "eur" } } });
  const o1 = await prisma.order.create({ data: { checkoutId: co1.id, buyerId: bu.id, vendorId: v.id, orderNumber: "EKI-DEMO-001", status: "PAID", subtotalAmount: 5500, deliveryFeeAmount: 1200, platformFeeAmount: 550, vendorEarnings: 4950, totalAmount: 7200, currency: "EUR", deliveryZoneId: us.id, deliveryAddress: "123 Main St, New York, NY 10001" } });
  await prisma.orderItem.create({ data: { orderId: o1.id, productId: p1.id, vendorId: v.id, quantity: 1, unitAmount: 5500, totalAmount: 5500, currency: "EUR", productTitle: "Dried Fish Pack (500g)" } });
  const pm1 = await prisma.payment.create({ data: { orderId: o1.id, amount: 7200, platformFeeAmount: 550, vendorEarningsAmount: 4950, currency: "EUR", status: "SUCCEEDED", provider: "stripe", stripePaymentIntentId: "pi_demo_001", processedAt: new Date() } });
  await prisma.walletTransaction.create({ data: { walletId: w.id, vendorId: v.id, orderId: o1.id, paymentId: pm1.id, type: "PAYMENT_PENDING_CREDIT", amount: 4950, currency: "EUR", description: "Pending credit for order EKI-DEMO-001" } });
  await prisma.wallet.update({ where: { id: w.id }, data: { pendingBalance: { increment: 4950 } } });

  // ─── Order 2 (DELIVERED - UK) ──────────────────────────────
  const co2 = await prisma.checkout.create({ data: { buyerId: bu.id, totalAmount: 1350, currency: "EUR", status: "SUCCEEDED", processedAt: new Date(), metadata: { stripeCurrency: "eur" } } });
  const o2 = await prisma.order.create({ data: { checkoutId: co2.id, buyerId: bu.id, vendorId: v.id, orderNumber: "EKI-DEMO-002", status: "DELIVERED", subtotalAmount: 850, deliveryFeeAmount: 500, platformFeeAmount: 85, vendorEarnings: 765, totalAmount: 1350, currency: "EUR", deliveryZoneId: uk.id, deliveryAddress: "10 Downing St, London, SW1A 2AA", deliveredAt: new Date() } });
  await prisma.orderItem.create({ data: { orderId: o2.id, productId: p2.id, vendorId: v.id, quantity: 1, unitAmount: 850, totalAmount: 850, currency: "EUR", productTitle: "Egusi Ground (1kg)" } });
  const pm2 = await prisma.payment.create({ data: { orderId: o2.id, amount: 1350, platformFeeAmount: 85, vendorEarningsAmount: 765, currency: "EUR", status: "SUCCEEDED", provider: "stripe", stripePaymentIntentId: "pi_demo_002", processedAt: new Date() } });
  await prisma.walletTransaction.create({ data: { walletId: w.id, vendorId: v.id, orderId: o2.id, paymentId: pm2.id, type: "PAYMENT_PENDING_CREDIT", amount: 765, currency: "EUR", description: "Pending credit for order EKI-DEMO-002" } });
  await prisma.wallet.update({ where: { id: w.id }, data: { pendingBalance: { increment: 765 } } });

  // ─── Conversation + Messages ────────────────────────────────
  const conv = await prisma.conversation.create({ data: { type: "BUYER_VENDOR", participantA: bu.id, participantB: vu.id, orderId: o1.id, lastMessageAt: new Date() } });
  await prisma.message.create({ data: { conversationId: conv.id, senderId: bu.id, text: "Hi! I just placed an order for the dried fish. When will it be shipped?" } });
  await prisma.message.create({ data: { conversationId: conv.id, senderId: vu.id, text: "Hello! Thank you for your order. I'll dispatch it tomorrow and you'll receive tracking details." } });

  // ─── Notifications ──────────────────────────────────────────
  await prisma.notification.createMany({ data: [
    { userId: bu.id, type: "ORDER_PAID", title: "Order placed", body: "Order EKI-DEMO-001 has been placed successfully." },
    { userId: bu.id, type: "ORDER_PAID", title: "Payment confirmed", body: "Payment confirmed." },
    { userId: vu.id, type: "BALANCE_CREDITED", title: "New order received", body: "Order EKI-DEMO-001 has been paid." },
    { userId: vu.id, type: "BALANCE_CREDITED", title: "Delivery confirmed", body: "Order EKI-DEMO-002 delivery confirmed." },
    { userId: bu.id, type: "ORDER_PAID", title: "Special Offer", body: "Buy 2 packs of Egusi, get 10% off! Use code EGUSI10" },
  ] });

  // ─── Rewards + Gift Cards ───────────────────────────────────
  await prisma.reward.create({ data: { name: "Welcome Gift", description: "Welcome bonus", type: "WALLET_BONUS", value: 500, currency: "EUR", isActive: true, maxClaims: 1000, claimedCount: 0 } });
  await prisma.reward.create({ data: { name: "Referral Bonus", description: "Refer a friend", type: "WALLET_BONUS", value: 1000, currency: "EUR", isActive: true, maxClaims: 500, claimedCount: 0 } });
  const gc1 = await prisma.giftCard.create({ data: { title: "€25 Gift Card", description: "Perfect gift gift for food lovers", priceAmount: 2500, currency: "EUR", isActive: true } });
  await prisma.giftCard.create({ data: { title: "€50 Gift Card", description: "Give the gift of African cuisine", priceAmount: 5000, currency: "EUR", isActive: true } });
  await prisma.purchasedGiftCard.create({ data: { buyerId: bu.id, giftCardId: gc1.id, amount: 2500, currency: "EUR" } });

  logger.info("Seed complete", { ms: Date.now() - start });
  res.json({
    message: "Database seeded successfully",
    accounts: [
      { email: "vendor@eki.app", password: "Abdou22314", role: "VENDOR", note: "Dual-role, 2 products, 2 orders, promos" },
      { email: "buyer@eki.app", password: "Abdou22314", role: "BUYER" },
      { email: "admin@eki.app", password: "Abdou22314", role: "ADMIN" },
    ],
    data: {
      products: ["Dried Fish Pack (500g) - €55", "Egusi Ground (1kg) - €8.50"],
      orders: ["EKI-DEMO-001 (PAID)", "EKI-DEMO-002 (DELIVERED)"],
      deliveryZones: ["Canada", "USA", "UK"],
      messages: "2 messages (buyer + vendor reply)",
      promoCode: "AFRO10 (10% off)",
      walletPending: "€57.15",
      buyerWallet: "€500",
      giftCards: ["€25", "€50"],
      conversations: 1,
      notifications: 5,
    },
  });
}
