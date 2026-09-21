import { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";
import type { Request } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";
import { logger } from "../../lib/logger";
import { notificationsService } from "../notifications/notifications.service";
import { recordAudit } from "../../shared/utils/audit";

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
  async completeOrder(orderId: string, adminId: string, request?: Request): Promise<{ orderId: string; status: OrderStatus }> {
    let beforeStatus: OrderStatus | undefined;
    try {
      const result = await prisma.$transaction(async (tx) => {
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
        beforeStatus = order.status;

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

      // Financial-state mutation (force-completes an order, triggers wallet
      // release below) — acceptance audit gap: this previously had zero
      // audit trail, unlike every other admin action that moves money.
      await recordAudit({
        actorId: adminId,
        action: "admin.order.force_complete",
        entityType: "Order",
        entityId: orderId,
        beforeState: { status: beforeStatus },
        afterState: { status: OrderStatus.COMPLETED },
        request,
      });

      return result;
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
  async processStuckOrder(orderId: string, adminId: string, request?: Request): Promise<{ orderId: string; status: string; amount: number; wallet?: { pending: number; available: number } }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payment: { select: { id: true, status: true, vendorEarningsAmount: true, currency: true } },
        items: { select: { vendorId: true } },
        checkout: { select: { buyerId: true } },
      },
    });
    if (!order) throw new AppError("Order not found", 404);
    // Acceptance audit fix: previously the wallet-credit write below had no
    // guard of its own — a second call on an already-processed order relied
    // entirely on WalletTransaction's DB unique constraint throwing a raw,
    // unhandled P2002 rather than a clean error. Reject up front instead.
    if (order.payment?.status === PaymentStatus.SUCCEEDED) {
      throw new AppError("This order's payment has already been processed", 409);
    }
    const beforeStatus = order.status;

    let result: { amount: number };
    try {
      result = await prisma.$transaction(async (tx) => {
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
    } catch (error) {
      if ((error as any)?.code === "P2002") {
        throw new AppError("This order's payment has already been processed", 409);
      }
      throw error;
    }

    // Financial-state mutation (marks payment succeeded, credits vendor
    // wallet) — acceptance audit gap: this previously had zero audit trail.
    await recordAudit({
      actorId: adminId,
      action: "admin.order.force_process",
      entityType: "Order",
      entityId: orderId,
      beforeState: { status: beforeStatus, paymentStatus: order.payment?.status ?? null },
      afterState: { status: "PAID", paymentStatus: "SUCCEEDED", walletCredited: result.amount },
      request,
    });

    // Notify (single send per recipient — enqueue() already sends the push)
    if (order.checkout?.buyerId) {
      notificationsService.enqueue({
        userId: order.checkout.buyerId,
        type: "ORDER_PAID" as any,
        title: "Order Confirmed! 🎉",
        body: "Your order has been confirmed.",
        data: { type: "order_paid" },
      }).catch(() => {});
    }
    const vendorId = order.vendorId ?? order.items[0]?.vendorId;
    if (vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
      if (vendor) {
        notificationsService.enqueue({
          userId: vendor.userId,
          type: "BALANCE_CREDITED" as any,
          title: "New Order! 🛒",
          body: "You have a new order to process.",
          data: { type: "new_order", orderId },
        }).catch(() => {});
      }
    }

    const wallet = vendorId ? await prisma.wallet.findUnique({ where: { vendorId }, select: { pendingBalance: true, availableBalance: true } }) : null;
    return { orderId, status: "PAID", amount: result.amount, wallet: wallet ? { pending: wallet.pendingBalance, available: wallet.availableBalance } : undefined };
  },
};
