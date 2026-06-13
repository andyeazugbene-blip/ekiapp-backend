/**
 * Reset database: delete all data, recreate vendor@eki.app (dual-role) + buyer@eki.app
 * Run: npx tsx scripts/reset-db.ts
 * WARNING: DELETES ALL DATA!
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🚨 DELETING ALL DATA...");

  // Delete in dependency order (children first)
  await prisma.walletTransaction.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.checkout.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.product.deleteMany();
  await prisma.payoutRequest.deleteMany();
  await prisma.payoutMethod.deleteMany();
  await prisma.vendorBankAccount.deleteMany();
  await prisma.paystackTransaction.deleteMany();
  await prisma.deliveryOtp.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.verificationDocument.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.pushToken.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.emailVerificationToken.deleteMany();
  await prisma.buyerWalletTransaction.deleteMany();
  await prisma.buyerWallet.deleteMany();
  await prisma.promoRedemption.deleteMany();
  await prisma.promoCode.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.review.deleteMany();
  await prisma.userReward.deleteMany();
  await prisma.vendorSubscription.deleteMany();
  await prisma.adminRoleAssignment.deleteMany();
  await prisma.adminTwoFactor.deleteMany();
  await prisma.PurchasedGiftCard?.deleteMany();
  await prisma.GiftCard?.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.deliveryMethod.deleteMany();
  await prisma.deliveryZone.deleteMany();
  await prisma.buyerAddress.deleteMany();
  await prisma.emailOtp.deleteMany();
  await prisma.uploadAsset.deleteMany();
  await prisma.smsDelivery.deleteMany();
  await prisma.address?.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.user.deleteMany();

  console.log("✅ All data deleted");

  const hash = await bcrypt.hash("Abdou22314", 10);

  // ─── Create VENDOR@EKI.APP (dual-role: can be buyer AND vendor) ─────────
  const vendorUser = await prisma.user.create({
    data: {
      email: "vendor@eki.app",
      name: "Queen African Foods",
      password: hash,
      phone: "+447700900111",
      country: "United Kingdom",
      role: "VENDOR",     // Starts as VENDOR
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
      businessType: "registered",
      sellerRegion: "africa",
      currency: "GBP",
      verificationStatus: "VERIFIED",
    },
  });

  // Wallet for vendor
  await prisma.wallet.create({
    data: { vendorId: vendor.id, currency: "GBP", pendingBalance: 0, availableBalance: 0 },
  });

  console.log("✅ vendor@eki.app created — role=VENDOR, has vendor profile + wallet");
  console.log("   Login as 'buyer' → will see buyer screens (no role block)");
  console.log("   Login as 'vendor' → will see vendor dashboard");
  console.log("   Switch via POST /api/auth/switch-role or app button");

  // ─── Create BUYER@EKI.APP (regular buyer only) ──────────────────────────
  await prisma.user.create({
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

  console.log("✅ buyer@eki.app created — role=BUYER");

  // ─── Create ADMIN ───────────────────────────────────────────────────────
  const adminPass = await bcrypt.hash("Abdou22314", 10);
  await prisma.user.create({
    data: {
      email: "admin@eki.app",
      name: "Admin",
      password: adminPass,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
    },
  });
  console.log("✅ admin@eki.app created — role=ADMIN");

  console.log("\n📋 ALL ACCOUNTS:");
  console.log("   vendor@eki.app / Abdou22314 → BUYER+VENDOR dual-role");
  console.log("   buyer@eki.app / Abdou22314  → BUYER only");
  console.log("   admin@eki.app / Abdou22314   → ADMIN");
  console.log("\n✅ Done!");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
