import { prisma } from "../../lib/prisma";
import { paystack } from "../../lib/paystack";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";

export interface ResolveDisputeInput {
  resolution: "vendor" | "buyer" | "partial";
  note: string;
  refundAmount?: number;
  fraudulent?: boolean;
}

export const disputeService = {
  /**
   * Buyer opens a dispute on a DISPATCHED escrow order.
   * Freezes the auto-release clock.
   */
  async openDispute(buyerId: string, orderId: string, reason: string): Promise<{ disputeId: string }> {
    if (!reason || reason.trim().length < 5) {
      throw new AppError("Please provide a reason (at least 5 characters)", 400);
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, buyerId: true, vendorId: true, status: true, escrowType: true, orderNumber: true },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (order.buyerId !== buyerId) throw new AppError("Forbidden", 403);
    if (order.escrowType !== "DOMESTIC_AFRICA") throw new AppError("Not an escrow order", 400);

    if (order.status !== "DISPATCHED") {
      throw new AppError("Can only dispute orders that have been dispatched", 400);
    }

    // Check if OTP was already confirmed — if so, transaction is final
    const otp = await prisma.deliveryOtp.findUnique({ where: { orderId } });
    if (otp?.confirmedAt) {
      throw new AppError("Cannot dispute — delivery was already confirmed with the OTP code. Transaction is final.", 400);
    }

    // Check for existing dispute
    const existing = await prisma.dispute.findUnique({ where: { orderId } });
    if (existing) throw new AppError("A dispute already exists for this order", 409);

    const dispute = await prisma.$transaction(async (tx) => {
      // Create dispute
      const d = await tx.dispute.create({
        data: {
          orderId,
          buyerId,
          vendorId: order.vendorId ?? "",
          reason: reason.trim(),
          status: "OPEN",
        },
      });

      // Mark order as DISPUTED (freezes auto-release)
      await tx.order.update({
        where: { id: orderId },
        data: { status: "DISPUTED", disputedAt: new Date() },
      });

      return d;
    });

    // Notify vendor
    if (order.vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { userId: true } });
      if (vendor) {
        await notificationsService.enqueue({
          userId: vendor.userId,
          type: "ORDER_PAID",
          title: "Dispute Opened ⚠️",
          body: `A buyer has raised a dispute for order ${order.orderNumber}. The escrow is frozen until resolved.`,
          data: { orderId, disputeId: dispute.id },
        });
      }
    }

    logger.info("Escrow dispute opened", { orderId, disputeId: dispute.id, buyerId });
    return { disputeId: dispute.id };
  },

  /**
   * Admin lists all disputes (with optional status filter).
   */
  async listDisputes(query: { status?: string; limit: number; cursor?: string }) {
    const where = query.status ? { status: query.status as any } : {};
    const items = await prisma.dispute.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        order: { select: { orderNumber: true, totalAmount: true, currency: true, vendorEarnings: true } },
      },
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },

  /**
   * Admin gets dispute detail.
   */
  async getDispute(disputeId: string) {
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            totalAmount: true,
            vendorEarnings: true,
            currency: true,
            buyerId: true,
            vendorId: true,
            deliveryAddress: true,
            createdAt: true,
            items: { select: { productTitle: true, quantity: true, totalAmount: true } },
          },
        },
      },
    });
    if (!dispute) throw new AppError("Dispute not found", 404);
    return dispute;
  },

  /**
   * Admin resolves a dispute.
   * - "vendor" → release payment to vendor
   * - "buyer" → full refund to buyer
   * - "partial" → partial refund + partial release
   */
  async resolveDispute(disputeId: string, adminId: string, input: ResolveDisputeInput): Promise<{ status: string }> {
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        order: {
          select: {
            id: true,
            buyerId: true,
            vendorId: true,
            totalAmount: true,
            vendorEarnings: true,
            currency: true,
            orderNumber: true,
            paystackTransaction: { select: { reference: true } },
          },
        },
      },
    });

    if (!dispute) throw new AppError("Dispute not found", 404);
    if (dispute.status !== "OPEN") throw new AppError("Dispute is already resolved", 409);

    let resolvedStatus: "RESOLVED_VENDOR" | "RESOLVED_BUYER" | "RESOLVED_PARTIAL";

    await prisma.$transaction(async (tx) => {
      if (input.resolution === "vendor") {
        resolvedStatus = "RESOLVED_VENDOR";

        // Release to vendor — mark order COMPLETED
        await tx.order.update({
          where: { id: dispute.orderId },
          data: { status: "COMPLETED", deliveredAt: new Date() },
        });
      } else if (input.resolution === "buyer") {
        resolvedStatus = "RESOLVED_BUYER";

        // Full refund — mark order REFUNDED
        await tx.order.update({
          where: { id: dispute.orderId },
          data: { status: "REFUNDED" },
        });
      } else {
        resolvedStatus = "RESOLVED_PARTIAL";

        // Partial resolution
        await tx.order.update({
          where: { id: dispute.orderId },
          data: { status: "COMPLETED", deliveredAt: new Date() },
        });
      }

      // Update dispute
      await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: resolvedStatus!,
          resolution: input.note,
          fraudulent: input.fraudulent ?? false,
          refundAmount: input.refundAmount ?? null,
          resolvedById: adminId,
          resolvedAt: new Date(),
        },
      });

      // Trust penalty if fraudulent
      if (input.fraudulent) {
        await tx.user.update({
          where: { id: dispute.buyerId },
          data: { trustScore: { decrement: 20 } },
        });
      }
    });

    // Post-transaction: handle Paystack refund for buyer resolution
    if (input.resolution === "buyer" || (input.resolution === "partial" && input.refundAmount)) {
      const refundRef = dispute.order.paystackTransaction?.reference;
      if (refundRef) {
        try {
          const amount = input.resolution === "buyer" ? undefined : input.refundAmount;
          await paystack.refundTransaction(refundRef, amount);
          logger.info("Dispute refund issued", { disputeId, refundRef, amount });
        } catch (err) {
          logger.error("Dispute refund failed", { disputeId, error: String(err) });
        }
      }
    }

    // If resolved in vendor's favour, initiate payout
    if (input.resolution === "vendor") {
      const { escrowService } = await import("./escrow.service");
      escrowService.initiateVendorPayout(dispute.orderId).catch((err) => {
        logger.error("Dispute vendor payout failed", { disputeId, error: String(err) });
      });
    }

    // Notify both parties
    await notificationsService.enqueue({
      userId: dispute.buyerId,
      type: "ORDER_PAID",
      title: "Dispute Resolved",
      body: `Your dispute for order ${dispute.order.orderNumber} has been resolved.`,
      data: { orderId: dispute.orderId, disputeId },
    });

    if (dispute.order.vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: dispute.order.vendorId }, select: { userId: true } });
      if (vendor) {
        await notificationsService.enqueue({
          userId: vendor.userId,
          type: "ORDER_PAID",
          title: "Dispute Resolved",
          body: `Dispute for order ${dispute.order.orderNumber} has been resolved.`,
          data: { orderId: dispute.orderId, disputeId },
        });
      }
    }

    logger.info("Dispute resolved", { disputeId, resolution: input.resolution, adminId });
    return { status: resolvedStatus! };
  },
};
