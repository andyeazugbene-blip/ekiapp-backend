/**
 * Acceptance audit fix (vendor journey audit, Section C.7) — a vendor's
 * VendorSubscription.status is correctly synced from real Stripe billing
 * events (Defect D: checkout, invoice.payment_failed,
 * customer.subscription.updated/deleted), but nothing ever READ that status
 * to decide entitlement. getPlanForSubscription() resolved purely from
 * sellerPlanId/plan, so once a vendor reached Growth/Pro they kept full
 * access forever — through trial expiry, a failed renewal, or the
 * subscription actually ending — because sellerPlanId itself was never
 * reset. Fixed by gating entitlement on status === "ACTIVE" instead.
 *
 * cancelSubscription() had a related bug: it flipped status to CANCELLED
 * the instant a vendor requested cancellation, even though
 * cancel_at_period_end: true means Stripe (and the entitlement fix above)
 * should keep access live until the period actually ends. Fixed to only
 * record cancelledAt for a live Stripe subscription; the real CANCELLED
 * transition now happens via the existing customer.subscription.deleted
 * webhook at the real period end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    vendorSubscription: { findUnique: vi.fn(), update: vi.fn() },
    sellerPlan: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    subscriptionPlanConfig: { count: vi.fn().mockResolvedValue(1) },
    product: { count: vi.fn().mockResolvedValue(0) },
    order: { count: vi.fn().mockResolvedValue(0) },
    promoCode: { count: vi.fn().mockResolvedValue(0) },
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: {
    subscriptions: { update: vi.fn().mockResolvedValue({}) },
  },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { subscriptionsService } from "../modules/subscriptions/subscriptions.service";

const m = vi.mocked(prisma, true) as any;
const stripeSubUpdate = vi.mocked(stripe.subscriptions.update);

beforeEach(() => vi.clearAllMocks());

describe("cancelSubscription — defers the CANCELLED status transition to the real webhook", () => {
  it("a live Stripe subscription: only sets cancelledAt, leaves status untouched, calls Stripe with cancel_at_period_end", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" });
    m.vendorSubscription.findUnique.mockResolvedValue({
      id: "vs-1", vendorId: "vendor-1", status: "ACTIVE", stripeSubscriptionId: "sub_123",
    });
    m.vendorSubscription.update.mockResolvedValue({
      id: "vs-1", plan: "GROWTH", status: "ACTIVE", cancelledAt: new Date(), sellerPlan: null,
    });

    await subscriptionsService.cancelSubscription("user-1");

    expect(stripeSubUpdate).toHaveBeenCalledWith("sub_123", { cancel_at_period_end: true });
    expect(m.vendorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "vs-1" },
        data: { cancelledAt: expect.any(Date) },
      }),
    );
  });

  it("no live Stripe subscription: cancels immediately (nothing to defer to)", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" });
    m.vendorSubscription.findUnique.mockResolvedValue({
      id: "vs-1", vendorId: "vendor-1", status: "ACTIVE", stripeSubscriptionId: null,
    });
    m.vendorSubscription.update.mockResolvedValue({
      id: "vs-1", plan: "FREE", status: "CANCELLED", cancelledAt: new Date(), sellerPlan: null,
    });

    await subscriptionsService.cancelSubscription("user-1");

    expect(stripeSubUpdate).not.toHaveBeenCalled();
    expect(m.vendorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "vs-1" },
        data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
      }),
    );
  });

  it("rejects re-cancelling an already-CANCELLED subscription", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", status: "CANCELLED" });

    await expect(subscriptionsService.cancelSubscription("user-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.vendorSubscription.update).not.toHaveBeenCalled();
  });
});

describe("getPlanForSubscription (via getVendorAccount) — entitlement gated on status, real sellerPlan DB path", () => {
  const growthPlan = {
    id: "plan-growth", slug: "growth", name: "Growth", legacyPlan: "GROWTH",
    monthlyPriceCents: 999, currency: "GBP", defaultPlatformFeeBps: 1000, withdrawalFeeBps: 200,
    maxProducts: -1, maxImagesPerProduct: 10, maxOrders: null, analytics: true, prioritySupport: true,
    flashSales: true, bundles: true, discounts: true, marketingTools: true, canReceiveOrders: true,
    isActive: true, isDefault: false, deletedAt: null, displayOrder: 1, commissionTiers: [],
  };
  const starterPlan = {
    ...growthPlan, id: "plan-starter", slug: "starter", name: "Starter", legacyPlan: "FREE",
    monthlyPriceCents: 0, maxProducts: 25, analytics: false, prioritySupport: false,
    flashSales: false, bundles: false, discounts: false, marketingTools: false, isDefault: true,
  };

  function mockVendorForAccount() {
    m.vendor.findUnique.mockResolvedValue({
      userId: "user-1", id: "vendor-1", isSuspended: false, verificationStatus: "VERIFIED", isActive: true,
      user: { email: "vendor@test.com", name: "Vendor" },
    });
  }

  it("ACTIVE Growth subscription resolves the real Growth sellerPlan row from the DB", async () => {
    mockVendorForAccount();
    m.vendorSubscription.findUnique.mockResolvedValue({ sellerPlanId: "plan-growth", plan: "GROWTH", status: "ACTIVE", currentPeriodEnd: null });
    m.sellerPlan.findUnique.mockResolvedValue(growthPlan);
    m.product.count = vi.fn().mockResolvedValue(0);
    m.order.count = vi.fn().mockResolvedValue(0);
    m.promoCode.count = vi.fn().mockResolvedValue(0);

    const result = await subscriptionsService.getVendorAccount("user-1");
    expect(result.serviceLevel).toBe("growth");
    expect(result.limits.canSendOffers).toBe(true);
  });

  it("PAST_DUE Growth subscription falls back to Starter even though sellerPlanId still points at Growth", async () => {
    mockVendorForAccount();
    m.vendorSubscription.findUnique.mockResolvedValue({ sellerPlanId: "plan-growth", plan: "GROWTH", status: "PAST_DUE", currentPeriodEnd: null });
    m.sellerPlan.findFirst = vi.fn().mockResolvedValue(starterPlan);
    m.product.count = vi.fn().mockResolvedValue(0);
    m.order.count = vi.fn().mockResolvedValue(0);
    m.promoCode.count = vi.fn().mockResolvedValue(0);

    const result = await subscriptionsService.getVendorAccount("user-1");

    // The Growth row is never even looked up for an inactive subscription —
    // getStarterPlan()'s findFirst is called instead of sellerPlan.findUnique.
    expect(m.sellerPlan.findUnique).not.toHaveBeenCalled();
    expect(result.serviceLevel).toBe("starter");
    expect(result.limits.canSendOffers).toBe(false);
  });

  it("CANCELLED Growth subscription (real end, past its final period) also falls back to Starter", async () => {
    mockVendorForAccount();
    m.vendorSubscription.findUnique.mockResolvedValue({ sellerPlanId: "plan-growth", plan: "GROWTH", status: "CANCELLED", currentPeriodEnd: null });
    m.sellerPlan.findFirst = vi.fn().mockResolvedValue(starterPlan);
    m.product.count = vi.fn().mockResolvedValue(0);
    m.order.count = vi.fn().mockResolvedValue(0);
    m.promoCode.count = vi.fn().mockResolvedValue(0);

    const result = await subscriptionsService.getVendorAccount("user-1");
    expect(result.serviceLevel).toBe("starter");
  });
});
