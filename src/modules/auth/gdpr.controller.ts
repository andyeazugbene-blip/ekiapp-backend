import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";

/**
 * GET /api/me/data-export
 * GDPR Article 20 — Right to data portability.
 * Returns all personal data associated with the authenticated user.
 */
export async function dataExport(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);

  const user = await prisma.user.findUnique({
    where: { id: request.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      country: true,
      role: true,
      referralCode: true,
      createdAt: true,
      orders: {
        select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
      notifications: {
        select: { id: true, type: true, title: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
    },
  });

  if (!user) throw new AppError("User not found", 404);

  response.status(200).json({
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      country: user.country,
      role: user.role,
      referralCode: user.referralCode,
      createdAt: user.createdAt,
    },
    orders: user.orders,
    notifications: user.notifications,
  });
}

// Campaign states where the organiser still has live obligations to
// participants who pledged real money — deletion must not be able to
// abandon a campaign mid-flight. Terminal/pre-commitment states are fine.
const IN_FLIGHT_CAMPAIGN_STATUSES = [
  "UNDER_REVIEW", "APPROVED", "LIVE", "PAUSED", "CLOSING", "RESCUE_WINDOW", "FULFILLING", "REFUNDING",
] as const;

// A subscription in any of these states either renews on its own schedule or
// is one buyer action away from doing so — all must stop before the saved
// card that funds them is detached, or a renewal attempt would be left
// pointing at a payment method that no longer exists.
const CANCELABLE_SUBSCRIPTION_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "PAYMENT_ATTENTION"] as const;

/**
 * POST /api/me/delete-account
 * GDPR Article 17 — Right to erasure. Apple App Review Guideline 5.1.1(v) —
 * account deletion must be real, not cosmetic: it must not leave active
 * recurring billing running, a live public vendor storefront, or an
 * in-flight fundraising campaign behind an account that looks deleted.
 * Anonymizes user data; retains financial Order/Payment records for legal
 * compliance (never deleted, only disassociated from identifying info).
 */
export async function deleteAccount(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);

  const userId = request.user.id;

  // Check for pending orders that block deletion
  const pendingOrders = await prisma.order.count({
    where: { buyerId: userId, status: { in: ["PENDING", "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED"] } },
  });

  if (pendingOrders > 0) {
    throw new AppError("Cannot delete account with pending orders. Please wait for all orders to complete.", 400);
  }

  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  if (vendor) {
    const pendingPayouts = await prisma.payoutRequest.count({
      where: { vendorId: vendor.id, status: { in: ["PENDING", "APPROVED"] } },
    });
    if (pendingPayouts > 0) {
      throw new AppError("Cannot delete account with a payout still pending. Please wait for it to be paid out first.", 400);
    }
  }

  const organiserProfile = await prisma.organiserProfile.findUnique({ where: { userId }, select: { id: true } });
  if (organiserProfile) {
    const inFlightCampaigns = await prisma.communityCampaign.count({
      where: { organiserId: organiserProfile.id, status: { in: [...IN_FLIGHT_CAMPAIGN_STATUSES] } },
    });
    if (inFlightCampaigns > 0) {
      throw new AppError("Cannot delete account while a Community Buy campaign you organise is still active. Close or complete it first.", 400);
    }
  }

  // A pledge is a real financial commitment even before it's charged
  // (PLEDGE_THEN_CHARGE) — deleting the account out from under one would
  // silently detach its saved payment method (below), so a later
  // attemptCharge() would fail terminally with no way to notify the
  // (already-anonymized) buyer. Block deletion until it resolves, same as
  // a pending order.
  const unresolvedPledges = await prisma.campaignContribution.count({
    where: { participant: { userId }, status: { in: ["PLEDGED", "PAYMENT_PROCESSING"] } },
  });
  if (unresolvedPledges > 0) {
    throw new AppError("Cannot delete account with an active Community Buy pledge. Wait for the campaign to close, or withdraw your pledge first.", 400);
  }

  // Stripe detach is an external API call — read which payment methods exist
  // before the transaction, detach them after it commits (best-effort, same
  // pattern as payment-methods.service.ts's remove()).
  const paymentMethods = await prisma.buyerPaymentMethod.findMany({
    where: { buyerId: userId },
    select: { stripePaymentMethodId: true },
  });

  await prisma.$transaction(async (tx) => {
    // Stop future recurring charges (Regular Deliveries) before the saved
    // card that funds them is removed — a "deleted" account must not keep
    // getting charged.
    await tx.buyerSubscription.updateMany({
      where: { buyerId: userId, status: { in: [...CANCELABLE_SUBSCRIPTION_STATUSES] } },
      data: { status: "CANCELLED", cancelledAt: new Date(), pausedUntil: null, nextRenewalAt: null },
    });

    await tx.buyerPaymentMethod.deleteMany({ where: { buyerId: userId } });

    // Remove OAuth identity links — otherwise a later "Sign in with Apple/
    // Google" using the same provider account would silently log back into
    // this anonymized account instead of starting fresh.
    await tx.oAuthIdentity.deleteMany({ where: { userId } });

    // A vendor "deleting their account" must not leave their public
    // storefront live and discoverable.
    if (vendor) {
      await tx.vendor.update({ where: { id: vendor.id }, data: { isSuspended: true } });
      await tx.product.updateMany({ where: { vendorId: vendor.id, isActive: true }, data: { isActive: false } });
    }

    // Anonymize user data (retain financial records for legal compliance)
    await tx.user.update({
      where: { id: userId },
      data: {
        email: `deleted_${userId}@anonymized.local`,
        name: "Deleted User",
        phone: null,
        avatar: null,
        country: null,
        referralCode: null,
        password: "ACCOUNT_DELETED",
        tokenVersion: { increment: 1 }, // Invalidate all tokens
      },
    });

    // Delete non-financial personal data
    await tx.notification.deleteMany({ where: { userId } });
    await tx.pushToken.deleteMany({ where: { userId } });
  });

  for (const pm of paymentMethods) {
    await stripe.paymentMethods.detach(pm.stripePaymentMethodId).catch(() => {});
  }

  response.status(200).json({ message: "Account data has been anonymized. Financial records retained per legal requirements." });
}
