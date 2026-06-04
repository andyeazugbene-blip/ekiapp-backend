import type { SubscriptionPlan } from "@prisma/client";

export interface CreateSubscriptionInput {
  plan: SubscriptionPlan;
}

export interface CreateWebSubscriptionCheckoutInput {
  plan: SubscriptionPlan;
  email: string;
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

export interface SubscriptionPlanConfigInput {
  plan: SubscriptionPlan;
  slug: string;
  name: string;
  description?: string | null;
  monthlyPriceCents: number;
  platformFeeBps: number;
  currency: string;
  maxProducts: number;
  maxImagesPerProduct: number;
  maxOrders?: number | null;
  analytics: boolean;
  prioritySupport: boolean;
  flashSales: boolean;
  bundles: boolean;
  discounts: boolean;
  marketingTools: boolean;
  canReceiveOrders: boolean;
  isActive: boolean;
  displayOrder: number;
}

/**
 * Default backend entitlements. These are also used to bootstrap the DB-backed
 * plan catalog so the mobile app and admin panel always have a single source
 * of truth even on first deploy.
 */
export const DEFAULT_PLAN_CONFIGS: Record<SubscriptionPlan, SubscriptionPlanConfigInput> = {
  FREE: {
    plan: "FREE",
    slug: "free",
    name: "Free",
    description: "Starter access for new vendors.",
    monthlyPriceCents: 0,
    platformFeeBps: 1200,
    currency: "GBP",
    maxProducts: 10,
    maxImagesPerProduct: 3,
    maxOrders: null,
    analytics: false,
    prioritySupport: false,
    flashSales: false,
    bundles: false,
    discounts: false,
    marketingTools: false,
    canReceiveOrders: true,
    isActive: true,
    displayOrder: 0,
  },
  BASIC: {
    plan: "BASIC",
    slug: "basic",
    name: "Basic",
    description: "Legacy plan kept for compatibility.",
    monthlyPriceCents: 1999,
    platformFeeBps: 1100,
    currency: "GBP",
    maxProducts: 50,
    maxImagesPerProduct: 8,
    maxOrders: null,
    analytics: true,
    prioritySupport: false,
    flashSales: false,
    bundles: false,
    discounts: true,
    marketingTools: true,
    canReceiveOrders: true,
    isActive: false,
    displayOrder: 10,
  },
  GROWTH: {
    plan: "GROWTH",
    slug: "growth",
    name: "Growth",
    description: "Growth plan with analytics and marketing tools.",
    monthlyPriceCents: 2999,
    platformFeeBps: 900,
    currency: "GBP",
    maxProducts: 100,
    maxImagesPerProduct: 10,
    maxOrders: null,
    analytics: true,
    prioritySupport: false,
    flashSales: true,
    bundles: true,
    discounts: true,
    marketingTools: true,
    canReceiveOrders: true,
    isActive: true,
    displayOrder: 20,
  },
  PREMIUM: {
    plan: "PREMIUM",
    slug: "premium",
    name: "Premium",
    description: "Legacy premium plan kept for compatibility.",
    monthlyPriceCents: 4999,
    platformFeeBps: 800,
    currency: "GBP",
    maxProducts: -1,
    maxImagesPerProduct: 20,
    maxOrders: null,
    analytics: true,
    prioritySupport: true,
    flashSales: true,
    bundles: true,
    discounts: true,
    marketingTools: true,
    canReceiveOrders: true,
    isActive: false,
    displayOrder: 30,
  },
  PRO: {
    plan: "PRO",
    slug: "pro",
    name: "Pro",
    description: "Full access for advanced vendors.",
    monthlyPriceCents: 7999,
    platformFeeBps: 650,
    currency: "GBP",
    maxProducts: -1,
    maxImagesPerProduct: 30,
    maxOrders: null,
    analytics: true,
    prioritySupport: true,
    flashSales: true,
    bundles: true,
    discounts: true,
    marketingTools: true,
    canReceiveOrders: true,
    isActive: true,
    displayOrder: 30,
  },
};

export type PlanLimits = (typeof DEFAULT_PLAN_CONFIGS)[keyof typeof DEFAULT_PLAN_CONFIGS];

export const PLAN_LIMITS = DEFAULT_PLAN_CONFIGS;
