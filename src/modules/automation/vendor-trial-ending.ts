import type Stripe from "stripe";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { eventsService, EVENT_NAMES } from "../events/events.service";
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
 * Stripe fires customer.subscription.trial_will_end 3 days before a trial ends.
 * Notifies the vendor in-app + push + email with plan and billing info via the
 * automation engine (so it appears as an AutomationRun in the Automation
 * Centre). Idempotency is provided by the caller (WebhookEvent claim) AND by the
 * run's deterministic dedupeKey (vendorSubscriptionId + trial_end).
 * Returns "notified" | "ignored".
 */
export async function notifyVendorTrialEnding(stripeSubscription: Stripe.Subscription): Promise<"notified" | "ignored"> {
  const sub = await prisma.vendorSubscription.findUnique({
    where: { stripeSubscriptionId: stripeSubscription.id },
    select: { id: true, vendorId: true, plan: true, sellerPlan: { select: { name: true, monthlyPriceCents: true, currency: true } } },
  });
  if (!sub) {
    logger.warn("customer.subscription.trial_will_end for unknown vendor subscription", { stripeSubscriptionId: stripeSubscription.id });
    return "ignored";
  }
  const vendor = await prisma.vendor.findUnique({ where: { id: sub.vendorId }, select: { userId: true, storeName: true } });
  if (!vendor) return "ignored";

  const trialEnd = stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : null;
  const planName = sub.sellerPlan?.name ?? String(sub.plan);
  const planPrice = sub.sellerPlan && sub.sellerPlan.monthlyPriceCents > 0
    ? `${formatMoney(sub.sellerPlan.monthlyPriceCents, sub.sellerPlan.currency)}/month`
    : "your plan price";
  const trialEndDate = trialEnd ? trialEnd.toISOString().slice(0, 10) : "soon";

  await automationService.scheduleAutomation({
    type: "VENDOR_TRIAL_ENDING",
    recipientUserId: vendor.userId,
    vendorId: sub.vendorId,
    subjectKey: `${sub.id}:${trialEnd ? trialEnd.getTime() : "na"}`,
    requiresMarketingConsent: false,
    bypassQuietHours: true,
    title: "Your Eki free trial ends soon",
    body: `Your free trial ends on ${trialEndDate}.`,
    data: { trial_end_date: trialEndDate, plan_name: planName, plan_price: planPrice, vendor_subscription_id: sub.id, store_name: vendor.storeName },
  });
  eventsService.emit({
    name: EVENT_NAMES.vendor_trial_ending,
    actorType: "stripe",
    entityType: "VendorSubscription",
    entityId: sub.id,
    secondaryEntities: { vendorId: sub.vendorId },
    source: "stripe_webhook",
    payload: { trialEnd: trialEnd?.toISOString() ?? null, plan: planName },
  });
  return "notified";
}
