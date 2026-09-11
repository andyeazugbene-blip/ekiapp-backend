import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    buyerSubscription: { findUnique: vi.fn(), update: vi.fn() },
    subscriptionOffer: { findUnique: vi.fn() },
    renewal: { findFirst: vi.fn() },
    subscriptionActionHistory: { create: vi.fn() },
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { buyerSubscriptionsService } from "../modules/regular-deliveries/buyer-subscriptions.service";

const m = vi.mocked(prisma, true);
const enqueue = vi.mocked(notificationsService.enqueue);

const ACTIVE_SUB = {
  id: "sub-1",
  buyerId: "buyer-1",
  offerId: "offer-1",
  status: "ACTIVE" as const,
  frequency: "WEEKLY" as const,
  nextRenewalAt: new Date("2026-06-01T00:00:00.000Z"),
};

const OFFER_ALL_FREQUENCIES = {
  frequencies: ["WEEKLY", "BIWEEKLY", "EVERY_4_WEEKS", "MONTHLY"],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.subscriptionOffer.findUnique.mockResolvedValue(OFFER_ALL_FREQUENCIES as never);
  m.renewal.findFirst.mockResolvedValue(null);
  m.buyerSubscription.update.mockImplementation(async ({ data }: any) => ({ ...ACTIVE_SUB, ...data }));
});

