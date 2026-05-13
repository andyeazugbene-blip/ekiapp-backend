import type { SubscriptionPlan, VendorSubscription } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { PLAN_LIMITS } from "./subscriptions.types";

export const subscriptionsService = {
  async getSubscription(userId: string): Promise<VendorSubscription> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    // Get or create subscription (default FREE)
    let subscription = await prisma.vendorSubscription.findUnique({
      where: { vendorId: vendor.id },
    });

    if (!subscription) {
      subscription = await prisma.vendorSubscription.create({
        data: {
          vendorId: vendor.id,
          plan: "FREE",
          status: "ACTIVE",
        },
      });
    }

    return subscription;
  },

  async createCheckoutSession(
    userId: string,
    plan: SubscriptionPlan,
  ): Promise<{ checkoutUrl: string }> {
    if (plan === "FREE") {
      throw new AppError("Cannot create checkout for free plan", 400);
    }

    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      include: { user: { select: { email: true } } },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const planConfig = PLAN_LIMITS[plan];
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

    // Get or create Stripe customer
    let subscription = await prisma.vendorSubscription.findUnique({
      where: { vendorId: vendor.id },
    });

    let customerId = subscription?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: vendor.user.email,
        metadata: { vendorId: vendor.id, userId },
      });
      customerId = customer.id;

      if (subscription) {
        await prisma.vendorSubscription.update({
          where: { id: subscription.id },
          data: { stripeCustomerId: customerId },
        });
      } else {
        subscription = await prisma.vendorSubscription.create({
          data: {
            vendorId: vendor.id,
            plan: "FREE",
            status: "ACTIVE",
            stripeCustomerId: customerId,
          },
        });
      }
    }

    // Create Stripe Checkout Session for subscription
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Eki ${plan.charAt(0) + plan.slice(1).toLowerCase()} Plan`,
              description: `Monthly subscription — ${plan.toLowerCase()} tier`,
            },
            unit_amount: planConfig.monthlyPriceCents,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/vendor/subscription?success=true`,
      cancel_url: `${frontendUrl}/vendor/subscription?cancelled=true`,
      metadata: {
        vendorId: vendor.id,
        plan,
      },
    });

    if (!session.url) {
      throw new AppError("Failed to create checkout session", 502);
    }

    return { checkoutUrl: session.url };
  },

  async cancelSubscription(userId: string): Promise<VendorSubscription> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const subscription = await prisma.vendorSubscription.findUnique({
      where: { vendorId: vendor.id },
    });
    if (!subscription) {
      throw new AppError("No subscription found", 404);
    }
    if (subscription.plan === "FREE") {
      throw new AppError("Cannot cancel free plan", 400);
    }
    if (subscription.status === "CANCELLED") {
      throw new AppError("Subscription already cancelled", 409);
    }

    // Cancel in Stripe if we have a subscription ID
    if (subscription.stripeSubscriptionId) {
      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    }

    return prisma.vendorSubscription.update({
      where: { id: subscription.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
      },
    });
  },

  async handleSubscriptionWebhook(
    vendorId: string,
    plan: SubscriptionPlan,
    stripeSubscriptionId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<void> {
    await prisma.vendorSubscription.upsert({
      where: { vendorId },
      update: {
        plan,
        status: "ACTIVE",
        stripeSubscriptionId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelledAt: null,
      },
      create: {
        vendorId,
        plan,
        status: "ACTIVE",
        stripeSubscriptionId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
  },

  async getPlanLimits(userId: string): Promise<{
    plan: SubscriptionPlan;
    limits: (typeof PLAN_LIMITS)[SubscriptionPlan];
  }> {
    const sub = await this.getSubscription(userId);
    return {
      plan: sub.plan,
      limits: PLAN_LIMITS[sub.plan],
    };
  },
};
