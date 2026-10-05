import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { applyCommissionPolicy, resolveVendorCommission, salesCommissionEnabled } from "../modules/subscriptions/subscription-plan-utils";

const planFee = {
  sellerPlanId: "p1", sellerPlanSlug: "starter", sellerPlanName: "Starter",
  commissionTierId: "t1", commissionTierLabel: "Tier 1", platformFeeBps: 1500, withdrawalFeeBps: 100, canReceiveOrders: true,
};

describe("sales commission policy (subscription model)", () => {
  it("default: no sales commission, regardless of what the seller plan data says", () => {
    const r = applyCommissionPolicy(planFee, false);
    expect(r.platformFeeBps).toBe(0);
    expect(r.commissionTierId).toBeNull();
    // payout concepts are not touched
    expect(r.withdrawalFeeBps).toBe(100);
    expect(r.canReceiveOrders).toBe(true);
  });

  it("only an explicit SALES_COMMISSION_ENABLED=true restores plan fees", () => {
    expect(applyCommissionPolicy(planFee, true).platformFeeBps).toBe(1500);
    expect(salesCommissionEnabled({})).toBe(false);
    expect(salesCommissionEnabled({ SALES_COMMISSION_ENABLED: "1" })).toBe(false);
    expect(salesCommissionEnabled({ SALES_COMMISSION_ENABLED: "TRUE" })).toBe(true);
  });

  it("resolveVendorCommission yields 0 bps even when the plan row carries 15%", async () => {
    const client = {
      vendorSubscription: { findUnique: vi.fn().mockResolvedValue({ plan: "FREE", sellerPlanId: "p1", sellerPlan: { id: "p1", slug: "starter", name: "Starter", deletedAt: null, defaultPlatformFeeBps: 1500, withdrawalFeeBps: 0, canReceiveOrders: true, commissionTiers: [] } }) },
      sellerPlan: { findFirst: vi.fn() },
    };
    const r = await resolveVendorCommission("v1", 10_000, client as never);
    expect(r.platformFeeBps).toBe(0);
  });
});
