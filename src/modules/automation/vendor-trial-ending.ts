import type Stripe from "stripe";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { automationService } from "./automation.service";

/** Vendor free trial length in days (single source: subscriptions.service GROWTH_TRIAL_DAYS = 14). */
export const VENDOR_TRIAL_DAYS = 14;

function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Stripe's `trial_will_end` webhook arrives three days before trial end, which
 * cannot satisfy R30's seven-day requirement. The webhook is deliberately a
 * no-op; the daily detector below uses the persisted current trial end instead.
 */
export async function notifyVendorTrialEnding(stripeSubscription: Stripe.Subscription): Promise<"notified" | "ignored"> {
  logger.info("Ignoring Stripe trial_will_end for R30; the seven-day reminder is driven by persisted trialEndsAt", {
    stripeSubscriptionId: stripeSubscription.id,
  });
  return "ignored";
}

/**
 * R30 due-time detector. Re-reading the current subscription on every run
 * means cancellation, renewal, and a changed trial end automatically replace
 * stale scheduling data. AutomationRun's unique type/subject key makes repeat
 * sweeps and duplicate webhook events harmless.
 */
export async function detectVendorTrialEnding(now = new Date()): Promise<number> {
  if (process.env.R30_TRIAL_ENDING_ENABLED !== "true") return 0;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const trialEndsBy = new Date(now.getTime() + sevenDays);
  const subscriptions = await prisma.vendorSubscription.findMany({
    where: {
      status: "ACTIVE",
      plan: { not: "FREE" },
      cancelledAt: null,
      trialStartedAt: { not: null },
      trialEndsAt: { gt: now, lte: trialEndsBy },
    },
    select: {
      id: true, vendorId: true, plan: true, trialEndsAt: true,
      sellerPlan: { select: { name: true, monthlyPriceCents: true, currency: true } },
    },
    orderBy: { trialEndsAt: "asc" },
    take: 500,
  });
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: subscriptions.map((sub) => sub.vendorId) }, isSuspended: false, closedAt: null },
    select: { id: true, userId: true, storeName: true },
  });
  let scheduled = 0;
  for (const sub of subscriptions) {
    const trialEnd = sub.trialEndsAt;
    const vendor = vendors.find((item) => item.id === sub.vendorId);
    if (!trialEnd || !vendor) continue;
    const planName = sub.sellerPlan?.name ?? String(sub.plan);
    const planPrice = sub.sellerPlan && sub.sellerPlan.monthlyPriceCents > 0
      ? `${formatMoney(sub.sellerPlan.monthlyPriceCents, sub.sellerPlan.currency)}/month`
      : "your plan price";
    const trialEndDate = trialEnd.toISOString().slice(0, 10);
    await automationService.scheduleAutomation({
      type: "VENDOR_TRIAL_ENDING",
      recipientUserId: vendor.userId,
      vendorId: sub.vendorId,
      subjectKey: `${sub.id}:${trialEnd.getTime()}`,
      requiresMarketingConsent: false,
      title: "Your Eki Membership trial is ending",
      body: "Review your actual billing date and terms.",
      data: {
        trial_end_date: trialEndDate, plan_name: planName, plan_price: planPrice,
        vendor_subscription_id: sub.id, store_name: vendor.storeName,
        destination: "membership", trial_end: trialEnd.toISOString(),
      },
    });
    scheduled++;
  }
  return scheduled;
}
