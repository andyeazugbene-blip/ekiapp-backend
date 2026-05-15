import type { SubscriptionPlan } from "@prisma/client";

export interface CreateSubscriptionInput {
  plan: SubscriptionPlan;
}

export interface ActivateSubscriptionInput {
  plan: SubscriptionPlan;
}

export interface SubscriptionInfo {
  id: string;
  vendorId: string;
  plan: SubscriptionPlan;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelledAt: Date | null;
}

/**
 * Plan features/limits. Used to enforce backend restrictions on product count,
 * analytics access, and promotional features.
 */
export const PLAN_LIMITS = {
  FREE: {
    maxProducts: 10,
    maxImagesPerProduct: 3,
    analytics: false,
    prioritySupport: false,
    flashSales: false,
    bundles: false,
    discounts: false,
    monthlyPriceCents: 0,
  },
  BASIC: {
    maxProducts: 50,
    maxImagesPerProduct: 8,
    analytics: true,
    prioritySupport: false,
    flashSales: false,
    bundles: false,
    discounts: true,
    monthlyPriceCents: 1999,
  },
  GROWTH: {
    maxProducts: 100,
    maxImagesPerProduct: 10,
    analytics: true,
    prioritySupport: false,
    flashSales: true,
    bundles: true,
    discounts: true,
    monthlyPriceCents: 2999,
  },
  PREMIUM: {
    maxProducts: -1, // unlimited
    maxImagesPerProduct: 20,
    analytics: true,
    prioritySupport: true,
    flashSales: true,
    bundles: true,
    discounts: true,
    monthlyPriceCents: 4999,
  },
  PRO: {
    maxProducts: -1, // unlimited
    maxImagesPerProduct: 30,
    analytics: true,
    prioritySupport: true,
    flashSales: true,
    bundles: true,
    discounts: true,
    monthlyPriceCents: 7999,
  },
} as const;

export type PlanLimits = (typeof PLAN_LIMITS)[keyof typeof PLAN_LIMITS];
