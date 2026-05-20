import { OrderStatus, PaymentStatus, Prisma, WalletTransactionType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export const adminOrdersService = {
  /**
   * Complete an order: PAID → COMPLETED.
   * Releases vendor earnings from pendingBalance → availableBalance.
   *
   * Concurrency-safe:
   * - Uses conditional updateMany on order status (only if PAID)
   * - Uses conditional updateMany on wallet (pendingBalance >= amount)
   * - WalletTransaction unique constraint prevents double-release
   * - Idempotent: returns 409 if already completed
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

        const vendorIds = [...new Set(order.items.map((item) => item.vendorId))];
        if (vendorIds.length !== 1) throw new AppError("Order must have a single vendor", 400);
        const vendorId = vendorIds[0];

        const wallet = await tx.wallet.findUnique({ where: { vendorId } });
        if (!wallet) throw new AppError("Vendor wallet not found", 404);

        const releaseAmount = payment.vendorEarningsAmount;

        // Conditional order status transition (prevents double-completion)
        const orderUpdate = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PAID },
          data: { status: OrderStatus.COMPLETED },
        });
        if (orderUpdate.count === 0) {
          throw new AppError("Order state changed concurrently", 409);
        }

        // Conditional wallet update (prevents negative pendingBalance)
        const walletUpdate = await tx.wallet.updateMany({
          where: { id: wallet.id, pendingBalance: { gte: releaseAmount } },
          data: {
            pendingBalance: { decrement: releaseAmount },
            availableBalance: { increment: releaseAmount },
          },
        });
        if (walletUpdate.count === 0) {
          throw new AppError("Insufficient pending balance for release", 409);
        }

        // Ledger entry (unique constraint on [vendorId, orderId, paymentId, type] prevents duplicates)
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            vendorId,
            orderId: order.id,
            paymentId: payment.id,
            type: WalletTransactionType.PENDING_TO_AVAILABLE,
            amount: releaseAmount,
            currency: payment.currency,
            description: `Release pending earnings for order ${order.id}`,
          },
        });

        return { orderId, status: OrderStatus.COMPLETED };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError("Release already processed for this order", 409);
      }
      throw error;
    }
  },
};
