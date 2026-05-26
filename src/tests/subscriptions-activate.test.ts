/**
 * Tests for POST /api/subscriptions/activate.
 *
 * Soft-launch policy:
 *   - FREE plan: activated immediately.
 *   - Paid plans (BASIC/GROWTH/PREMIUM/PRO): rejected with 409 +
 *     code SUBSCRIPTIONS_NOT_AVAILABLE so the frontend never sees a fake
 *     active paid subscription. Real activation happens via the existing
 *     Stripe Checkout flow (POST /api/subscriptions/checkout).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    vendorSubscription: { upsert: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { subscriptionsService } from "../modules/subscriptions/subscriptions.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("subscriptionsService.activatePlan — soft-launch policy", () => {
  it("403 when no vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(
      subscriptionsService.activatePlan("user-1", { plan: "FREE" } as never),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("activates FREE plan without payment", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.vendorSubscription.upsert.mockResolvedValue({
      id: "sub-1",
      vendorId: "vendor-1",
      plan: "FREE",
      status: "ACTIVE",
    } as never);

    const result = await subscriptionsService.activatePlan("user-1", { plan: "FREE" } as never);
    expect(result.subscription.plan).toBe("FREE");
    expect(m.vendorSubscription.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects GROWTH with SUBSCRIPTIONS_NOT_AVAILABLE (409, no fake activation)", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);

    await expect(
      subscriptionsService.activatePlan("user-1", { plan: "GROWTH" } as never),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUBSCRIPTIONS_NOT_AVAILABLE",
    });
    expect(m.vendorSubscription.upsert).not.toHaveBeenCalled();
  });

  it("rejects PRO with SUBSCRIPTIONS_NOT_AVAILABLE (no fake activation)", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);

    await expect(
      subscriptionsService.activatePlan("user-1", { plan: "PRO" } as never),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUBSCRIPTIONS_NOT_AVAILABLE",
    });
    expect(m.vendorSubscription.upsert).not.toHaveBeenCalled();
  });

  it("rejects BASIC and PREMIUM the same way", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);

    for (const plan of ["BASIC", "PREMIUM"] as const) {
      await expect(
        subscriptionsService.activatePlan("user-1", { plan } as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "SUBSCRIPTIONS_NOT_AVAILABLE",
      });
    }
  });
});
