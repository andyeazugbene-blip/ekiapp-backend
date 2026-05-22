import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { paystack } from "../../lib/paystack";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";

/**
 * POST /api/admin/orders/:id/refund
 * Admin issues a full or partial refund.
 * Supports both Stripe and Paystack payments.
 * Idempotent via idempotencyKey (Stripe) or reference check (Paystack).
 */
export async function adminRefundOrder(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);

  const { amount, reason } = request.body as Record<string, unknown>;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payment: { select: { id: true, stripePaymentIntentId: true, status: true, amount: true, provider: true } },
      paystackTransaction: { select: { reference: true, status: true, amount: true } },
    },
  });

  if (!order) throw new AppError("Order not found", 404);
  if (order.status === "REFUNDED") throw new AppError("Order already refunded", 409);

  const refundAmount = typeof amount === "number" && amount > 0 ? amount : undefined;
  const provider = order.payment?.provider ?? (order.paystackTransaction ? "paystack" : "stripe");

  // ─── STRIPE REFUND ─────────────────────────────────────────────────
  if (provider === "stripe") {
    if (!order.payment?.stripePaymentIntentId) {
      throw new AppError("No Stripe payment found for this order", 400);
    }
    if (order.payment.status !== "SUCCEEDED") {
      throw new AppError("Can only refund succeeded payments", 400);
    }

    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: order.payment.stripePaymentIntentId,
          ...(refundAmount ? { amount: refundAmount } : {}),
          metadata: { orderId, adminUserId: request.user.id },
          reason: (reason as string) === "duplicate" ? "duplicate"
            : (reason as string) === "fraudulent" ? "fraudulent"
            : "requested_by_customer",
        },
        { idempotencyKey: `refund:${orderId}:${refundAmount ?? "full"}` },
      );

      logger.info("Admin Stripe refund issued", { orderId, refundId: refund.id, amount: refund.amount });

      await prisma.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } });
      await createAuditLog(request.user.id, orderId, refund.id, refund.amount, reason);

      response.status(202).json({ refundId: refund.id, amount: refund.amount, status: refund.status, provider: "stripe" });
    } catch (error) {
      logger.error("Stripe refund failed", { orderId, error: error instanceof Error ? error.message : String(error) });
      throw new AppError("Stripe refund failed", 502);
    }
    return;
  }

  // ─── PAYSTACK REFUND ───────────────────────────────────────────────
  if (provider === "paystack" || order.paystackTransaction) {
    if (!order.paystackTransaction?.reference) {
      throw new AppError("No Paystack transaction found for this order", 400);
    }
    if (order.paystackTransaction.status !== "SUCCESS") {
      throw new AppError("Can only refund successful Paystack payments", 400);
    }

    try {
      await paystack.refundTransaction(order.paystackTransaction.reference, refundAmount);

      logger.info("Admin Paystack refund issued", { orderId, reference: order.paystackTransaction.reference });

      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } });
        await tx.paystackTransaction.update({
          where: { reference: order.paystackTransaction!.reference },
          data: { status: "REVERSED" },
        });
      });

      await createAuditLog(request.user.id, orderId, order.paystackTransaction.reference, refundAmount ?? order.paystackTransaction.amount, reason);

      response.status(202).json({
        refundId: order.paystackTransaction.reference,
        amount: refundAmount ?? order.paystackTransaction.amount,
        status: "reversed",
        provider: "paystack",
      });
    } catch (error) {
      logger.error("Paystack refund failed", { orderId, error: error instanceof Error ? error.message : String(error) });
      throw new AppError("Paystack refund failed", 502);
    }
    return;
  }

  throw new AppError("No payment provider found for this order", 400);
}

async function createAuditLog(actorId: string, orderId: string, refundId: string, amount: number, reason: unknown): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId,
      action: "ORDER_REFUNDED",
      entityType: "Order",
      entityId: orderId,
      metadata: { refundId, amount, reason: String(reason ?? "") },
    },
  });
}
