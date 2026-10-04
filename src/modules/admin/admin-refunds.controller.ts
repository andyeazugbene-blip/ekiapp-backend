import type { Request, Response } from "express";
import { NotificationType, RefundStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { paystack } from "../../lib/paystack";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { adminApprovalsService } from "./admin-approvals.service";
import { notificationsService } from "../notifications/notifications.service";
import { recordAudit } from "../../shared/utils/audit";

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
export async function executeOrderRefund(
  orderId: string,
  adminId: string,
  amount: number | undefined,
  reason: unknown,
  // Defaults to REFUNDED for the admin-initiated path (unchanged behavior).
  // A vendor cancelling their own paid order (orders.service.ts
  // updateVendorOrderStatus, Defect C) passes "CANCELLED" instead — the
  // money movement is identical either way, only the resulting order label
  // differs to match what actually initiated it.
  finalStatus: "REFUNDED" | "CANCELLED" = "REFUNDED",
  // Phase 4.1: Order.status "DISPUTED" is set by TWO independent
  // mechanisms that both reuse the same status value — a buyer-app dispute
  // (dispute.service.ts's Dispute model) and a Stripe/bank-initiated
  // chargeback (stripe.service.ts's StripeDispute model, handleDisputeCreated).
  // The guard below exists to stop a Stripe chargeback's outcome being
  // double-processed by a manual admin refund on top of it. It must NOT
  // stop dispute.service.ts's own resolveDispute() from calling this
  // function to actually RESOLVE the buyer-app dispute that put the order
  // into DISPUTED in the first place — that's the one legitimate caller
  // allowed to refund a DISPUTED order, so it explicitly opts in here.
  allowDisputedOrder = false,
  // Handbook 5.2 L214: audit with IP/permission, and honour a client-supplied
  // idempotency key so a double-click can never create two refunds.
  request?: Request,
  clientIdempotencyKey?: string,
): Promise<OrderRefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payment: { select: { id: true, stripePaymentIntentId: true, status: true, amount: true, provider: true } },
      paystackTransaction: { select: { reference: true, status: true, amount: true } },
    },
  });

  if (!order) throw new AppError("Order not found", 404);
  // Both terminal states mean the money has already been (or is already
  // being) returned — refunding a second time would double-refund.
  if (order.status === "REFUNDED" || order.status === "CANCELLED") {
    throw new AppError("Order already refunded or cancelled", 409);
  }
  // A disputed order's outcome is decided by Stripe/the card network, not
  // by an ad-hoc admin refund — issuing one on top of an open chargeback
  // would double-process the same money movement. Wait for
  // charge.dispute.closed to resolve the order first. (dispute.service.ts's
  // own resolution flow is exempt — see allowDisputedOrder above.)
  if (order.status === "DISPUTED" && !allowDisputedOrder) {
    throw new AppError("This order has an open Stripe dispute — resolve the dispute first, refunds are blocked while it's open", 409);
  }

  // The admin always enters an amount in the ORDER's OWN native currency —
  // order.currency, order.totalAmount — the same currency every other
  // figure for this order is shown in everywhere else in the admin UI.
  // Never accept or infer an amount already expressed in the checkout/
  // PaymentIntent currency; that ambiguity is exactly what let a
  // normalized-vs-native mismatch silently reach Stripe.
  if (amount !== undefined && (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0)) {
    throw new AppError("Refund amount must be a positive integer (minor units) in the order's own currency", 400);
  }
  // Cumulative cap (Handbook 14.8 / B4): earlier partial refunds count against
  // the order total. Previously the cap compared only to the full total and a
  // single partial refund closed the order to every later refund.
  const [refundSum, refundCount] = await Promise.all([
    prisma.refund.aggregate({
      where: { orderId, status: { in: [RefundStatus.REQUESTED, RefundStatus.PROCESSING, RefundStatus.COMPLETED] } },
      _sum: { amountMinor: true },
    }),
    prisma.refund.count({ where: { orderId } }),
  ]);
  const alreadyRefunded = refundSum._sum.amountMinor ?? 0;
  const remaining = order.totalAmount - alreadyRefunded;
  if (remaining <= 0) {
    throw new AppError("This order has already been fully refunded", 409);
  }
  if (amount !== undefined && amount > remaining) {
    throw new AppError(`Refund amount cannot exceed the remaining refundable amount (${remaining} minor units)`, 400);
  }
  const refundReason = String(reason ?? "").trim();

  const provider = order.payment?.provider ?? (order.paystackTransaction ? "paystack" : "stripe");

  if (provider === "stripe") {
    if (!order.payment?.stripePaymentIntentId) throw new AppError("No Stripe payment found for this order", 400);
    if (order.payment.status !== "SUCCEEDED") throw new AppError("Can only refund succeeded payments", 400);

    const nativeRefundAmount = amount ?? remaining;
    const idempotencyKey = clientIdempotencyKey?.trim() || `refund:${orderId}:${nativeRefundAmount}:${refundCount}`;

    // Persist the request FIRST so a crash after the Stripe call can never
    // leave money moved with no record, and so a replay is recognised.
    let refundRow;
    try {
      refundRow = await prisma.refund.create({
        data: {
          orderId, amountMinor: nativeRefundAmount, currency: order.currency, status: RefundStatus.REQUESTED,
          provider: "stripe", reason: refundReason || "No reason recorded", idempotencyKey, actorId: adminId,
        },
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "P2002") {
        const existing = await prisma.refund.findUnique({ where: { idempotencyKey } });
        if (existing && existing.status !== RefundStatus.FAILED) {
          return {
            refundId: existing.providerRefundId ?? existing.id, amount: existing.amountMinor, currency: existing.currency,
            status: existing.status.toLowerCase(), provider: "stripe",
          };
        }
        throw new AppError("This refund request was already made and failed. Start a new refund.", 409);
      }
      throw error;
    }

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
          // Free-text reason (now mandatory) maps onto Stripe's fixed enum by keyword.
          reason: /duplicate/i.test(refundReason) ? "duplicate"
            : /fraud/i.test(refundReason) ? "fraudulent"
            : "requested_by_customer",
        },
        { idempotencyKey },
      );

      logger.info("Admin Stripe refund issued", { orderId, refundId: refund.id, nativeAmount: nativeRefundAmount, nativeCurrency: order.currency, stripeAmount: refund.amount, stripeCurrency: refund.currency });
      const mapped: RefundStatus =
        refund.status === "succeeded" ? RefundStatus.COMPLETED
        : refund.status === "failed" || refund.status === "canceled" ? RefundStatus.FAILED
        : RefundStatus.PROCESSING;
      await prisma.refund.update({ where: { id: refundRow.id }, data: { providerRefundId: refund.id, status: mapped } });

      // Only a refund that brings the cumulative total to the full order
      // closes the order; a partial refund leaves it open for further ones.
      const fullyRefunded = alreadyRefunded + nativeRefundAmount >= order.totalAmount && mapped !== RefundStatus.FAILED;
      if (fullyRefunded) {
        await prisma.order.update({ where: { id: orderId }, data: { status: finalStatus } });
      }
      await recordAudit({
        actorId: adminId,
        action: "ORDER_REFUNDED",
        entityType: "Order",
        entityId: orderId,
        reason: refundReason || undefined,
        beforeState: { orderStatus: order.status, refundedMinor: alreadyRefunded },
        afterState: { orderStatus: fullyRefunded ? finalStatus : order.status, refundedMinor: alreadyRefunded + nativeRefundAmount, providerStatus: refund.status },
        metadata: { refundId: refund.id, refundRowId: refundRow.id, amount: nativeRefundAmount, reason: refundReason },
        request,
        failClosed: true,
      });
      return { refundId: refund.id, amount: nativeRefundAmount, currency: order.currency, status: refund.status ?? "unknown", provider: "stripe" };
    } catch (error) {
      await prisma.refund.update({
        where: { id: refundRow.id },
        data: { status: RefundStatus.FAILED, failureReason: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" },
      }).catch(() => undefined);
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
      await prisma.refund.create({
        data: {
          orderId, amountMinor: finalAmount, currency: order.currency, status: RefundStatus.COMPLETED, provider: "paystack",
          providerRefundId: order.paystackTransaction.reference, reason: refundReason || "No reason recorded",
          idempotencyKey: clientIdempotencyKey?.trim() || `refund:${orderId}:${finalAmount}:${refundCount}`, actorId: adminId,
        },
      });
      await paystack.refundTransaction(order.paystackTransaction.reference, amount);
      logger.info("Admin Paystack refund issued", { orderId, reference: order.paystackTransaction.reference });

      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: orderId }, data: { status: finalStatus } });
        await tx.paystackTransaction.update({
          where: { reference: order.paystackTransaction!.reference },
          data: { status: "REVERSED" },
        });
      });

      await recordAudit({
        actorId: adminId, action: "ORDER_REFUNDED", entityType: "Order", entityId: orderId,
        reason: refundReason || undefined,
        beforeState: { orderStatus: order.status }, afterState: { orderStatus: finalStatus },
        metadata: { refundId: order.paystackTransaction.reference, amount: finalAmount, reason: refundReason },
        request, failClosed: true,
      });

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

  const { amount, reason, idempotencyKey } = request.body as Record<string, unknown>;
  const refundAmount = typeof amount === "number" && amount > 0 ? amount : undefined;
  // Handbook 5.2 L214: a refund needs a recorded reason - enforced here, not just in the UI.
  if (typeof reason !== "string" || reason.trim().length < 10) {
    throw new AppError("A refund reason of at least 10 characters is required", 400);
  }

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

  const result = await executeOrderRefund(
    orderId, request.user.id, refundAmount, reason, "REFUNDED", false, request,
    typeof idempotencyKey === "string" ? idempotencyKey : request.header("idempotency-key") ?? undefined,
  );
  response.status(202).json(result);
}

