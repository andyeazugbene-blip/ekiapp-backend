import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export async function adminResetUsers(_req: Request, res: Response): Promise<void> {
  const hash = await bcrypt.hash("Abdou22314", 10);
  const emails = ["vendor@eki.app", "buyer@eki.app", "admin@eki.app"];

  // Delete with CASCADE support via raw SQL
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } });
  for (const u of users) {
    await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "participantA" = $1 OR "participantB" = $1)`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "participantA" = $1 OR "participantB" = $1`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "userId" = $1`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "PushToken" WHERE "userId" = $1`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "BuyerWalletTransaction" WHERE "buyerId" = $1`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "BuyerWallet" WHERE "buyerId" = $1`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Review" WHERE "buyerId" = $1`, u.id);
    // Get vendor
    const v = await prisma.vendor.findUnique({ where: { userId: u.id } });
    if (v) {
      await prisma.$executeRawUnsafe(`DELETE FROM "DeliveryOtp" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "PaystackTransaction" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "Dispute" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "Shipment" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "OrderItem" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" = $1)`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "Order" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "CartItem" WHERE "productId" IN (SELECT id FROM "Product" WHERE "vendorId" = $1)`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "Product" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "WalletTransaction" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "Wallet" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "PayoutRequest" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "PayoutMethod" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorBankAccount" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "VerificationDocument" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorSubscription" WHERE "vendorId" = $1`, v.id);
      await prisma.$executeRawUnsafe(`DELETE FROM "Vendor" WHERE "id" = $1`, v.id);
    }
    await prisma.$executeRawUnsafe(`DELETE FROM "CartItem" WHERE "cartId" IN (SELECT id FROM "Cart" WHERE "buyerId" = $1)`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Cart" WHERE "buyerId" = $1`, u.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "EmailOtp" WHERE "email" = $1`, u.email);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, u.id);
  }

  // Create vendor@eki.app
  const vu = await prisma.user.create({ data: { email: "vendor@eki.app", name: "Queen African Foods", password: hash, phone: "+447700900111", country: "United Kingdom", role: "VENDOR", emailVerifiedAt: new Date(), referralCode: "QUEENAFRO10", trustScore: 85 } });
  const v = await prisma.vendor.create({ data: { userId: vu.id, storeName: "Queen African Foods", storeSlug: "queen-african-foods", description: "Premium African foodstuff.", contactEmail: "vendor@eki.app", contactPhone: "+447700900111", country: "United Kingdom", city: "London", businessType: "registered", sellerRegion: "africa", currency: "EUR", verificationStatus: "VERIFIED" } });
  await prisma.wallet.create({ data: { vendorId: v.id, currency: "EUR", pendingBalance: 0, availableBalance: 0 } });
  await prisma.user.create({ data: { email: "buyer@eki.app", name: "Amara Buyer", password: hash, phone: "+447700900222", country: "United Kingdom", role: "BUYER", emailVerifiedAt: new Date(), referralCode: "BUYERAMARA10", trustScore: 50 } });
  await prisma.user.create({ data: { email: "admin@eki.app", name: "Admin", password: hash, role: "ADMIN", emailVerifiedAt: new Date() } });
  logger.info("Accounts reset");
  res.json({ message: "Accounts reset", accounts: [
    { email: "vendor@eki.app", password: "Abdou22314", role: "VENDOR", note: "Dual-role" },
    { email: "buyer@eki.app", password: "Abdou22314", role: "BUYER" },
    { email: "admin@eki.app", password: "Abdou22314", role: "ADMIN" },
  ]});
}
