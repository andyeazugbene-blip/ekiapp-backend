import type {
  CommissionTier,
  SellerPlan,
  SubscriptionPlan,
  VendorSubscription,
} from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import {
  DEFAULT_PLAN_CONFIGS,
  DEFAULT_SELLER_PLAN_CONFIGS,
} from "./subscriptions.types";
import type {
  ActivateSubscriptionInput,
  AssignVendorPlanInput,
  CommissionTierInput,
  SubscriptionPlanConfigInput,
} from "./subscriptions.types";

type SellerPlanWithTiers = SellerPlan & { commissionTiers: CommissionTier[] };
type VendorSubscriptionWithPlan = VendorSubscription & {
  sellerPlan: SellerPlanWithTiers | null;
};

function percentFromBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
}

function legacyPlanForSlug(slug: string): SubscriptionPlan {
  if (slug === "growth") return "GROWTH";
  if (slug === "pro") return "PRO";
  return "FREE";
}

function stripLegacyConfig(plan: (typeof DEFAULT_PLAN_CONFIGS)[SubscriptionPlan]) {
  return {
    plan: plan.plan ?? legacyPlanForSlug(plan.slug),
    slug: plan.slug,
    name: plan.name,
    description: plan.description,
    monthlyPriceCents: plan.monthlyPriceCents,
    platformFeeBps: plan.defaultPlatformFeeBps,
    currency: plan.currency,
    maxProducts: plan.maxProducts,
    maxImagesPerProduct: plan.maxImagesPerProduct,
    maxOrders: plan.maxOrders,
    analytics: plan.analytics,
    prioritySupport: plan.prioritySupport,
    flashSales: plan.flashSales,
    bundles: plan.bundles,
    discounts: plan.discounts,
    marketingTools: plan.marketingTools,
    canReceiveOrders: plan.canReceiveOrders,
    isActive: plan.isActive,
    displayOrder: plan.displayOrder,
  };
}

function sellerPlanData(input: SubscriptionPlanConfigInput) {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    legacyPlan: input.plan ?? null,
    monthlyPriceCents: input.monthlyPriceCents,
    currency: input.currency,
    stripePriceId: input.stripePriceId ?? null,
    stripeProductId: input.stripeProductId ?? null,
    defaultPlatformFeeBps: input.defaultPlatformFeeBps,
    withdrawalFeeBps: input.withdrawalFeeBps,
    maxProducts: input.maxProducts,
    maxImagesPerProduct: input.maxImagesPerProduct,
    maxOrders: input.maxOrders ?? null,
    analytics: input.analytics,
    prioritySupport: input.prioritySupport,
    flashSales: input.flashSales,
    bundles: input.bundles,
    discounts: input.discounts,
    marketingTools: input.marketingTools,
    canReceiveOrders: input.canReceiveOrders,
    isActive: input.isActive,
    displayOrder: input.displayOrder,
    deletedAt: input.isActive ? null : undefined,
  };
}

function sortTiers(tiers: CommissionTier[]): CommissionTier[] {
  return [...tiers].sort((a, b) => a.displayOrder - b.displayOrder || a.minSubtotalCents - b.minSubtotalCents);
}

function formatTier(tier: CommissionTier) {
  return {
    id: tier.id,
    label: tier.label,
    minSubtotalCents: tier.minSubtotalCents,
    maxSubtotalCents: tier.maxSubtotalCents,
    platformFeeBps: tier.platformFeeBps,
    platformFeePercent: percentFromBps(tier.platformFeeBps),
    isActive: tier.isActive,
    displayOrder: tier.displayOrder,
  };
}

function formatPlanResponse(plan: SellerPlanWithTiers) {
  const activeTiers = sortTiers(plan.commissionTiers).filter((tier) => tier.isActive);
  const firstTier = activeTiers[0];
  const platformFeeBps = firstTier?.platformFeeBps ?? plan.defaultPlatformFeeBps;

  return {
    id: plan.id,
    plan: plan.legacyPlan ?? legacyPlanForSlug(plan.slug),
    legacyPlan: plan.legacyPlan,
    slug: plan.slug,
    name: plan.name,
    description: plan.description,
    monthlyPriceCents: plan.monthlyPriceCents,
    price: plan.monthlyPriceCents / 100,
    platformFeeBps,
    defaultPlatformFeeBps: plan.defaultPlatformFeeBps,
    platformFeePercent: percentFromBps(platformFeeBps),
    withdrawalFeeBps: plan.withdrawalFeeBps,
    withdrawalFeePercent: percentFromBps(plan.withdrawalFeeBps),
    currency: plan.currency,
    stripePriceId: plan.stripePriceId,
    stripeProductId: plan.stripeProductId,
    maxProducts: plan.maxProducts,
    maxImagesPerProduct: plan.maxImagesPerProduct,
    maxOrders: plan.maxOrders,
    analytics: plan.analytics,
    prioritySupport: plan.prioritySupport,
    flashSales: plan.flashSales,
    bundles: plan.bundles,
    discounts: plan.discounts,
    marketingTools: plan.marketingTools,
    canReceiveOrders: plan.canReceiveOrders,
    isActive: plan.isActive,
    deletedAt: plan.deletedAt,
    displayOrder: plan.displayOrder,
    commissionTiers: sortTiers(plan.commissionTiers).map(formatTier),
  };
}

