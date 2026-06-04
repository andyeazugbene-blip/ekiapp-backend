import type { SubscriptionPlan, SubscriptionPlanConfig, VendorSubscription } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { DEFAULT_PLAN_CONFIGS } from "./subscriptions.types";
import type { ActivateSubscriptionInput, SubscriptionPlanConfigInput } from "./subscriptions.types";

type PlanConfigRecord = SubscriptionPlanConfig & {
  platformFeeBps?: number | null;
};
type PlanConfigModel = {
  count: () => Promise<number>;
  upsert: (args: any) => Promise<PlanConfigRecord>;
  findUnique: (args: any) => Promise<PlanConfigRecord | null>;
  findMany: (args?: any) => Promise<PlanConfigRecord[]>;
  findFirst: (args: any) => Promise<PlanConfigRecord | null>;
  create: (args: any) => Promise<PlanConfigRecord>;
};

function getPlanModel(): PlanConfigModel | null {
  return ((prisma as unknown as { subscriptionPlanConfig?: PlanConfigModel }).subscriptionPlanConfig ?? null);
}

async function ensureDefaultPlanConfigs(): Promise<void> {
  const planModel = getPlanModel();
  if (!planModel) return;

  const existing = await planModel.count();
  if (existing > 0) return;

  await Promise.all(
    Object.values(DEFAULT_PLAN_CONFIGS).map((plan) =>
      planModel.upsert({
        where: { plan: plan.plan },
        update: {},
        create: plan,
      }),
    ),
  );
}

async function getPlanConfig(plan: SubscriptionPlan): Promise<PlanConfigRecord> {
  await ensureDefaultPlanConfigs();

  const planModel = getPlanModel();
  if (!planModel) {
    return DEFAULT_PLAN_CONFIGS[plan] as unknown as PlanConfigRecord;
  }

  const config = await planModel.findUnique({ where: { plan } });
  if (config) return config;

  const fallback = DEFAULT_PLAN_CONFIGS[plan];
  return planModel.create({ data: fallback });
}

function formatPlanResponse(config: PlanConfigRecord) {
  return {
    id: config.id,
    plan: config.plan,
    slug: config.slug,
    name: config.name,
    description: config.description,
    monthlyPriceCents: config.monthlyPriceCents,
    platformFeeBps: config.platformFeeBps ?? DEFAULT_PLAN_CONFIGS[config.plan].platformFeeBps,
    currency: config.currency,
    maxProducts: config.maxProducts,
    maxImagesPerProduct: config.maxImagesPerProduct,
    maxOrders: config.maxOrders,
    analytics: config.analytics,
    prioritySupport: config.prioritySupport,
    flashSales: config.flashSales,
    bundles: config.bundles,
    discounts: config.discounts,
    marketingTools: config.marketingTools,
    canReceiveOrders: config.canReceiveOrders,
    appleProductId: config.appleProductId ?? null,
    googleProductId: config.googleProductId ?? null,
    isActive: config.isActive,
    displayOrder: config.displayOrder,
  };
}

