import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export async function adminResetUsers(_req: Request, res: Response): Promise<void> {
  const start = Date.now();
  const hash = await bcrypt.hash("Abdou22314", 10);
  const emails = ["vendor@eki.app", "buyer@eki.app", "admin@eki.app"];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const uids = users.map(x => x.id);

  if (uids.length > 0) {
    const vids = (await prisma.vendor.findMany({ where: { userId: { in: uids } }, select: { id: true } })).map(x => x.id);

    if (vids.length > 0) {
      // These tables have onDelete: Cascade from vendor — delete the vendor last
      await prisma.walletTransaction.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.wallet.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.payoutRequest.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.payoutMethod.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.vendorBankAccount.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.verificationDocument.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.vendorSubscription.deleteMany({ where: { vendorId: { in: vids } } });

      // Orders have FK constraints to payment/orderItem/shipment/deliveryOtp/dispute/paystackTransaction
      await prisma.walletTransaction.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.orderItem.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.payment.deleteMany({ where: { order: { vendorId: { in: vids } } } });
      await prisma.shipment.deleteMany({ where: { vendorId: { in: vids } } });
      await prisma.deliveryOtp.deleteMany({ where: { order: { vendorId: { in: vids } } } });
      await prisma.paystackTransaction.deleteMany({ where: { order: { vendorId: { in: vids } } } });
      await prisma.dispute.deleteMany({ where: { order: { vendorId: { in: vids } } } });
      await prisma.order.deleteMany({ where: { vendorId: { in: vids } } });

      // Products have FK to OrderItem — already deleted above
      await prisma.product.deleteMany({ where: { vendorId: { in: vids } } });

      await prisma.vendor.deleteMany({ where: { id: { in: vids } } });
    }

    // User-level data
    await prisma.review.deleteMany({ where: { buyerId: { in: uids } } });
    await prisma.conversation.deleteMany({ where: { OR: [{ participantA: { in: uids } }, { participantB: { in: uids } }] } }); // cascades messages
    await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
    await prisma.pushToken.deleteMany({ where: { userId: { in: uids } } });
    await prisma.buyerWalletTransaction.deleteMany({ where: { buyerId: { in: uids } } });
    await prisma.buyerWallet.deleteMany({ where: { buyerId: { in: uids } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  // Create accounts
  const vu = await prisma.user.create({ data: { email: "vendor@eki.app", name: "Queen African Foods", password: hash, phone: "+447700900111", country: "United Kingdom", role: "VENDOR", emailVerifiedAt: new Date(), referralCode: "QUEENAFRO10", trustScore: 85 } });
  const v = await prisma.vendor.create({ data: { userId: vu.id, storeName: "Queen African Foods", storeSlug: "queen-african-foods", description: "Premium African foodstuff.", contactEmail: "vendor@eki.app", contactPhone: "+447700900111", country: "United Kingdom", city: "London", businessType: "registered", sellerRegion: "africa", currency: "EUR", verificationStatus: "VERIFIED" } });
  await prisma.wallet.create({ data: { vendorId: v.id, currency: "EUR", pendingBalance: 0, availableBalance: 0 } });
  await prisma.user.create({ data: { email: "buyer@eki.app", name: "Amara Buyer", password: hash, phone: "+447700900222", country: "United Kingdom", role: "BUYER", emailVerifiedAt: new Date(), referralCode: "BUYERAMARA10", trustScore: 50 } });
  await prisma.user.create({ data: { email: "admin@eki.app", name: "Admin", password: hash, role: "ADMIN", emailVerifiedAt: new Date() } });

  logger.info(`Accounts reset in ${Date.now()-start}ms`);
  res.json({ message: "Accounts reset", accounts: [
    { email: "vendor@eki.app", password: "Abdou22314", role: "VENDOR", note: "Dual-role - login as buyer or vendor" },
    { email: "buyer@eki.app", password: "Abdou22314", role: "BUYER" },
    { email: "admin@eki.app", password: "Abdou22314", role: "ADMIN" },
  ]});
}
