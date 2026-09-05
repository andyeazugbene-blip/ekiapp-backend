import type { Request, Response } from "express";
import { NotificationType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { paystack } from "../../lib/paystack";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { adminApprovalsService } from "./admin-approvals.service";
import { notificationsService } from "../notifications/notifications.service";

interface OrderRefundResult {
  refundId: string;
  /** Always the order's OWN native currency and minor unit — never the
   * PaymentIntent/checkout currency, so the admin UI never shows an amount
   * whose currency is ambiguous relative to everything else on this order. */
  amount: number;
  currency: string;
  status: string;
  provider: "stripe" | "paystack";
}

/**
 * The actual refund execution — extracted so both the direct (ungated)
 * path and the four-eyes approval-decide path (admin-approvals.controller.ts)
 * call the exact same code, never two parallel implementations.
 */
export async function executeOrderRefund(orderId: string, adminId: string, amount: number | undefined, reason: unknown): Promise<OrderRefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payment: { select: { id: true, stripePaymentIntentId: true, status: true, amount: true, provider: true } },
      paystackTransaction: { select: { reference: true, status: true, amount: true } },
    },
  });

  if (!order) throw new AppError("Order not found", 404);
  if (order.status === "REFUNDED") throw new AppError("Order already refunded", 409);

  // The admin always enters an amount in the ORDER's OWN native currency —
  // order.currency, order.totalAmount — the same currency every other
  // figure for this order is shown in everywhere else in the admin UI.
  // Never accept or infer an amount already expressed in the checkout/
  // PaymentIntent currency; that ambiguity is exactly what let a
  // normalized-vs-native mismatch silently reach Stripe.
  if (amount !== undefined && (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0)) {
    throw new AppError("Refund amount must be a positive integer (minor units) in the order's own currency", 400);
  }
  if (amount !== undefined && amount > order.totalAmount) {
    throw new AppError("Refund amount cannot exceed the order's own total", 400);
  }

  const provider = order.payment?.provider ?? (order.paystackTransaction ? "paystack" : "stripe");

  if (provider === "stripe") {
    if (!order.payment?.stripePaymentIntentId) throw new AppError("No Stripe payment found for this order", 400);
    if (order.payment.status !== "SUCCEEDED") throw new AppError("Can only refund succeeded payments", 400);

    const nativeRefundAmount = amount ?? order.totalAmount;

    // The PaymentIntent this order's payment references may be SHARED
    // across every vendor's order in the same multi-vendor checkout (see
    // payments.service.ts createPaymentIntent — exactly one PaymentIntent
    // per checkout, summing every vendor group's normalized amount). Two
    // things follow:
    //   1. `amount` sent to Stripe must ALWAYS be explicit. Omitting it
    //      would refund the entire PaymentIntent — every other vendor's
    //      money in that checkout too, not just this order's share.
    //   2. That amount must be expressed in the PaymentIntent's OWN
    //      currency (order.checkoutCurrency when this order's native
    //      currency differs from it), converted using the SAME rate
    //      snapshot taken at checkout time (order.exchangeRate) — never a
    //      freshly fetched rate, so a refund always matches what the buyer
    //      was actually charged for this order.
    const stripeRefundAmount =
      order.checkoutCurrency && order.exchangeRate
        ? Math.round(nativeRefundAmount * order.exchangeRate)
        : nativeRefundAmount;

    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: order.payment.stripePaymentIntentId,
          amount: stripeRefundAmount,
          metadata: {
            orderId,
            adminUserId: adminId,
            nativeAmount: String(nativeRefundAmount),
            nativeCurrency: order.currency,
          },
          reason: (reason as string) === "duplicate" ? "duplicate"
            : (reason as string) === "fraudulent" ? "fraudulent"
            : "requested_by_customer",
        },
        { idempotencyKey: `refund:${orderId}:${nativeRefundAmount}` },
      );

      logger.info("Admin Stripe refund issued", { orderId, refundId: refund.id, nativeAmount: nativeRefundAmount, nativeCurrency: order.currency, stripeAmount: refund.amount, stripeCurrency: refund.currency });
      await prisma.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } });
      await createAuditLog(adminId, orderId, refund.id, nativeRefundAmount, reason);
      return { refundId: refund.id, amount: nativeRefundAmount, currency: order.currency, status: refund.status ?? "unknown", provider: "stripe" };
    } catch (error) {
      logger.error("Stripe refund failed", { orderId, error: error instanceof Error ? error.message : String(error) });
      throw new AppError("Stripe refund failed", 502);
    }
  }

  if (provider === "paystack" || order.paystackTransaction) {
    if (!order.paystackTransaction?.reference) throw new AppError("No Paystack transaction found for this order", 400);
    if (order.paystackTransaction.status !== "SUCCESS") throw new AppError("Can only refund successful Paystack payments", 400);

    try {
      // Paystack transactions are 1:1 with an order (PaystackTransaction.
      // orderId is unique, unlike Stripe's shared-PaymentIntent-per-checkout
      // model) — no normalized/native split applies here, so the amount is
      // already in the right currency/scale as-is.
      const finalAmount = amount ?? order.paystackTransaction.amount;
      await paystack.refundTransaction(order.paystackTransaction.reference, amount);
      logger.info("Admin Paystack refund issued", { orderId, reference: order.paystackTransaction.reference });

      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } });
        await tx.paystackTransaction.update({
          where: { reference: order.paystackTransaction!.reference },
          data: { status: "REVERSED" },
        });
      });

      await createAuditLog(adminId, orderId, order.paystackTransaction.reference, finalAmount, reason);

      // Paystack has no webhook-driven refund confirmation wired up here
      // (unlike Stripe's charge.refunded handler) — this synchronous success
      // is the only confirmation there is, so notify here rather than never.
      notificationsService.enqueue({
        userId: order.buyerId,
        type: NotificationType.ADMIN_BROADCAST,
        title: "Refund processed",
        body: "Your refund has been processed.",
        data: { type: "order_refunded", orderIds: [orderId] },
      }).catch(() => {});

      return { refundId: order.paystackTransaction.reference, amount: finalAmount, currency: order.currency, status: "reversed", provider: "paystack" };
    } catch (error) {
      logger.error("Paystack refund failed", { orderId, error: error instanceof Error ? error.message : String(error) });
      throw new AppError("Paystack refund failed", 502);
    }
  }

  throw new AppError("No payment provider found for this order", 400);
}

