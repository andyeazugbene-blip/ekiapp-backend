import { OrderStatus, PaymentStatus, Prisma, WalletTransactionType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export const adminOrdersService = {
  async completeOrder(orderId: string): Promise<{ orderId: string; status: OrderStatus }> {
    try {
      return await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            payment: true,
            items: { select: { vendorId: true } },
          },
        });

        if (!order) {
          throw new AppError("Order not found", 404);
        }

        if (order.status === OrderStatus.COMPLETED) {
          throw new AppError("Order already completed", 409);
        }
        if (order.status !== OrderStatus.PAID) {
          throw new AppError("Order is not in a completable state", 400);
        }

        const payment = order.payment;
        if (!payment || payment.status !== PaymentStatus.SUCCEEDED) {
          throw new AppError("Order payment has not succeeded", 400);
        }

        const vendorIds = [...new Set(order.items.map((item) => item.vendorId))];
        if (vendorIds.length !== 1) {
          throw new AppError("Order must have a single vendor", 400);
        }
        const vendorId = vendorIds[0];

        const wallet = await tx.wallet.findUnique({ where: { vendorId } });
        if (!wallet) {
          throw new AppError("Vendor wallet not found", 404);
        }

        const releaseAmount = payment.vendorEarningsAmount;

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

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            pendingBalance: { decrement: releaseAmount },
            availableBalance: { increment: releaseAmount },
          },
        });

        const updated = await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.COMPLETED },
          select: { id: true, status: true },
        });

        return { orderId: updated.id, status: updated.status };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new AppError("Release already processed for this order", 409);
      }
      throw error;
    }
  },
};
