import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export async function adminResetUsers(_req: Request, res: Response): Promise<void> {
  const hash = await bcrypt.hash("Abdou22314", 10);
  const emails = ["vendor@eki.app", "buyer@eki.app", "admin@eki.app"];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const uids = users.map(x => x.id);

  if (uids.length > 0) {
    const vids = (await prisma.vendor.findMany({ where: { userId: { in: uids } }, select: { id: true } })).map(x => x.id);

    // Delete all related data using raw SQL to handle FK constraints
    await prisma.$executeRawUnsafe(`DELETE FROM "CartItem" WHERE "cartId" IN (SELECT id FROM "Cart" WHERE "buyerId" IN (${uids.map(() => '?').join(',')}))`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Cart" WHERE "buyerId" IN (${uids.map(() => '?').join(',')})`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Checkout" WHERE "buyerId" IN (${uids.map(() => '?').join(',')})`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "EmailOtp" WHERE "email" IN (${emails.map(() => '?').join(',')})`, ...emails);
    await prisma.$executeRawUnsafe(`DELETE FROM "DeliveryOtp" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" IN (${vids.map(() => '?').join(',')}))`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "PaystackTransaction" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" IN (${vids.map(() => '?').join(',')}))`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Dispute" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" IN (${vids.map(() => '?').join(',')}))`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Shipment" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "OrderItem" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "vendorId" IN (${vids.map(() => '?').join(',')}))`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Order" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "CartItem" WHERE "productId" IN (SELECT id FROM "Product" WHERE "vendorId" IN (${vids.map(() => '?').join(',')}))`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Product" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Review" WHERE "buyerId" IN (${uids.map(() => '?').join(',')})`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "WalletTransaction" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Wallet" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "PayoutRequest" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "PayoutMethod" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "VendorBankAccount" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "VerificationDocument" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "VendorSubscription" WHERE "vendorId" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Vendor" WHERE "id" IN (${vids.map(() => '?').join(',')})`, ...vids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "participantA" IN (${uids.map(() => '?').join(',')}) OR "participantB" IN (${uids.map(() => '?').join(',')})`, ...uids, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "userId" IN (${uids.map(() => '?').join(',')})`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "PushToken" WHERE "userId" IN (${uids.map(() => '?').join(',')})`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "BuyerWalletTransaction" WHERE "buyerId" IN (${uids.map(() => '?').join(',')})`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "BuyerWallet" WHERE "buyerId" IN (${uids.map(() => '?').join(',')})`, ...uids);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN (${uids.map(() => '?').join(',')})`, ...uids);
  }

  const vu = await prisma.user.create({ data: { email: "vendor@eki.app", name: "Queen African Foods", password: hash, phone: "+447700900111", country: "United Kingdom", role: "VENDOR", emailVerifiedAt: new Date(), referralCode: "QUEENAFRO10", trustScore: 85 } });
  const v = await prisma.vendor.create({ data: { userId: vu.id, storeName: "Queen African Foods", storeSlug: "queen-african-foods", description: "Premium African foodstuff.", contactEmail: "vendor@eki.app", contactPhone: "+447700900111", country: "United Kingdom", city: "London", businessType: "registered", sellerRegion: "africa", currency: "EUR", verificationStatus: "VERIFIED" } });
  await prisma.wallet.create({ data: { vendorId: v.id, currency: "EUR", pendingBalance: 0, availableBalance: 0 } });
  await prisma.user.create({ data: { email: "buyer@eki.app", name: "Amara Buyer", password: hash, phone: "+447700900222", country: "United Kingdom", role: "BUYER", emailVerifiedAt: new Date(), referralCode: "BUYERAMARA10", trustScore: 50 } });
  await prisma.user.create({ data: { email: "admin@eki.app", name: "Admin", password: hash, role: "ADMIN", emailVerifiedAt: new Date() } });
  logger.info("Accounts reset done");
  res.json({ message: "Accounts reset", accounts: [
    { email: "vendor@eki.app", password: "Abdou22314", role: "VENDOR", note: "Dual-role" },
    { email: "buyer@eki.app", password: "Abdou22314", role: "BUYER" },
    { email: "admin@eki.app", password: "Abdou22314", role: "ADMIN" },
  ]});
}