/**
 * POST /api/admin/orders/:id/refund
 * Four-eyes gate (architecture doc §7/§17, "high-value refund" is
 * explicitly named): the threshold is configurable via AdminApprovalRule,
 * never hardcoded. With no rule for "order.refund.large", this executes
 * exactly as it always has — the gate only engages once a threshold is
 * deliberately configured.
 */
export async function adminRefundOrder(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);

  const { amount, reason } = request.body as Record<string, unknown>;
  const refundAmount = typeof amount === "number" && amount > 0 ? amount : undefined;

  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { totalAmount: true } });
  const approvalAmount = refundAmount ?? order?.totalAmount ?? null;

  const gated = await adminApprovalsService.requiresApproval("order.refund.large", approvalAmount);
  if (gated) {
    const approval = await adminApprovalsService.requestApproval({
      actionType: "order.refund.large",
      businessRefType: "Order",
      businessRefId: orderId,
      amount: approvalAmount,
      requestedById: request.user.id,
      reason: typeof reason === "string" ? reason : "Order refund requested",
    });
    response.status(202).json({ pendingApproval: approval, message: "This refund requires a second admin's approval before it executes." });
    return;
  }

  const result = await executeOrderRefund(orderId, request.user.id, refundAmount, reason);
  response.status(202).json(result);
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
