import type { CommissionTier, SellerPlan, SubscriptionPlan } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { DEFAULT_SELLER_PLAN_CONFIGS } from "./subscriptions.types";

type SellerPlanWithTiers = SellerPlan & { commissionTiers: CommissionTier[] };

type SellerPlanLookupClient = {
  vendorSubscription?: {
    findUnique: (args: any) => any;
  };
  sellerPlan?: {
    findFirst: (args: any) => any;
  };
};

export interface VendorCommissionResolution {
  sellerPlanId: string | null;
  sellerPlanSlug: string;
  sellerPlanName: string;
  commissionTierId: string | null;
  commissionTierLabel: string | null;
  platformFeeBps: number;
  withdrawalFeeBps: number;
}

const STARTER_FALLBACK = DEFAULT_SELLER_PLAN_CONFIGS.find((plan) => plan.slug === "starter") ?? DEFAULT_SELLER_PLAN_CONFIGS[0];

function legacySlug(plan: SubscriptionPlan | null | undefined): string {
  if (plan === "GROWTH") return "growth";
  if (plan === "PRO" || plan === "PREMIUM") return "pro";
  return "starter";
}

function fallbackCommission(plan?: SubscriptionPlan | null): VendorCommissionResolution {
  const fallback = DEFAULT_SELLER_PLAN_CONFIGS.find((item) => item.slug === legacySlug(plan)) ?? STARTER_FALLBACK;
  const tier = fallback.commissionTiers
    .filter((item) => item.isActive)
    .sort((left, right) => right.minSubtotalCents - left.minSubtotalCents)[0];

  return {
    sellerPlanId: null,
    sellerPlanSlug: fallback.slug,
    sellerPlanName: fallback.name,
    commissionTierId: null,
    commissionTierLabel: tier?.label ?? null,
    platformFeeBps: tier?.platformFeeBps ?? fallback.defaultPlatformFeeBps ?? env.platformFeeBps,
    withdrawalFeeBps: fallback.withdrawalFeeBps,
  };
}

function selectTier(plan: SellerPlanWithTiers, subtotalAmount: number): CommissionTier | null {
  return plan.commissionTiers
    .filter((tier) => {
      if (!tier.isActive) return false;
      if (tier.minSubtotalCents > subtotalAmount) return false;
      return tier.maxSubtotalCents == null || subtotalAmount < tier.maxSubtotalCents;
    })
    .sort((left, right) => {
      return right.minSubtotalCents - left.minSubtotalCents || left.displayOrder - right.displayOrder;
    })[0] ?? null;
}

async function findStarterPlan(client: SellerPlanLookupClient): Promise<SellerPlanWithTiers | null> {
  if (!client.sellerPlan?.findFirst) return null;
  const defaultPlan = await client.sellerPlan.findFirst({
    where: { isDefault: true, deletedAt: null, isActive: true },
    include: { commissionTiers: true },
  });
  if (defaultPlan) return defaultPlan;
  return client.sellerPlan.findFirst({
    where: { slug: "starter", deletedAt: null },
    include: { commissionTiers: true },
  });
}

export async function resolveVendorCommission(
  vendorId: string,
  subtotalAmount = 0,
  client: SellerPlanLookupClient = prisma as unknown as SellerPlanLookupClient,
): Promise<VendorCommissionResolution> {
  if (!client.vendorSubscription?.findUnique) {
    return fallbackCommission();
  }

  const subscription = await client.vendorSubscription.findUnique({
    where: { vendorId },
    select: {
      plan: true,
      sellerPlanId: true,
      sellerPlan: {
        include: { commissionTiers: true },
      },
    },
  });

  const plan = subscription?.sellerPlan ?? await findStarterPlan(client);
  if (!plan || plan.deletedAt) {
    return fallbackCommission(subscription?.plan);
  }

  const tier = selectTier(plan, subtotalAmount);
  return {
    sellerPlanId: plan.id,
    sellerPlanSlug: plan.slug,
    sellerPlanName: plan.name,
    commissionTierId: tier?.id ?? null,
    commissionTierLabel: tier?.label ?? null,
    platformFeeBps: tier?.platformFeeBps ?? plan.defaultPlatformFeeBps,
    withdrawalFeeBps: plan.withdrawalFeeBps,
  };
}

export async function resolveVendorPlatformFeeBps(
  vendorId: string,
  client: SellerPlanLookupClient = prisma as unknown as SellerPlanLookupClient,
): Promise<number> {
  return (await resolveVendorCommission(vendorId, 0, client)).platformFeeBps;
}

export async function resolveVendorWithdrawalFeeBps(
  vendorId: string,
  client: SellerPlanLookupClient = prisma as unknown as SellerPlanLookupClient,
): Promise<number> {
  return (await resolveVendorCommission(vendorId, 0, client)).withdrawalFeeBps;
}