function formatSubscriptionResponse(subscription: VendorSubscriptionWithPlan) {
  const plan = subscription.sellerPlan;
  return {
    id: subscription.id,
    vendorId: subscription.vendorId,
    plan: subscription.plan,
    sellerPlanId: subscription.sellerPlanId,
    planId: plan?.id ?? subscription.plan,
    planName: plan?.name ?? subscription.plan,
    slug: plan?.slug ?? subscription.plan.toLowerCase(),
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelledAt: subscription.cancelledAt,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    stripeCustomerId: subscription.stripeCustomerId,
    platformFeeBps: plan?.defaultPlatformFeeBps,
    platformFeePercent: plan ? percentFromBps(plan.defaultPlatformFeeBps) : undefined,
    withdrawalFeeBps: plan?.withdrawalFeeBps,
    withdrawalFeePercent: plan ? percentFromBps(plan.withdrawalFeeBps) : undefined,
    commissionTiers: plan ? sortTiers(plan.commissionTiers).map(formatTier) : [],
  };
}

async function syncCommissionTiers(sellerPlanId: string, tiers: CommissionTierInput[]) {
  const keepIds: string[] = [];
  for (const tier of tiers) {
    const data = {
      sellerPlanId,
      label: tier.label ?? null,
      minSubtotalCents: tier.minSubtotalCents,
      maxSubtotalCents: tier.maxSubtotalCents ?? null,
      platformFeeBps: tier.platformFeeBps,
      isActive: tier.isActive,
      displayOrder: tier.displayOrder,
    };
    if (tier.id) {
      const updated = await prisma.commissionTier.update({
        where: { id: tier.id },
        data,
      });
      keepIds.push(updated.id);
    } else {
      const created = await prisma.commissionTier.create({ data });
      keepIds.push(created.id);
    }
  }

  await prisma.commissionTier.deleteMany({
    where: {
      sellerPlanId,
      ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
    },
  });
}

async function ensureDefaultPlanConfigs(): Promise<void> {
  const existingLegacyPlans = await prisma.subscriptionPlanConfig.count();
  if (existingLegacyPlans === 0) {
    await Promise.all(
      Object.values(DEFAULT_PLAN_CONFIGS).map((plan) =>
        prisma.subscriptionPlanConfig.upsert({
          where: { plan: plan.plan ?? legacyPlanForSlug(plan.slug) },
          update: {},
          create: stripLegacyConfig(plan),
        }),
      ),
    );
  }

  const existingSellerPlans = await prisma.sellerPlan.count();
  if (existingSellerPlans > 0) return;

  for (const plan of DEFAULT_SELLER_PLAN_CONFIGS) {
    const created = await prisma.sellerPlan.create({ data: sellerPlanData(plan) });
    await syncCommissionTiers(created.id, plan.commissionTiers);
  }
}

async function getStarterPlan(): Promise<SellerPlanWithTiers> {
  await ensureDefaultPlanConfigs();
  const starter = await prisma.sellerPlan.findFirst({
    where: { slug: "starter", deletedAt: null },
    include: { commissionTiers: true },
  });
  if (!starter) {
    throw new AppError("Starter seller plan is not configured", 503);
  }
  return starter;
}

async function findSellerPlan(identifier: string, includeInactive = false): Promise<SellerPlanWithTiers | null> {
  await ensureDefaultPlanConfigs();
  const normalized = identifier.trim();
  const legacy = normalized.toUpperCase();

  return prisma.sellerPlan.findFirst({
    where: {
      deletedAt: null,
      ...(includeInactive ? {} : { isActive: true }),
      OR: [
        { id: normalized },
        { slug: normalized.toLowerCase() },
        ...(legacy in DEFAULT_PLAN_CONFIGS ? [{ legacyPlan: legacy as SubscriptionPlan }] : []),
      ],
    },
    include: { commissionTiers: true },
  });
}