describe("buyerSubscriptionsService.changeFrequency — Final Client Decision 3", () => {
  const transitions: Array<{ from: typeof ACTIVE_SUB.frequency; to: "WEEKLY" | "BIWEEKLY" | "EVERY_4_WEEKS" | "MONTHLY"; days: number }> = [
    { from: "WEEKLY", to: "BIWEEKLY", days: 14 },
    { from: "BIWEEKLY", to: "MONTHLY", days: 30 },
    { from: "MONTHLY", to: "EVERY_4_WEEKS", days: 28 },
    { from: "EVERY_4_WEEKS", to: "WEEKLY", days: 7 },
  ];

  for (const { from, to, days } of transitions) {
    it(`${from} → ${to} updates frequency, recalculates nextRenewalAt, and notifies the buyer`, async () => {
      m.buyerSubscription.findUnique.mockResolvedValue({ ...ACTIVE_SUB, frequency: from } as never);

      const result = await buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", to);

      expect(result.frequency).toBe(to);
      const expectedNext = new Date(ACTIVE_SUB.nextRenewalAt);
      expectedNext.setUTCDate(expectedNext.getUTCDate() + days);
      expect((result as any).nextRenewalAt.toISOString()).toBe(expectedNext.toISOString());
      expect(m.subscriptionActionHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "frequency_changed", actorUserId: "buyer-1" }) }),
      );
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "buyer-1", data: expect.objectContaining({ type: "regular_delivery_frequency_changed", previousFrequency: from, newFrequency: to }) }),
      );
    });
  }

  it("leaves the locked upcoming renewal alone when it is already PAYMENT_PROCESSING and applies the new frequency from the cycle after it", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(ACTIVE_SUB as never);
    m.renewal.findFirst.mockResolvedValue({ id: "renewal-locked" } as never);

    const result = await buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", "BIWEEKLY");

    expect(m.renewal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          subscriptionId: "sub-1",
          cycleDate: ACTIVE_SUB.nextRenewalAt,
          status: { in: ["PAYMENT_PROCESSING", "PAID", "ORDER_CREATED"] },
        }),
      }),
    );
    expect(result.frequency).toBe("BIWEEKLY");
  });

  it("rejects when the new frequency equals the current one (duplicate request)", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(ACTIVE_SUB as never);
    await expect(buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", "WEEKLY")).rejects.toThrow(
      "Subscription already uses this frequency",
    );
    expect(m.buyerSubscription.update).not.toHaveBeenCalled();
  });

  it("rejects when the subscription is not ACTIVE (e.g. PAUSED)", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue({ ...ACTIVE_SUB, status: "PAUSED" } as never);
    await expect(buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", "BIWEEKLY")).rejects.toThrow(
      "Only an active subscription can change its frequency",
    );
  });

  it("rejects a frequency the vendor's offer does not support", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(ACTIVE_SUB as never);
    m.subscriptionOffer.findUnique.mockResolvedValue({ frequencies: ["WEEKLY"] } as never);
    await expect(buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", "MONTHLY")).rejects.toThrow(/does not support/);
  });

  it("rejects a buyer changing a subscription they do not own (IDOR / unauthorized)", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue({ ...ACTIVE_SUB, buyerId: "someone-else" } as never);
    await expect(buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", "BIWEEKLY")).rejects.toThrow(
      "Subscription not found",
    );
    expect(m.buyerSubscription.update).not.toHaveBeenCalled();
  });

  it("treats two concurrent change requests independently — the second call re-reads the (by-then-updated) subscription rather than trusting a stale in-memory value", async () => {
    m.buyerSubscription.findUnique
      .mockResolvedValueOnce(ACTIVE_SUB as never)
      .mockResolvedValueOnce({ ...ACTIVE_SUB, frequency: "BIWEEKLY" } as never);

    const first = await buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", "BIWEEKLY");
    const second = await buyerSubscriptionsService.changeFrequency("buyer-1", "sub-1", "MONTHLY");

    expect(first.frequency).toBe("BIWEEKLY");
    expect(second.frequency).toBe("MONTHLY");
    expect(m.buyerSubscription.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("buyerSubscriptionsService.adminChangeFrequency — Final Client Decision 3 (support action)", () => {
  it("requires a non-empty reason", async () => {
    await expect(buyerSubscriptionsService.adminChangeFrequency("admin-1", "sub-1", "BIWEEKLY", "")).rejects.toThrow(
      "A reason is required for admin frequency changes",
    );
    expect(m.buyerSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only reason", async () => {
    await expect(buyerSubscriptionsService.adminChangeFrequency("admin-1", "sub-1", "BIWEEKLY", "   ")).rejects.toThrow(
      "A reason is required for admin frequency changes",
    );
  });

  it("records previous frequency, new frequency, reason, and actor; notifies the buyer that admin made the change", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(ACTIVE_SUB as never);

    const { previousFrequency, newFrequency } = await buyerSubscriptionsService.adminChangeFrequency(
      "admin-1",
      "sub-1",
      "MONTHLY",
      "Buyer called support and requested this by phone, ref #4821",
    );

    expect(previousFrequency).toBe("WEEKLY");
    expect(newFrequency).toBe("MONTHLY");
    expect(m.subscriptionActionHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "admin_frequency_changed",
          actorUserId: "admin-1",
          metadata: expect.objectContaining({
            previousFrequency: "WEEKLY",
            newFrequency: "MONTHLY",
            reason: "Buyer called support and requested this by phone, ref #4821",
          }),
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "buyer-1", data: expect.objectContaining({ changedByAdmin: true }) }),
    );
  });

  it("rejects when the target subscription does not exist", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(null as never);
    await expect(buyerSubscriptionsService.adminChangeFrequency("admin-1", "missing", "BIWEEKLY", "reason")).rejects.toThrow(
      "Subscription not found",
    );
  });

  it("rejects when the target subscription is not ACTIVE", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue({ ...ACTIVE_SUB, status: "CANCELLED" } as never);
    await expect(buyerSubscriptionsService.adminChangeFrequency("admin-1", "sub-1", "BIWEEKLY", "reason")).rejects.toThrow(
      "Only an active subscription can change its frequency",
    );
  });

  it("rejects a duplicate-frequency admin correction the same way as the buyer path", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(ACTIVE_SUB as never);
    await expect(buyerSubscriptionsService.adminChangeFrequency("admin-1", "sub-1", "WEEKLY", "reason")).rejects.toThrow(
      "Subscription already uses this frequency",
    );
  });
});
