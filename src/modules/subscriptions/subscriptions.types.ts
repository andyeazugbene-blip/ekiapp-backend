import type { SubscriptionPlan } from "@prisma/client";

export interface CreateSubscriptionInput {
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

// Plan features/limits
export const PLAN_LIMITS = {
  FREE: {
    maxProducts: 10,
    maxImagesPerProduct: 3,
    analytics: false,
    prioritySupport: false,
    monthlyPriceCents: 0,
  },
  BASIC: {
    maxProducts: 50,
    maxImagesPerProduct: 8,
    analytics: true,
    prioritySupport: false,
    monthlyPriceCents: 1999, // $19.99/month
  },
  PREMIUM: {
    maxProducts: -1, // unlimited
    maxImagesPerProduct: 20,
    analytics: true,
    prioritySupport: true,
    monthlyPriceCents: 4999, // $49.99/month
  },
} as const;