export const subscriptionsService = {
  async getSubscription(userId: string): Promise<VendorSubscription> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

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

  async listPublicPlans() {
    await ensureDefaultPlanConfigs();
    const planModel = getPlanModel();
    if (!planModel) {
      return Object.values(DEFAULT_PLAN_CONFIGS).filter((plan) => plan.isActive).map((plan) => formatPlanResponse(plan as unknown as PlanConfigRecord));
    }
    const plans = await planModel.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    return plans.map(formatPlanResponse);
  },

  async listAdminPlans() {
    await ensureDefaultPlanConfigs();
    const planModel = getPlanModel();
    if (!planModel) {
      return Object.values(DEFAULT_PLAN_CONFIGS).map((plan) => formatPlanResponse(plan as unknown as PlanConfigRecord));
    }
    const plans = await planModel.findMany({
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    return plans.map(formatPlanResponse);
  },

  async upsertPlanConfig(adminId: string, input: SubscriptionPlanConfigInput) {
    await ensureDefaultPlanConfigs();
    const planModel = getPlanModel();
    if (!planModel) {
      throw new AppError("Subscription plan storage is unavailable", 503);
    }

    const existingSlug = await planModel.findFirst({
      where: {
        slug: input.slug,
        NOT: { plan: input.plan },
      },
      select: { id: true },
    });
    if (existingSlug) {
      throw new AppError("Another plan already uses this slug", 409);
    }

    const plan = await planModel.upsert({
      where: { plan: input.plan },
      update: input,
      create: input,
    });

    await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: "SUBSCRIPTION_PLAN_UPSERTED",
        entityType: "SubscriptionPlanConfig",
        entityId: plan.id,
        metadata: {
          plan: input.plan,
          slug: input.slug,
          isActive: input.isActive,
          monthlyPriceCents: input.monthlyPriceCents,
          platformFeeBps: input.platformFeeBps,
        },
      },
    });

    return formatPlanResponse(plan);
  },

  async activatePlan(
    userId: string,
    input: ActivateSubscriptionInput,
  ): Promise<{ subscription: VendorSubscription; limits: ReturnType<typeof formatPlanResponse> }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const planConfig = await getPlanConfig(input.plan);
    if (input.plan !== "FREE") {
      throw new AppError(
        "Paid subscriptions require website checkout. Complete the purchase on the website and the app will unlock features after the backend activates the plan.",
        409,
        null,
        "SUBSCRIPTIONS_NOT_AVAILABLE",
      );
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const subscription = await prisma.vendorSubscription.upsert({
      where: { vendorId: vendor.id },
      update: {
        plan: input.plan,
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelledAt: null,
      },
      create: {
        vendorId: vendor.id,
        plan: input.plan,
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });

    return { subscription, limits: formatPlanResponse(planConfig) };
  },

  async enforceProductLimit(vendorId: string): Promise<void> {
    const subscription = await prisma.vendorSubscription.findUnique({
      where: { vendorId },
    });
    const plan: SubscriptionPlan = subscription?.plan ?? "FREE";
    const limits = await getPlanConfig(plan);

    if (limits.maxProducts === -1) return;

    const currentCount = await prisma.product.count({
      where: { vendorId, isActive: true },
    });

    if (currentCount >= limits.maxProducts) {
      throw new AppError(
        `Your ${limits.name} plan allows a maximum of ${limits.maxProducts} active products.`,
        403,
      );
    }
  },

  async checkFeatureAccess(
    vendorId: string,
    feature: "analytics" | "flashSales" | "bundles" | "discounts",
  ): Promise<boolean> {
    const subscription = await prisma.vendorSubscription.findUnique({
      where: { vendorId },
    });
    const plan: SubscriptionPlan = subscription?.plan ?? "FREE";
    const limits = await getPlanConfig(plan);
    return Boolean(limits[feature]);
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

    const planConfig = await getPlanConfig(plan);
    if (!planConfig.isActive) {
      throw new AppError("This plan is currently unavailable", 409);
    }

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

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

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: planConfig.currency.toLowerCase(),
            product_data: {
              name: `${planConfig.name} Plan`,
              description: planConfig.description ?? `${planConfig.name} vendor subscription`,
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
    limits: ReturnType<typeof formatPlanResponse> & {
      currentProducts: number;
      currentOrders: number;
      ordersRemaining: number | null;
      canSendOffers: boolean;
      canAccessAnalytics: boolean;
    };
  }> {
    const sub = await this.getSubscription(userId);
    const limits = await getPlanConfig(sub.plan);
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const [currentProducts, currentOrders] = await Promise.all([
      prisma.product.count({ where: { vendorId: vendor.id, isActive: true } }),
      prisma.order.count({ where: { vendorId: vendor.id } }),
    ]);

    const ordersRemaining =
      limits.maxOrders == null || limits.maxOrders === -1 ? null : Math.max(limits.maxOrders - currentOrders, 0);

    return {
      plan: sub.plan,
      limits: {
        ...formatPlanResponse(limits),
        currentProducts,
        currentOrders,
        ordersRemaining,
        canSendOffers: limits.marketingTools || limits.flashSales || limits.bundles || limits.discounts,
        canAccessAnalytics: limits.analytics,
      },
    };
  },
};
