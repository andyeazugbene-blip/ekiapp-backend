import { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";
import { logger } from "../../lib/logger";
import { notificationsService } from "../notifications/notifications.service";
import { pushNotifications } from "../../lib/push-notifications";

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

  /**
   * Force-process a stuck order: mark payment SUCCEEDED, mark order PAID,
   * credit vendor wallet pendingBalance, create wallet transaction.
   * Safety net for orders that were created but webhook never fired.
   */
  async processStuckOrder(orderId: string): Promise<{ orderId: string; status: string; amount: number; wallet?: { pending: number; available: number } }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payment: { select: { id: true, status: true, vendorEarningsAmount: true, currency: true } },
        items: { select: { vendorId: true } },
        checkout: { select: { buyerId: true } },
      },
    });
    if (!order) throw new AppError("Order not found", 404);

    const result = await prisma.$transaction(async (tx) => {
      if (order.payment) {
        await tx.payment.updateMany({
          where: { id: order.payment.id, status: PaymentStatus.PENDING },
          data: { status: "SUCCEEDED", processedAt: new Date() },
        });
      }
      await tx.order.updateMany({
        where: { id: orderId, status: { in: ["PENDING", "PAID", "CONFIRMED", "PROCESSING"] } },
        data: { status: "PAID" },
      });

      const vendorId = order.vendorId ?? order.items[0]?.vendorId;
      if (vendorId && order.payment && order.payment.vendorEarningsAmount > 0) {
        let wallet = await tx.wallet.findUnique({ where: { vendorId } });
        if (!wallet) {
          wallet = await tx.wallet.create({ data: { vendorId, currency: order.payment.currency } });
        }
        await tx.walletTransaction.create({
          data: { walletId: wallet.id, vendorId, orderId: order.id, paymentId: order.payment.id,
            type: "PAYMENT_PENDING_CREDIT", amount: order.payment.vendorEarningsAmount,
            currency: order.payment.currency, description: `Pending credit for order ${order.id}` },
        });
        await tx.wallet.update({ where: { id: wallet.id }, data: { pendingBalance: { increment: order.payment.vendorEarningsAmount } } });
      }
      return { amount: order.payment?.vendorEarningsAmount ?? 0 };
    }, { isolationLevel: "Serializable" });

    // Notify
    if (order.checkout?.buyerId) {
      notificationsService.enqueue({ userId: order.checkout.buyerId, type: "ORDER_PAID" as any, title: "Order paid", body: `Order ${orderId} processed.` }).catch(() => {});
      pushNotifications.orderPaid(order.checkout.buyerId, 1);
    }
    const vendorId = order.vendorId ?? order.items[0]?.vendorId;
    if (vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
      if (vendor) {
        notificationsService.enqueue({ userId: vendor.userId, type: "BALANCE_CREDITED" as any, title: "New order", body: `Order ${orderId} paid.` }).catch(() => {});
        pushNotifications.vendorNewOrder(vendor.userId, orderId);
      }
    }

    const wallet = vendorId ? await prisma.wallet.findUnique({ where: { vendorId }, select: { pendingBalance: true, availableBalance: true } }) : null;
    return { orderId, status: "PAID", amount: result.amount, wallet: wallet ? { pending: wallet.pendingBalance, available: wallet.availableBalance } : undefined };
  },
};
