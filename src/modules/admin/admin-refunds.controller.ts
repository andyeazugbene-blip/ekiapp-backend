import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";

/**
 * POST /api/admin/orders/:id/refund
 * Admin issues a full or partial refund via Stripe.
 * Idempotent via idempotencyKey.
 */
export async function adminRefundOrder(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);

  const { amount, reason } = request.body as Record<string, unknown>;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: { select: { id: true, stripePaymentIntentId: true, status: true, amount: true } } },
  });

  if (!order) throw new AppError("Order not found", 404);
  if (!order.payment?.stripePaymentIntentId) {
    throw new AppError("No Stripe payment found for this order", 400);
  }
  if (order.status === "REFUNDED") {
    throw new AppError("Order already refunded", 409);
  }
  if (order.payment.status !== "SUCCEEDED") {
    throw new AppError("Can only refund succeeded payments", 400);
  }

  const refundAmount = typeof amount === "number" && amount > 0 ? amount : undefined;

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

    logger.info("Admin refund issued", { orderId, refundId: refund.id, amount: refund.amount });

    // Mark order as refunded immediately (webhook will also fire)
    const isPartial = refundAmount && refundAmount < order.payment.amount;
    await prisma.order.update({
      where: { id: orderId },
      data: { status: isPartial ? "REFUNDED" : "REFUNDED" },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: request.user.id,
        action: "ORDER_REFUNDED",
        entityType: "Order",
        entityId: orderId,
        metadata: { refundId: refund.id, amount: refund.amount, reason: String(reason ?? "") },
      },
    });

    response.status(202).json({
      refundId: refund.id,
      amount: refund.amount,
      status: refund.status,
    });
  } catch (error) {
    logger.error("Stripe refund failed", {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AppError("Refund failed", 502);
  }
}