interface AdminRefundListItem {
  id: string;
  orderId: string;
  orderNumber: string;
  buyerName: string | null;
  buyerEmail: string | null;
  vendorName: string | null;
  amount: number | null;
  currency: string | null;
  reason: string | null;
  status: "REQUESTED" | "PROCESSING" | "REJECTED" | "COMPLETED" | "FAILED";
  requestedBy: { id: string; name: string; email: string } | null;
  decidedBy: { id: string; name: string; email: string } | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/**
 * GET /api/admin/refunds — real refund history, not a client-side guess
 * built from the generic order list. Two genuine sources, never fabricated:
 *
 *  - AuditLog rows with action "ORDER_REFUNDED" — written by
 *    executeOrderRefund() the moment a refund ACTUALLY succeeds against
 *    the provider, whether it went through the four-eyes flow or executed
 *    directly. This is the real "COMPLETED" list, with the real refunded
 *    amount (not the order's full total, which would be wrong for a
 *    partial refund).
 *  - AdminApproval rows for actionType "order.refund.large" that are
 *    still PENDING (requested, awaiting a second admin) or REJECTED
 *    (declined, never executed). An APPROVED approval that has actually
 *    executed is already covered by the AuditLog row above — including it
 *    again here would double-count the same refund.
 */
export async function adminListOrderRefunds(_request: Request, response: Response): Promise<void> {
  const [refundRows, completedLogsAll, openApprovals] = await Promise.all([
    prisma.refund.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.auditLog.findMany({
      where: { action: "ORDER_REFUNDED" },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.adminApproval.findMany({
      where: { actionType: "order.refund.large", status: { in: ["PENDING", "REJECTED"] } },
      include: {
        requestedBy: { select: { id: true, name: true, email: true } },
        decidedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  // Refunds made before the Refund table existed have only an audit row; rows
  // that carry a refundRowId are already represented by the Refund table.
  const completedLogs = completedLogsAll.filter((l) => !(l.metadata as { refundRowId?: string } | null)?.refundRowId);
  const orderIds = [...new Set([
    ...refundRows.map((r) => r.orderId),
    ...completedLogs.map((l) => l.entityId).filter((id): id is string => !!id),
    ...openApprovals.map((a) => a.businessRefId),
  ])];
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true, orderNumber: true, currency: true, vendorId: true,
      buyer: { select: { name: true, email: true } },
    },
  });
  // Order has no direct `vendor` relation (only the scalar vendorId) —
  // resolve store names in one batched lookup instead.
  const vendorIds = [...new Set(orders.map((o) => o.vendorId).filter((id): id is string => !!id))];
  const vendors = await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, storeName: true } });
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.storeName]));
  const orderById = new Map(orders.map((o) => [o.id, { ...o, vendorName: o.vendorId ? vendorNameById.get(o.vendorId) ?? null : null }]));

  const actorIds = [...new Set(refundRows.map((r) => r.actorId))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const items: AdminRefundListItem[] = [
    ...refundRows.map((r): AdminRefundListItem => {
      const order = orderById.get(r.orderId);
      return {
        id: r.id,
        orderId: r.orderId,
        orderNumber: order?.orderNumber ?? r.orderId,
        buyerName: order?.buyer?.name ?? null,
        buyerEmail: order?.buyer?.email ?? null,
        vendorName: order?.vendorName ?? null,
        amount: r.amountMinor,
        currency: r.currency,
        reason: r.reason,
        status: r.status === "COMPLETED" ? "COMPLETED" : r.status === "FAILED" ? "FAILED" : r.status === "PROCESSING" ? "PROCESSING" : "REQUESTED",
        requestedBy: actorById.get(r.actorId) ?? null,
        decidedBy: null,
        createdAt: r.createdAt,
        decidedAt: r.status === "COMPLETED" || r.status === "FAILED" ? r.updatedAt : null,
      };
    }),
    ...completedLogs
      .filter((log) => log.entityId)
      .map((log): AdminRefundListItem => {
        const order = orderById.get(log.entityId!);
        const metadata = (log.metadata as { amount?: number; reason?: string } | null) ?? null;
        return {
          id: log.id,
          orderId: log.entityId!,
          orderNumber: order?.orderNumber ?? log.entityId!,
          buyerName: order?.buyer?.name ?? null,
          buyerEmail: order?.buyer?.email ?? null,
          vendorName: order?.vendorName ?? null,
          amount: metadata?.amount ?? null,
          currency: order?.currency ?? null,
          reason: metadata?.reason || null,
          status: "COMPLETED",
          requestedBy: null,
          decidedBy: null,
          createdAt: log.createdAt,
          decidedAt: log.createdAt,
        };
      }),
    ...openApprovals.map((approval): AdminRefundListItem => {
      const order = orderById.get(approval.businessRefId);
      return {
        id: approval.id,
        orderId: approval.businessRefId,
        orderNumber: order?.orderNumber ?? approval.businessRefId,
        buyerName: order?.buyer?.name ?? null,
        buyerEmail: order?.buyer?.email ?? null,
        vendorName: order?.vendorName ?? null,
        amount: approval.amount,
        currency: approval.currency ?? order?.currency ?? null,
        reason: approval.reason,
        status: approval.status === "PENDING" ? "REQUESTED" : "REJECTED",
        requestedBy: approval.requestedBy,
        decidedBy: approval.decidedBy,
        createdAt: approval.createdAt,
        decidedAt: approval.decidedAt,
      };
    }),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const counts = {
    processing: items.filter((i) => i.status === "PROCESSING").length,
    failed: items.filter((i) => i.status === "FAILED").length,
    requested: items.filter((i) => i.status === "REQUESTED").length,
    rejected: items.filter((i) => i.status === "REJECTED").length,
    completed: items.filter((i) => i.status === "COMPLETED").length,
  };

  response.status(200).json({ items, counts });
}
