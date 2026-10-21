import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ settingFindUnique: vi.fn() }));
vi.mock("../lib/prisma", () => ({ prisma: { adminPlatformSetting: { findUnique: m.settingFindUnique } } }));

import { applyCommissionPolicy, resolveSalesCommissionPolicy, resolveVendorCommission, salesCommissionEnabled } from "../modules/subscriptions/subscription-plan-utils";

beforeEach(() => {
  vi.clearAllMocks();
  m.settingFindUnique.mockResolvedValue(null); // no admin flag set — falls back to env (unset in test env -> false)
});

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

describe("sales commission policy — admin-configurable (21 Oct 2026, no redeploy needed)", () => {
  it("resolveSalesCommissionPolicy falls back to the env var when no admin flag has ever been set", async () => {
    m.settingFindUnique.mockResolvedValue(null);
    expect(await resolveSalesCommissionPolicy()).toBe(salesCommissionEnabled(process.env));
  });

  it("an admin flag set to ON overrides the env default", async () => {
    m.settingFindUnique.mockResolvedValue({ key: "FLAG_SALES_COMMISSION_ENABLED", value: 1 });
    expect(await resolveSalesCommissionPolicy()).toBe(true);
  });

  it("an admin flag explicitly set to OFF overrides the env default even if env says true", async () => {
    m.settingFindUnique.mockResolvedValue({ key: "FLAG_SALES_COMMISSION_ENABLED", value: 0 });
    expect(await resolveSalesCommissionPolicy()).toBe(false);
  });

  it("resolveVendorCommission respects the admin flag, not just the env var", async () => {
    m.settingFindUnique.mockResolvedValue({ key: "FLAG_SALES_COMMISSION_ENABLED", value: 1 });
    const client = {
      vendorSubscription: { findUnique: vi.fn().mockResolvedValue({ plan: "GROWTH", sellerPlanId: "p1", sellerPlan: { id: "p1", slug: "growth", name: "Growth", deletedAt: null, defaultPlatformFeeBps: 1000, withdrawalFeeBps: 200, canReceiveOrders: true, commissionTiers: [] } }) },
      sellerPlan: { findFirst: vi.fn() },
    };
    const r = await resolveVendorCommission("v1", 10_000, client as never);
    expect(r.platformFeeBps).toBe(1000);
  });
});
