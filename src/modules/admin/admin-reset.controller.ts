import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export async function adminResetUsers(_req: Request, res: Response): Promise<void> {
  const start = Date.now();
  const hash = await bcrypt.hash("Abdou22314", 10);
  const emails = ["vendor@eki.app", "buyer@eki.app", "admin@eki.app"];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } });
  for (const u of users) {
    const v = await prisma.vendor.findUnique({ where: { userId: u.id } });
    if (v) {
      const sqls = [
        `DELETE FROM "DeliveryOtp" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`,
        `DELETE FROM "PaystackTransaction" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`,
        `DELETE FROM "Dispute" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`,
        `DELETE FROM "Shipment" WHERE "vendorId" = $1`,
        `DELETE FROM "OrderItem" WHERE "vendorId" = $1`,
        `DELETE FROM "WalletTransaction" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1))`,
        `DELETE FROM "Payment" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`,
        `DELETE FROM "Checkout" WHERE "id" IN (SELECT "checkoutId" FROM "Order" WHERE "vendorId" = $1)`,
        `DELETE FROM "Order" WHERE "vendorId" = $1`,
        `DELETE FROM "CartItem" WHERE "productId" IN (SELECT id FROM "Product" WHERE "vendorId" = $1)`,
        `DELETE FROM "Product" WHERE "vendorId" = $1`,
        `DELETE FROM "WalletTransaction" WHERE "vendorId" = $1`,
        `DELETE FROM "Wallet" WHERE "vendorId" = $1`,
        `DELETE FROM "PayoutRequest" WHERE "vendorId" = $1`,
        `DELETE FROM "PayoutMethod" WHERE "vendorId" = $1`,
        `DELETE FROM "VendorBankAccount" WHERE "vendorId" = $1`,
        `DELETE FROM "VerificationDocument" WHERE "vendorId" = $1`,
        `DELETE FROM "VendorSubscription" WHERE "vendorId" = $1`,
        `DELETE FROM "Vendor" WHERE "id" = $1`,
      ];
      for (const sql of sqls) { await prisma.$executeRawUnsafe(sql, v.id); }
    }
    const sqls2 = [
      `DELETE FROM "OrderItem" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "buyerId" = $1)`,
      `DELETE FROM "DeliveryOtp" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "buyerId" = $1)`,
      `DELETE FROM "PaystackTransaction" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "buyerId" = $1)`,
      `DELETE FROM "Dispute" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "buyerId" = $1)`,
      `DELETE FROM "WalletTransaction" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "buyerId" = $1))`,
      `DELETE FROM "Payment" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "buyerId" = $1)`,
      `DELETE FROM "Order" WHERE "buyerId" = $1`,
      `DELETE FROM "Checkout" WHERE "buyerId" = $1`,
      `DELETE FROM "CartItem" WHERE "cartId" IN (SELECT id FROM "Cart" WHERE "buyerId" = $1)`,
      `DELETE FROM "Cart" WHERE "buyerId" = $1`,
      `DELETE FROM "Review" WHERE "buyerId" = $1`,
      `DELETE FROM "Notification" WHERE "userId" = $1`,
      `DELETE FROM "PushToken" WHERE "userId" = $1`,
      `DELETE FROM "BuyerWalletTransaction" WHERE "buyerId" = $1`,
      `DELETE FROM "BuyerWallet" WHERE "buyerId" = $1`,
      `DELETE FROM "Conversation" WHERE "participantA" = $1 OR "participantB" = $1`,
      `DELETE FROM "User" WHERE "id" = $1`,
    ];
    for (const sql of sqls2) { await prisma.$executeRawUnsafe(sql, u.id); }
  }
  const vu = await prisma.user.create({ data: { email: "vendor@eki.app", name: "Queen African Foods", password: hash, phone: "+447700900111", country: "United Kingdom", role: "VENDOR", emailVerifiedAt: new Date(), referralCode: "QUEENAFRO10", trustScore: 85 } });
  const v = await prisma.vendor.create({ data: { userId: vu.id, storeName: "Queen African Foods", storeSlug: "queen-african-foods", description: "Premium African foodstuff.", contactEmail: "vendor@eki.app", contactPhone: "+447700900111", country: "United Kingdom", city: "London", businessType: "registered", sellerRegion: "africa", currency: "EUR", verificationStatus: "VERIFIED" } });
  await prisma.wallet.create({ data: { vendorId: v.id, currency: "EUR", pendingBalance: 0, availableBalance: 0 } });
  await prisma.user.create({ data: { email: "buyer@eki.app", name: "Amara Buyer", password: hash, phone: "+447700900222", country: "United Kingdom", role: "BUYER", emailVerifiedAt: new Date(), referralCode: "BUYERAMARA10", trustScore: 50 } });
  await prisma.user.create({ data: { email: "admin@eki.app", name: "Admin", password: hash, role: "ADMIN", emailVerifiedAt: new Date() } });
  logger.info("Accounts reset in " + (Date.now()-start) + "ms");
  res.json({ message: "Accounts reset", accounts: [
    { email: "vendor@eki.app", password: "Abdou22314", role: "VENDOR", note: "Dual-role" },
    { email: "buyer@eki.app", password: "Abdou22314", role: "BUYER" },
    { email: "admin@eki.app", password: "Abdou22314", role: "ADMIN" },
  ]});
}