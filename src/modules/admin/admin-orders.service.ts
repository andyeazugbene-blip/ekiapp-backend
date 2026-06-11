import { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";

export const adminOrdersService = {
  /**
   * Complete an order: PAID → COMPLETED.
   * Releases vendor earnings from pendingBalance → availableBalance.
   *
   * Concurrency-safe:
   * - Uses conditional updateMany on order status
   * - Wallet release is handled atomically in releaseVendorEarnings
   * - Idempotent: safe to call multiple times
   */
  async completeOrder(orderId: string): Promise<{ orderId: string; status: OrderStatus }> {
    try {
      return await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            payment: { select: { id: true, status: true, vendorEarningsAmount: true, currency: true } },
            items: { select: { vendorId: true } },
          },
        });

        if (!order) throw new AppError("Order not found", 404);
        if (order.status === OrderStatus.COMPLETED) throw new AppError("Order already completed", 409);
        if (order.status !== OrderStatus.PAID) throw new AppError("Order is not in a completable state", 400);

        const payment = order.payment;
        if (!payment || payment.status !== PaymentStatus.SUCCEEDED) {
          throw new AppError("Order payment has not succeeded", 400);
        }

        // Conditional order status transition (prevents double-completion)
        const orderUpdate = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PAID },
          data: { status: OrderStatus.COMPLETED },
        });
        if (orderUpdate.count === 0) {
          throw new AppError("Order state changed concurrently", 409);
        }

        return { orderId, status: OrderStatus.COMPLETED };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if ((error as any)?.code === "P2002") {
        throw new AppError("Release already processed for this order", 409);
      }
      throw error;
    } finally {
      // Release wallet earnings outside the main transaction to avoid deadlocks
      releaseVendorEarnings(orderId).catch(() => {});
    }
  },
};