async function getPlanForSubscription(subscription: VendorSubscription | null): Promise<SellerPlanWithTiers> {
  if (subscription?.sellerPlanId) {
    const sellerPlan = await prisma.sellerPlan.findUnique({
      where: { id: subscription.sellerPlanId },
      include: { commissionTiers: true },
    });
    if (sellerPlan && !sellerPlan.deletedAt) return sellerPlan;
  }

  if (subscription?.plan) {
    const legacy = await findSellerPlan(subscription.plan, true);
    if (legacy) return legacy;
  }

  return getStarterPlan();
}

export const subscriptionsService = {
  async getSubscription(userId: string) {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const starter = await getStarterPlan();
    const subscription = await prisma.vendorSubscription.upsert({
      where: { vendorId: vendor.id },
      update: {},
      create: {
        vendorId: vendor.id,
        plan: starter.legacyPlan ?? "FREE",
        sellerPlanId: starter.id,
        status: "ACTIVE",
      },
      include: { sellerPlan: { include: { commissionTiers: true } } },
    });

    if (!subscription.sellerPlanId) {
      const plan = await getPlanForSubscription(subscription);
      const updated = await prisma.vendorSubscription.update({
        where: { id: subscription.id },
        data: { sellerPlanId: plan.id, plan: plan.legacyPlan ?? subscription.plan },
        include: { sellerPlan: { include: { commissionTiers: true } } },
      });
      return formatSubscriptionResponse(updated);
    }

    return formatSubscriptionResponse(subscription);
  },

  async listPublicPlans() {
    await ensureDefaultPlanConfigs();
    const plans = await prisma.sellerPlan.findMany({
      where: { isActive: true, deletedAt: null },
      include: { commissionTiers: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    return plans.map(formatPlanResponse);
  },

  async listAdminPlans() {
    await ensureDefaultPlanConfigs();
    const plans = await prisma.sellerPlan.findMany({
      where: { deletedAt: null },
      include: { commissionTiers: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    return plans.map(formatPlanResponse);
  },

  async upsertPlanConfig(adminId: string, input: SubscriptionPlanConfigInput) {
    await ensureDefaultPlanConfigs();

    const existing = input.id
      ? await prisma.sellerPlan.findUnique({ where: { id: input.id } })
      : await prisma.sellerPlan.findUnique({ where: { slug: input.slug } });

    const slugConflict = await prisma.sellerPlan.findFirst({
      where: {
        slug: input.slug,
        deletedAt: null,
        ...(existing ? { NOT: { id: existing.id } } : {}),
      },
      select: { id: true },
    });
    if (slugConflict) {
      throw new AppError("Another seller plan already uses this slug", 409);
    }

    if (input.plan) {
      const legacyConflict = await prisma.sellerPlan.findFirst({
        where: {
          legacyPlan: input.plan,
          deletedAt: null,
          ...(existing ? { NOT: { id: existing.id } } : {}),
        },
        select: { id: true },
      });
      if (legacyConflict) {
        throw new AppError("Another seller plan already uses this legacy plan", 409);
      }
    }

    const plan = existing
      ? await prisma.sellerPlan.update({
          where: { id: existing.id },
          data: sellerPlanData(input),
        })
      : await prisma.sellerPlan.create({ data: sellerPlanData(input) });

    await syncCommissionTiers(plan.id, input.commissionTiers);

    const withTiers = await prisma.sellerPlan.findUniqueOrThrow({
      where: { id: plan.id },
      include: { commissionTiers: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: "SELLER_PLAN_UPSERTED",
        entityType: "SellerPlan",
        entityId: plan.id,
        metadata: {
          slug: plan.slug,
          isActive: plan.isActive,
          monthlyPriceCents: plan.monthlyPriceCents,
          defaultPlatformFeeBps: plan.defaultPlatformFeeBps,
          withdrawalFeeBps: plan.withdrawalFeeBps,
        },
      },
    });

    return formatPlanResponse(withTiers);
  },

  async deletePlanConfig(adminId: string, planId: string) {
    const plan = await prisma.sellerPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.deletedAt) {
      throw new AppError("Seller plan not found", 404);
    }

    const activePlans = await prisma.sellerPlan.count({ where: { isActive: true, deletedAt: null } });
    if (plan.isActive && activePlans <= 1) {
      throw new AppError("At least one active seller plan is required", 409);
    }

    const updated = await prisma.sellerPlan.update({
      where: { id: planId },
      data: { isActive: false, deletedAt: new Date() },
      include: { commissionTiers: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: "SELLER_PLAN_DELETED",
        entityType: "SellerPlan",
        entityId: planId,
        metadata: { slug: plan.slug },
      },
    });

    return formatPlanResponse(updated);
  },

  async assignVendorPlan(adminId: string, vendorId: string, input: AssignVendorPlanInput) {
    const [vendor, sellerPlan] = await Promise.all([
      prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } }),
      findSellerPlan(input.plan, true),
    ]);
    if (!vendor) throw new AppError("Vendor not found", 404);
    if (!sellerPlan || sellerPlan.deletedAt) throw new AppError("Seller plan not found", 404);

    const subscription = await prisma.vendorSubscription.upsert({
      where: { vendorId },
      update: {
        sellerPlanId: sellerPlan.id,
        plan: sellerPlan.legacyPlan ?? legacyPlanForSlug(sellerPlan.slug),
        status: "ACTIVE",
        cancelledAt: null,
      },
      create: {
        vendorId,
        sellerPlanId: sellerPlan.id,
        plan: sellerPlan.legacyPlan ?? legacyPlanForSlug(sellerPlan.slug),
        status: "ACTIVE",
      },
      include: { sellerPlan: { include: { commissionTiers: true } } },
    });

    await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: "VENDOR_SELLER_PLAN_ASSIGNED",
        entityType: "Vendor",
        entityId: vendorId,
        metadata: { sellerPlanId: sellerPlan.id, slug: sellerPlan.slug },
      },
    });

    return formatSubscriptionResponse(subscription);
  },

  async activatePlan(userId: string, input: ActivateSubscriptionInput) {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const sellerPlan = await findSellerPlan(input.plan, true);
    if (!sellerPlan || sellerPlan.slug !== "starter") {
      throw new AppError(
        "Paid seller plans require website checkout. Complete the purchase on the website and the app will unlock features after Stripe confirms payment.",
        409,
        null,
        "SELLER_PLANS_WEB_ONLY",
      );
    }

    const subscription = await prisma.vendorSubscription.upsert({
      where: { vendorId: vendor.id },
      update: {
        sellerPlanId: sellerPlan.id,
        plan: sellerPlan.legacyPlan ?? "FREE",
        status: "ACTIVE",
        cancelledAt: null,
      },
      create: {
        vendorId: vendor.id,
        sellerPlanId: sellerPlan.id,
        plan: sellerPlan.legacyPlan ?? "FREE",
        status: "ACTIVE",
      },
      include: { sellerPlan: { include: { commissionTiers: true } } },
    });

    return { subscription: formatSubscriptionResponse(subscription), limits: formatPlanResponse(sellerPlan) };
  },

  async enforceProductLimit(vendorId: string): Promise<void> {
    const subscription = await prisma.vendorSubscription.findUnique({ where: { vendorId } });
    const limits = await getPlanForSubscription(subscription);

    if (limits.maxProducts === -1) return;

    const currentCount = await prisma.product.count({
      where: { vendorId, isActive: true },
    });

    if (currentCount >= limits.maxProducts) {
      throw new AppError(
        `Your ${limits.name} seller plan allows a maximum of ${limits.maxProducts} active products.`,
        403,
      );
    }
  },

  async checkFeatureAccess(
    vendorId: string,
    feature: "analytics" | "flashSales" | "bundles" | "discounts",
  ): Promise<boolean> {
    const subscription = await prisma.vendorSubscription.findUnique({ where: { vendorId } });
    const limits = await getPlanForSubscription(subscription);
    return Boolean(limits[feature]);
  },

  async createCheckoutSession(userId: string, plan: string): Promise<{ checkoutUrl: string }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      include: { user: { select: { email: true } } },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    return this.createVendorSubscriptionCheckout({
      vendorId: vendor.id,
      userId,
      email: vendor.user.email,
      plan,
    });
  },

  async createWebCheckoutSession(email: string, plan: string): Promise<{ checkoutUrl: string }> {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        role: true,
        vendor: { select: { id: true } },
      },
    });

    if (!user || user.role !== "VENDOR" || !user.vendor) {
      throw new AppError("No vendor account exists for this email", 404);
    }

    return this.createVendorSubscriptionCheckout({
      vendorId: user.vendor.id,
      userId: user.id,
      email: user.email,
      plan,
    });
  },

  async createVendorSubscriptionCheckout(input: {
    vendorId: string;
    userId: string;
    email: string;
    plan: string;
  }): Promise<{ checkoutUrl: string }> {
    const planConfig = await findSellerPlan(input.plan);
    if (!planConfig) {
      throw new AppError("This seller plan is currently unavailable", 409);
    }
    if (planConfig.monthlyPriceCents <= 0) {
      throw new AppError("This seller plan does not require paid checkout", 409);
    }

    const frontendUrl = process.env.FRONTEND_URL ?? "https://culinarytales.app";

    let subscription = await prisma.vendorSubscription.findUnique({
      where: { vendorId: input.vendorId },
    });

    let customerId = subscription?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: input.email,
        metadata: { vendorId: input.vendorId, userId: input.userId },
      });
      customerId = customer.id;

      if (subscription) {
        await prisma.vendorSubscription.update({
          where: { id: subscription.id },
          data: { stripeCustomerId: customerId },
        });
      } else {
        const starter = await getStarterPlan();
        subscription = await prisma.vendorSubscription.create({
          data: {
            vendorId: input.vendorId,
            plan: starter.legacyPlan ?? "FREE",
            sellerPlanId: starter.id,
            status: "ACTIVE",
            stripeCustomerId: customerId,
          },
        });
      }
    }

    const metadata = {
      kind: "vendor_subscription",
      vendorId: input.vendorId,
      userId: input.userId,
      sellerPlanId: planConfig.id,
      sellerPlanSlug: planConfig.slug,
      plan: planConfig.legacyPlan ?? legacyPlanForSlug(planConfig.slug),
      email: input.email,
    };

    const lineItem = planConfig.stripePriceId
      ? { price: planConfig.stripePriceId, quantity: 1 }
      : {
          price_data: {
            currency: planConfig.currency.toLowerCase(),
            product_data: {
              name: `${planConfig.name} Seller Plan`,
              description: planConfig.description ?? `${planConfig.name} seller plan`,
            },
            unit_amount: planConfig.monthlyPriceCents,
            recurring: { interval: "month" as const },
          },
          quantity: 1,
        };

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [lineItem],
      success_url: `${frontendUrl}/vendor/subscription?success=true&email=${encodeURIComponent(input.email)}`,
      cancel_url: `${frontendUrl}/vendor/subscription?cancelled=true&email=${encodeURIComponent(input.email)}`,
      metadata,
      subscription_data: { metadata },
    });

    if (!session.url) {
      throw new AppError("Failed to create checkout session", 502);
    }

    return { checkoutUrl: session.url };
  },

  async cancelSubscription(userId: string) {
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
      throw new AppError("No seller plan found", 404);
    }
    if (subscription.status === "CANCELLED") {
      throw new AppError("Seller plan already cancelled", 409);
    }

    if (subscription.stripeSubscriptionId) {
      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    }

    const updated = await prisma.vendorSubscription.update({
      where: { id: subscription.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
      },
      include: { sellerPlan: { include: { commissionTiers: true } } },
    });
    return formatSubscriptionResponse(updated);
  },

  async handleSubscriptionWebhook(
    vendorId: string,
    sellerPlanId: string,
    stripeSubscriptionId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<void> {
    const sellerPlan = await prisma.sellerPlan.findUnique({ where: { id: sellerPlanId } });
    if (!sellerPlan || sellerPlan.deletedAt) {
      throw new AppError("Seller plan not found for subscription webhook", 404);
    }

    await prisma.vendorSubscription.upsert({
      where: { vendorId },
      update: {
        sellerPlanId,
        plan: sellerPlan.legacyPlan ?? legacyPlanForSlug(sellerPlan.slug),
        status: "ACTIVE",
        stripeSubscriptionId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelledAt: null,
      },
      create: {
        vendorId,
        sellerPlanId,
        plan: sellerPlan.legacyPlan ?? legacyPlanForSlug(sellerPlan.slug),
        status: "ACTIVE",
        stripeSubscriptionId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
  },

  async getPlanLimits(userId: string) {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const sub = await prisma.vendorSubscription.findUnique({ where: { vendorId: vendor.id } });
    const limits = await getPlanForSubscription(sub);

    const [currentProducts, currentOrders] = await Promise.all([
      prisma.product.count({ where: { vendorId: vendor.id, isActive: true } }),
      prisma.order.count({ where: { vendorId: vendor.id } }),
    ]);

    const ordersRemaining =
      limits.maxOrders == null || limits.maxOrders === -1 ? null : Math.max(limits.maxOrders - currentOrders, 0);

    return {
      plan: limits.legacyPlan ?? legacyPlanForSlug(limits.slug),
      sellerPlanId: limits.id,
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
