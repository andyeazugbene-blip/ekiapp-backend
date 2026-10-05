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
  canReceiveOrders: boolean;
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
    canReceiveOrders: fallback.canReceiveOrders ?? true,
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

/**
 * Product decision (Handbook 14.8 L587): vendor monetization is SUBSCRIPTION, not a sales
 * commission. The commission machinery (seller-plan tiers) is kept for history/reporting,
 * but it only ever produces a fee when SALES_COMMISSION_ENABLED=true is set explicitly
 * (an owner-approved exception). Default: platform fee is 0 for every new order.
 * Withdrawal fees are a separate payout concept and are not changed here.
 */
export function salesCommissionEnabled(envVars: Record<string, string | undefined> = process.env): boolean {
  return (envVars.SALES_COMMISSION_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function applyCommissionPolicy(
  resolution: VendorCommissionResolution,
  enabled: boolean = salesCommissionEnabled(),
): VendorCommissionResolution {
  if (enabled) return resolution;
  return { ...resolution, platformFeeBps: 0, commissionTierId: null, commissionTierLabel: null };
}

export async function resolveVendorCommission(
  vendorId: string,
  subtotalAmount = 0,
  client: SellerPlanLookupClient = prisma as unknown as SellerPlanLookupClient,
): Promise<VendorCommissionResolution> {
  return applyCommissionPolicy(await resolveVendorCommissionRaw(vendorId, subtotalAmount, client));
}

async function resolveVendorCommissionRaw(
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
    canReceiveOrders: plan.canReceiveOrders,
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
