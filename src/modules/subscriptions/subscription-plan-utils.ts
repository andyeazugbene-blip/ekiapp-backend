import type { SubscriptionPlan } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { DEFAULT_PLAN_CONFIGS } from "./subscriptions.types";

type SubscriptionLookupClient = {
  vendorSubscription: {
    findUnique: (args: any) => Promise<{ plan: SubscriptionPlan } | null>;
  };
  subscriptionPlanConfig?: {
    findUnique: (args: any) => Promise<{ platformFeeBps?: number | null } | null>;
  };
};

function fallbackPlatformFeeBps(plan: SubscriptionPlan): number {
  return DEFAULT_PLAN_CONFIGS[plan]?.platformFeeBps ?? env.platformFeeBps;
}

export async function resolveVendorPlatformFeeBps(
  vendorId: string,
  client: SubscriptionLookupClient = prisma as unknown as SubscriptionLookupClient,
): Promise<number> {
  if (!client?.vendorSubscription?.findUnique) {
    return env.platformFeeBps;
  }

  const subscription = await client.vendorSubscription.findUnique({
    where: { vendorId },
    select: { plan: true },
  });
  const plan = subscription?.plan ?? "FREE";

  if (!client.subscriptionPlanConfig) {
    return fallbackPlatformFeeBps(plan);
  }

  const planConfig = await client.subscriptionPlanConfig.findUnique({
    where: { plan },
    select: { platformFeeBps: true },
  });

  return typeof planConfig?.platformFeeBps === "number" ? planConfig.platformFeeBps : fallbackPlatformFeeBps(plan);
}
