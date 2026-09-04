import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/**
 * Admin-facing read/resolve surface for the StripeDispute rows
 * stripe.service.ts's handleDisputeCreated() writes on charge.dispute.created
 * — architecture doc §15.3 "Chargebacks" queue. Real Stripe chargebacks are
 * still won/lost in the Stripe Dashboard directly (evidence submission is
 * out of scope here); this only tracks that a chargeback exists and lets an
 * admin mark it as reviewed/noted so it drops off the open queue.
 */
export const stripeDisputesService = {
  async list(status?: string, limit = 100) {
    return prisma.stripeDispute.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
  },

  async markReviewed(id: string, note: string) {
    const existing = await prisma.stripeDispute.findUnique({ where: { id } });
    if (!existing) throw new AppError("Stripe dispute not found", 404);
    if (existing.resolvedAt) return existing; // idempotent — already reviewed
    return prisma.stripeDispute.update({
      where: { id },
      data: { resolvedAt: new Date(), note },
    });
  },
};
