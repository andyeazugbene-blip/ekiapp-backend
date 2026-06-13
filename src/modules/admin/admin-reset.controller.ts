import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export async function adminResetUsers(_req: Request, res: Response): Promise<void> {
  const hash = await bcrypt.hash("Abdou22314", 10);
  const emails = ["vendor@eki.app", "buyer@eki.app", "admin@eki.app"];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  for (const u of users) {
    // Delete vendor first (triggers cascade for wallet, products, etc.)
    const v = await prisma.vendor.findUnique({ where: { userId: u.id } });
    if (v) {
      await prisma.walletTransaction.deleteMany({ where: { vendorId: v.id } });
      await prisma.wallet.delete({ where: { vendorId: v.id } }).catch(() => {});
      // Delete orders for this vendor
      const orderIds = (await prisma.order.findMany({ where: { vendorId: v.id }, select: { id: true } })).map(o => o.id);
      if (orderIds.length > 0) {
        await prisma.walletTransaction.deleteMany({ where: { payment: { orderId: { in: orderIds } } } }); await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.product.deleteMany({ where: { vendorId: v.id } });
      await prisma.vendor.delete({ where: { id: v.id } });
    }
    // Delete buyer orders
    const buyerOrderIds = (await prisma.order.findMany({ where: { buyerId: u.id }, select: { id: true } })).map(o => o.id);
    if (buyerOrderIds.length > 0) {
      await prisma.walletTransaction.deleteMany({ where: { payment: { orderId: { in: buyerOrderIds } } } }); await prisma.payment.deleteMany({ where: { orderId: { in: buyerOrderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: buyerOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: buyerOrderIds } } });
    }
    await prisma.cart.deleteMany({ where: { buyerId: u.id } });
    await prisma.notification.deleteMany({ where: { userId: u.id } });
    await prisma.pushToken.deleteMany({ where: { userId: u.id } });
    await prisma.buyerWalletTransaction.deleteMany({ where: { buyerId: u.id } });
    await prisma.buyerWallet.deleteMany({ where: { buyerId: u.id } });
    await prisma.review.deleteMany({ where: { buyerId: u.id } });
  }
  await prisma.user.deleteMany({ where: { email: { in: emails } } });

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