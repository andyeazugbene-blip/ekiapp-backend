import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/**
 * GET /api/me/data-export
 * GDPR Article 20 — Right to data portability.
 * Returns all personal data associated with the authenticated user.
 */
export async function dataExport(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);

  const user = await prisma.user.findUnique({
    where: { id: request.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      country: true,
      role: true,
      referralCode: true,
      createdAt: true,
      orders: {
        select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
      notifications: {
        select: { id: true, type: true, title: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
    },
  });

  if (!user) throw new AppError("User not found", 404);

  response.status(200).json({
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      country: user.country,
      role: user.role,
      referralCode: user.referralCode,
      createdAt: user.createdAt,
    },
    orders: user.orders,
    notifications: user.notifications,
  });
}

/**
 * POST /api/me/delete-account
 * GDPR Article 17 — Right to erasure.
 * Anonymizes user data. Does not delete financial records (legal retention).
 */
export async function deleteAccount(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);

  const userId = request.user.id;

  // Check for pending orders/payouts that block deletion
  const pendingOrders = await prisma.order.count({
    where: { buyerId: userId, status: { in: ["PENDING", "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED"] } },
  });

  if (pendingOrders > 0) {
    throw new AppError("Cannot delete account with pending orders. Please wait for all orders to complete.", 400);
  }

  // Anonymize user data (retain financial records for legal compliance)
  await prisma.user.update({
    where: { id: userId },
    data: {
      email: `deleted_${userId}@anonymized.local`,
      name: "Deleted User",
      phone: null,
      avatar: null,
      country: null,
      referralCode: null,
      password: "ACCOUNT_DELETED",
      tokenVersion: { increment: 1 }, // Invalidate all tokens
    },
  });

  // Delete non-financial personal data
  await prisma.notification.deleteMany({ where: { userId } });
  await prisma.pushToken.deleteMany({ where: { userId } });

  response.status(200).json({ message: "Account data has been anonymized. Financial records retained per legal requirements." });
}
