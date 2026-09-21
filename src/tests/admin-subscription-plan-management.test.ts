/**
 * Phase 4.2 (test coverage for already-implemented features) — admin
 * seller-plan management (upsertPlanConfig/deletePlanConfig/assignVendorPlan
 * in subscriptions.service.ts) was real, audited, and wired to real admin
 * routes, but had zero dedicated test coverage. This exercises the real
 * correctness properties: slug/legacy-plan conflict rejection, refusing to
 * delete the last active plan (would leave every vendor without any
 * resolvable plan), and audit logging on all three mutations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    sellerPlan: { findUnique: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    commissionTier: { deleteMany: vi.fn().mockResolvedValue({}) },
    subscriptionPlanConfig: { count: vi.fn().mockResolvedValue(1) },
    vendor: { findUnique: vi.fn() },
    vendorSubscription: { upsert: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { prisma } from "../lib/prisma";
import { subscriptionsService } from "../modules/subscriptions/subscriptions.service";

const m = vi.mocked(prisma, true) as any;
const ADMIN_ID = "admin-1";

const baseInput = {
  slug: "growth", name: "Growth", description: "d", plan: "GROWTH", monthlyPriceCents: 999, currency: "GBP",
  stripePriceId: null, stripeProductId: null, defaultPlatformFeeBps: 1000, withdrawalFeeBps: 200,
  maxProducts: -1, maxImagesPerProduct: 10, maxOrders: null, maxCoupons: null, maxBundles: null,
  analytics: true, prioritySupport: true, flashSales: true, bundles: true, discounts: true, marketingTools: true,
  canReceiveOrders: true, isActive: true, isDefault: false, displayOrder: 1, commissionTiers: [],
};

beforeEach(() => vi.clearAllMocks());

describe("upsertPlanConfig — conflict rejection", () => {
  it("rejects a slug already used by a different plan", async () => {
    m.sellerPlan.findUnique.mockResolvedValueOnce(null); // no existing plan by id
    m.sellerPlan.findFirst.mockResolvedValueOnce({ id: "other-plan" }); // slug conflict

    await expect(subscriptionsService.upsertPlanConfig(ADMIN_ID, baseInput as any)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.sellerPlan.create).not.toHaveBeenCalled();
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a legacy plan already used by a different SellerPlan", async () => {
    m.sellerPlan.findUnique.mockResolvedValueOnce(null);
    m.sellerPlan.findFirst
      .mockResolvedValueOnce(null) // no slug conflict
      .mockResolvedValueOnce({ id: "other-plan-2" }); // legacy plan conflict

    await expect(subscriptionsService.upsertPlanConfig(ADMIN_ID, baseInput as any)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.sellerPlan.create).not.toHaveBeenCalled();
  });

  it("creates a new plan, syncs tiers, and writes an audit entry when there's no conflict", async () => {
    m.sellerPlan.findUnique.mockResolvedValueOnce(null);
    m.sellerPlan.findFirst.mockResolvedValue(null); // no conflicts
    m.sellerPlan.create.mockResolvedValue({ id: "plan-1", slug: "growth" });
    m.sellerPlan.findUniqueOrThrow.mockResolvedValue({ id: "plan-1", slug: "growth", commissionTiers: [] });

    await subscriptionsService.upsertPlanConfig(ADMIN_ID, baseInput as any);

    expect(m.sellerPlan.create).toHaveBeenCalled();
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: ADMIN_ID, action: "SELLER_PLAN_UPSERTED", entityId: "plan-1" }),
    }));
  });

  it("unsets isDefault on every other plan when this one is marked default", async () => {
    m.sellerPlan.findUnique.mockResolvedValueOnce(null);
    m.sellerPlan.findFirst.mockResolvedValue(null);
    m.sellerPlan.create.mockResolvedValue({ id: "plan-1", slug: "growth" });
    m.sellerPlan.findUniqueOrThrow.mockResolvedValue({ id: "plan-1", slug: "growth", commissionTiers: [] });

    await subscriptionsService.upsertPlanConfig(ADMIN_ID, { ...baseInput, isDefault: true } as any);

    expect(m.sellerPlan.updateMany).toHaveBeenCalledWith({
      where: { NOT: { id: "plan-1" } },
      data: { isDefault: false },
    });
  });
});

describe("deletePlanConfig — refuses to remove the last active plan", () => {
  it("404s for a plan that doesn't exist", async () => {
    m.sellerPlan.findUnique.mockResolvedValue(null);
    await expect(subscriptionsService.deletePlanConfig(ADMIN_ID, "missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("blocks deleting the only remaining active plan", async () => {
    m.sellerPlan.findUnique.mockResolvedValue({ id: "plan-1", isActive: true, deletedAt: null, slug: "starter" });
    m.sellerPlan.count.mockResolvedValue(1); // only one active plan left

    await expect(subscriptionsService.deletePlanConfig(ADMIN_ID, "plan-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.sellerPlan.update).not.toHaveBeenCalled();
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  it("allows deleting one of several active plans, soft-deletes it, and audits", async () => {
    m.sellerPlan.findUnique.mockResolvedValue({ id: "plan-2", isActive: true, deletedAt: null, slug: "growth" });
    m.sellerPlan.count.mockResolvedValue(3); // plenty of other active plans
    m.sellerPlan.update.mockResolvedValue({ id: "plan-2", isActive: false, deletedAt: new Date(), commissionTiers: [] });

    await subscriptionsService.deletePlanConfig(ADMIN_ID, "plan-2");

    expect(m.sellerPlan.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "plan-2" },
      data: expect.objectContaining({ isActive: false, deletedAt: expect.any(Date) }),
    }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "SELLER_PLAN_DELETED", entityId: "plan-2" }),
    }));
  });

  it("allows deleting an already-inactive plan without the last-active-plan check blocking it", async () => {
    m.sellerPlan.findUnique.mockResolvedValue({ id: "plan-3", isActive: false, deletedAt: null, slug: "old-plan" });
    m.sellerPlan.count.mockResolvedValue(0); // zero active plans — irrelevant since this one is already inactive
    m.sellerPlan.update.mockResolvedValue({ id: "plan-3", isActive: false, deletedAt: new Date(), commissionTiers: [] });

    await subscriptionsService.deletePlanConfig(ADMIN_ID, "plan-3");
    expect(m.sellerPlan.update).toHaveBeenCalled();
  });
});

describe("assignVendorPlan — manual per-vendor plan change", () => {
  it("404s when the vendor doesn't exist", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(subscriptionsService.assignVendorPlan(ADMIN_ID, "missing-vendor", { plan: "growth" } as any)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when the target seller plan doesn't exist or is deleted", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" });
    m.sellerPlan.findUnique.mockResolvedValue(null);
    m.sellerPlan.findFirst.mockResolvedValue(null); // findSellerPlan's fallback also finds nothing
    await expect(subscriptionsService.assignVendorPlan(ADMIN_ID, "vendor-1", { plan: "nonexistent" } as any)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("assigns the plan, upserts VendorSubscription, and audits the actor + target", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" });
    m.sellerPlan.findFirst.mockResolvedValue({ id: "plan-growth", slug: "growth", legacyPlan: "GROWTH", deletedAt: null, commissionTiers: [] });
    m.vendorSubscription.upsert.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1", plan: "GROWTH", status: "ACTIVE", sellerPlan: null });

    await subscriptionsService.assignVendorPlan(ADMIN_ID, "vendor-1", { plan: "growth" } as any);

    expect(m.vendorSubscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { vendorId: "vendor-1" },
      update: expect.objectContaining({ sellerPlanId: "plan-growth", status: "ACTIVE" }),
    }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: ADMIN_ID, action: "VENDOR_SELLER_PLAN_ASSIGNED", entityId: "vendor-1" }),
    }));
  });
});
