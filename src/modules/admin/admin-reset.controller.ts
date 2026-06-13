import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export async function adminResetUsers(_req: Request, res: Response): Promise<void> {
  const hash = await bcrypt.hash("Abdou22314", 10);
  const toDelete = ["vendor@eki.app", "buyer@eki.app", "admin@eki.app"];
  const users = await prisma.user.findMany({ where: { email: { in: toDelete } }, select: { id: true } });
  const userIds = users.map(u => u.id);

  if (userIds.length > 0) {
    const vendorIds = (await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map(v => v.id);

    // Delete all vendor data in FK-safe order
    await prisma.walletTransaction.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.wallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.orderItem.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.payment.deleteMany({ where: { order: { vendorId: { in: vendorIds } } } });
    await prisma.order.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.shipment.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.dispute.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.deliveryOtp.deleteMany({ where: { order: { vendorId: { in: vendorIds } } } });
    await prisma.paystackTransaction.deleteMany({ where: { order: { vendorId: { in: vendorIds } } } });
    await prisma.product.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.vendorSubscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.verificationDocument.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.vendorBankAccount.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.payoutMethod.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.payoutRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await prisma.review.deleteMany({ where: { buyerId: { in: userIds } } });
    await prisma.conversation.deleteMany({ where: { OR: [{ participantA: { in: userIds } }, { participantB: { in: userIds } }] } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.pushToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.buyerWalletTransaction.deleteMany({ where: { buyerId: { in: userIds } } });
    await prisma.buyerWallet.deleteMany({ where: { buyerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  const vendorUser = await prisma.user.create({
    data: { email: "vendor@eki.app", name: "Queen African Foods", password: hash, phone: "+447700900111", country: "United Kingdom", role: "VENDOR", emailVerifiedAt: new Date(), referralCode: "QUEENAFRO10", trustScore: 85 },
  });
  const vendor = await prisma.vendor.create({
    data: { userId: vendorUser.id, storeName: "Queen African Foods", storeSlug: "queen-african-foods", description: "Premium African foodstuff.", contactEmail: "vendor@eki.app", contactPhone: "+447700900111", country: "United Kingdom", city: "London", businessType: "registered", sellerRegion: "africa", currency: "EUR", verificationStatus: "VERIFIED" },
  });
  await prisma.wallet.create({ data: { vendorId: vendor.id, currency: "EUR", pendingBalance: 0, availableBalance: 0 } });
  await prisma.user.create({ data: { email: "buyer@eki.app", name: "Amara Buyer", password: hash, phone: "+447700900222", country: "United Kingdom", role: "BUYER", emailVerifiedAt: new Date(), referralCode: "BUYERAMARA10", trustScore: 50 } });
  await prisma.user.create({ data: { email: "admin@eki.app", name: "Admin", password: hash, role: "ADMIN", emailVerifiedAt: new Date() } });

  logger.info("Accounts reset done");
  res.json({
    message: "Accounts reset successfully",
    accounts: [
      { email: "vendor@eki.app", password: "Abdou22314", role: "VENDOR", note: "Dual-role" },
      { email: "buyer@eki.app", password: "Abdou22314", role: "BUYER" },
      { email: "admin@eki.app", password: "Abdou22314", role: "ADMIN" },
    ],
  });
}
