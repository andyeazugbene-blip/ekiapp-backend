import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { launchSettingsService } from "../admin/launch-settings.service";
import { adminPlatformSettingsService } from "../admin/admin-platform-settings.service";
import { EVENT_NAMES, eventsService } from "../events/events.service";
import { notificationsService } from "../notifications/notifications.service";

type ReferralStage = "Account created" | "Verified" | "Store ready" | "Paid" | "Reversed";

async function billingCustomer(vendorId: string | undefined): Promise<string | null> {
  if (!vendorId) return null;
  const subscription = await prisma.vendorSubscription.findUnique({ where: { vendorId }, select: { stripeCustomerId: true } });
  return subscription?.stripeCustomerId ?? null;
}

/**
 * Handbook 8.6: a duplicate business or payment method can't earn a credit.
 * A check that can't run returns null, because an admin approves every release anyway.
 */
export async function suspiciousReferralReason(referrerId: string, referredUserId: string): Promise<string | null> {
  try {
    const [referrer, referred] = await Promise.all([
      prisma.user.findUnique({ where: { id: referrerId }, select: { phone: true, vendor: { select: { id: true, contactEmail: true } } } }),
      prisma.user.findUnique({ where: { id: referredUserId }, select: { phone: true, vendor: { select: { id: true, contactEmail: true } } } }),
    ]);
    if (referrer?.phone && referrer.phone === referred?.phone) return "same_phone";
    const email = referrer?.vendor?.contactEmail?.toLowerCase();
    if (email && email === referred?.vendor?.contactEmail?.toLowerCase()) return "same_business_email";
    const [a, b] = await Promise.all([billingCustomer(referrer?.vendor?.id), billingCustomer(referred?.vendor?.id)]);
    if (a && b) {
      const [mine, theirs] = await Promise.all([
        stripe.paymentMethods.list({ customer: a, type: "card", limit: 10 }),
        stripe.paymentMethods.list({ customer: b, type: "card", limit: 10 }),
      ]);
      const fingerprints = new Set(mine.data.map((m) => m.card?.fingerprint).filter(Boolean));
      if (theirs.data.some((m) => m.card?.fingerprint && fingerprints.has(m.card.fingerprint))) return "same_payment_method";
    }
    return null;
  } catch (error) {
    logger.warn("Vendor referral checks couldn't complete", { referredUserId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export const vendorReferralsService = {
  /** Called once a referred vendor qualifies. Never throws: the payment that triggered it must not fail over this. */
  async recordQualified(referralId: string, referrerId: string, referredUserId: string, referredVendorId: string) {
    try {
      await prisma.vendorReferralCredit.upsert({
        where: { referredUserId },
        create: { referralId, referrerId, referredUserId, referredVendorId, status: "QUALIFIED", qualifiedAt: new Date() },
        update: {},
      });
      eventsService.emit({ name: EVENT_NAMES.referral_qualified, actorType: "system", entityType: "Referral", entityId: referralId, source: "api", payload: { referrerId, referredVendorId } });
    } catch (error) {
      logger.error("Could not record a vendor referral credit", { referralId, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async recordRejected(referralId: string, referrerId: string, referredUserId: string, referredVendorId: string, reason: string) {
    await prisma.vendorReferralCredit.upsert({
      where: { referredUserId },
      create: { referralId, referrerId, referredUserId, referredVendorId, status: "REVERSED", reversedAt: new Date(), reversalReason: reason },
      update: {},
    }).catch((error: unknown) => logger.error("Could not record a rejected referral", { referralId, error: String(error) }));
  },

  /** What a vendor sees: their code, who's progressing, and how close the next credit is. */
  async overview(vendorUserId: string) {
    const user = await prisma.user.findUnique({ where: { id: vendorUserId }, select: { referralCode: true, vendor: { select: { id: true } } } });
    if (!user?.vendor) throw new AppError("Vendor profile required", 403);
    const [referrals, credits, needed, months, completedSale] = await Promise.all([
      prisma.referral.findMany({ where: { referrerId: vendorUserId }, orderBy: { createdAt: "desc" }, take: 100, select: { referredId: true, createdAt: true } }),
      prisma.vendorReferralCredit.findMany({ where: { referrerId: vendorUserId }, select: { referredUserId: true, status: true } }),
      launchSettingsService.get("REFERRALS_FOR_FREE_MONTH"),
      adminPlatformSettingsService.getValue("VENDOR_REFERRAL_CREDIT_MONTHS"),
      prisma.orderItem.count({ where: { vendorId: user.vendor.id, order: { payment: { status: "SUCCEEDED" } } } }),
    ]);
    const referredVendors = await prisma.vendor.findMany({
      where: { userId: { in: referrals.map((r) => r.referredId) } },
      select: { userId: true, storeName: true, verificationStatus: true, _count: { select: { products: { where: { isActive: true } } } } },
    });
    const vendorByUser = new Map(referredVendors.map((v) => [v.userId, v]));
    const creditByUser = new Map(credits.map((c) => [c.referredUserId, c.status]));
    const rows = referrals.map((r): { storeName: string | null; stage: ReferralStage; joinedAt: Date } => {
      const vendor = vendorByUser.get(r.referredId);
      const credit = creditByUser.get(r.referredId);
      const stage: ReferralStage = credit === "REVERSED" ? "Reversed"
        : credit ? "Paid"
        : vendor && vendor._count.products > 0 ? "Store ready"
        : vendor?.verificationStatus === "VERIFIED" ? "Verified"
        : "Account created";
      return { storeName: vendor?.storeName ?? null, stage, joinedAt: r.createdAt };
    });
    const qualified = credits.filter((c) => c.status === "QUALIFIED").length;
    return {
      referralCode: user.referralCode,
      // Handbook: prompt only after credible value, such as a completed sale.
      promptReady: completedSale > 0,
      qualifiedTowardsNext: qualified % needed,
      needed,
      monthsPerCredit: months ?? 0,
      creditsReadyForReview: Math.floor(qualified / needed),
      monthsReleased: credits.filter((c) => c.status === "RELEASED").length > 0 ? Math.floor(credits.filter((c) => c.status === "RELEASED").length / needed) * (months ?? 0) : 0,
      referrals: rows,
    };
  },

  async listForAdmin() {
    const credits = await prisma.vendorReferralCredit.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    const ids = [...new Set(credits.flatMap((c) => [c.referrerId, c.referredUserId]))];
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, isTest: true, vendor: { select: { storeName: true } } } });
    const byId = new Map(users.map((u) => [u.id, u]));
    const needed = await launchSettingsService.get("REFERRALS_FOR_FREE_MONTH");
    const label = (id: string) => byId.get(id)?.vendor?.storeName ?? byId.get(id)?.name ?? "Unknown";
    const counts = new Map<string, number>();
    for (const c of credits) if (c.status === "QUALIFIED") counts.set(c.referrerId, (counts.get(c.referrerId) ?? 0) + 1);
    return {
      needed,
      due: [...counts.entries()].filter(([, count]) => count >= needed).map(([referrerId, count]) => ({ referrerId, referrer: label(referrerId), qualified: count })),
      credits: credits.map((c) => ({
        id: c.id, status: c.status, referrer: label(c.referrerId), referred: label(c.referredUserId), qualifiedAt: c.qualifiedAt, releasedAt: c.releasedAt, reversedAt: c.reversedAt, reversalReason: c.reversalReason, amountMinor: c.amountMinor, currency: c.currency, isTest: byId.get(c.referrerId)?.isTest ?? false,
      })),
    };
  },

  /**
   * Turns a full set of qualified referrals into a credit on the referrer's
   * next invoice. It's a Stripe customer balance credit, so it can never be paid
   * out as cash. An admin approves each one, because this moves real money.
   */
  async release(adminId: string, referrerId: string, reason: string) {
    const needed = await launchSettingsService.get("REFERRALS_FOR_FREE_MONTH");
    const months = (await adminPlatformSettingsService.getValue("VENDOR_REFERRAL_CREDIT_MONTHS")) ?? 0;
    if (months <= 0) throw new AppError("Set the referral credit months first.", 409, undefined, "CREDIT_MONTHS_NOT_SET");
    const batch = await prisma.vendorReferralCredit.findMany({ where: { referrerId, status: "QUALIFIED" }, orderBy: { qualifiedAt: "asc" }, take: needed, select: { id: true } });
    if (batch.length < needed) throw new AppError(`This vendor needs ${needed} qualified referrals.`, 409, undefined, "NOT_ENOUGH_REFERRALS");
    const referrerUser = await prisma.user.findUnique({ where: { id: referrerId }, select: { isTest: true } });
    if (referrerUser?.isTest) throw new AppError("Demo accounts can't receive real credit.", 409, undefined, "DEMO_ACCOUNT");
    const vendor = await prisma.vendor.findUnique({ where: { userId: referrerId }, select: { id: true } });
    const subscription = vendor ? await prisma.vendorSubscription.findUnique({ where: { vendorId: vendor.id }, select: { stripeCustomerId: true, sellerPlan: { select: { monthlyPriceCents: true, currency: true } } } }) : null;
    const customer = subscription?.stripeCustomerId;
    const plan = subscription?.sellerPlan;
    if (!customer || !plan || plan.monthlyPriceCents <= 0) {
      throw new AppError("This vendor has no paid plan to credit yet.", 409, undefined, "NO_BILLING_ACCOUNT");
    }
    const ids = batch.map((c) => c.id);
    const total = plan.monthlyPriceCents * months;
    // Claim first, so two admins can't release the same referrals.
    const claim = await prisma.vendorReferralCredit.updateMany({
      where: { id: { in: ids }, status: "QUALIFIED" },
      data: { status: "RELEASED", releasedAt: new Date(), releasedById: adminId, amountMinor: Math.floor(total / needed), currency: plan.currency },
    });
    if (claim.count !== ids.length) {
      await prisma.vendorReferralCredit.updateMany({ where: { id: { in: ids }, releasedById: adminId, status: "RELEASED" }, data: { status: "QUALIFIED", releasedAt: null, releasedById: null, amountMinor: null, currency: null } });
      throw new AppError("These referrals have just changed. Refresh and try again.", 409, undefined, "CREDIT_CHANGED");
    }
    try {
      const balance = await stripe.customers.createBalanceTransaction(
        customer,
        { amount: -total, currency: plan.currency.toLowerCase(), description: `Eki referral credit: ${months} month(s)`, metadata: { referrerId, creditIds: ids.join(",") } },
        { idempotencyKey: `referral-release:${[...ids].sort().join(":")}` },
      );
      await prisma.vendorReferralCredit.updateMany({ where: { id: { in: ids } }, data: { stripeBalanceTransactionId: balance.id } });
    } catch (error) {
      await prisma.vendorReferralCredit.updateMany({ where: { id: { in: ids } }, data: { status: "QUALIFIED", releasedAt: null, releasedById: null, amountMinor: null, currency: null } });
      throw new AppError(error instanceof Error ? `Stripe refused the credit: ${error.message}` : "Stripe refused the credit.", 502, undefined, "CREDIT_NOT_APPLIED");
    }
    await recordAudit({ actorId: adminId, action: "vendor_referral_credit.released", entityType: "User", entityId: referrerId, reason, metadata: { ids, total, currency: plan.currency }, failClosed: true });
    eventsService.emit({ name: EVENT_NAMES.reward_released, actorType: "admin", actorId: adminId, entityType: "User", entityId: referrerId, source: "api", payload: { total, currency: plan.currency } });
    await notificationsService.enqueue({
      userId: referrerId,
      type: "ADMIN_BROADCAST",
      title: "Your referral credit is ready",
      body: `We've added ${months} month(s) of credit to your Eki Membership. It comes off your next invoice.`,
      data: { type: "vendor_referral", event: "credit_released" } as never,
      dedupeKey: `referral-release:${ids[0]}`,
    }).catch(() => undefined);
    return { released: ids.length, total, currency: plan.currency };
  },

  /** Handbook 8.6: credits reverse when qualification reverses. A released share goes back on the next invoice. */
  async reverse(adminId: string, creditId: string, reason: string) {
    const credit = await prisma.vendorReferralCredit.findUnique({ where: { id: creditId } });
    if (!credit) throw new AppError("Credit not found", 404);
    if (credit.status === "REVERSED") throw new AppError("This credit is already reversed.", 409, undefined, "ALREADY_REVERSED");
    if (credit.status === "RELEASED" && credit.amountMinor && credit.currency) {
      const vendor = await prisma.vendor.findUnique({ where: { userId: credit.referrerId }, select: { id: true } });
      const customer = await billingCustomer(vendor?.id);
      if (!customer) throw new AppError("This vendor's billing account is missing, so the credit can't be taken back.", 409, undefined, "NO_BILLING_ACCOUNT");
      await stripe.customers.createBalanceTransaction(
        customer,
        { amount: credit.amountMinor, currency: credit.currency.toLowerCase(), description: "Eki referral credit reversed" },
        { idempotencyKey: `referral-reverse:${creditId}` },
      );
    }
    const updated = await prisma.vendorReferralCredit.update({ where: { id: creditId }, data: { status: "REVERSED", reversedAt: new Date(), reversalReason: reason } });
    await recordAudit({ actorId: adminId, action: "vendor_referral_credit.reversed", entityType: "VendorReferralCredit", entityId: creditId, reason, beforeState: { status: credit.status }, afterState: { status: "REVERSED" }, failClosed: true });
    eventsService.emit({ name: EVENT_NAMES.reward_reversed, actorType: "admin", actorId: adminId, entityType: "VendorReferralCredit", entityId: creditId, source: "api", payload: { reason } });
    return updated;
  },
};
