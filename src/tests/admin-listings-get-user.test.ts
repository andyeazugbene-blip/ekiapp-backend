import { describe, it, expect, vi, beforeEach } from "vitest";

// adminListingsService.getUser is the admin-web user detail screen's data
// source. Support agents complained the old bare profile row (name/email/
// role/status/joined) wasn't enough to investigate an account, so this now
// joins in recent orders and related capability profiles — the same kind
// of enrichment getVendor() already does for a store. These tests guard
// that the joins are actually wired, not the read-only profile fields
// (those are a straight Prisma select, nothing to regress).
vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    order: { findMany: vi.fn(), count: vi.fn() },
    conversation: { findFirst: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminListingsService } from "../modules/admin/admin-listings.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("adminListingsService.getUser — enough context for real support/account investigation", () => {
  it("throws 404 when the user doesn't exist", async () => {
    m.user.findUnique.mockResolvedValue(null as never);
    await expect(adminListingsService.getUser("nope")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.order.findMany).not.toHaveBeenCalled();
  });

  it("attaches recent orders, a total order count, and the support conversation id when one exists", async () => {
    m.user.findUnique.mockResolvedValue({ id: "u1", role: "BUYER", vendor: null, organiserProfile: null, supplierAccount: null } as never);
    m.order.findMany.mockResolvedValue([{ id: "o1", orderNumber: "ORD-1", status: "DELIVERED", totalAmount: 5000, currency: "GBP", createdAt: new Date() }] as never);
    m.order.count.mockResolvedValue(7 as never);
    m.conversation.findFirst.mockResolvedValue({ id: "conv-1" } as never);

    const user = await adminListingsService.getUser("u1");

    expect(m.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { buyerId: "u1" } }));
    expect(m.order.count).toHaveBeenCalledWith({ where: { buyerId: "u1" } });
    expect(m.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: "SUPPORT", OR: [{ participantA: "u1" }, { participantB: "u1" }] } }),
    );
    expect(user.recentOrders).toHaveLength(1);
    expect(user.orderCount).toBe(7);
    expect(user.supportConversationId).toBe("conv-1");
  });

  it("supportConversationId is null when the user has never started a support conversation", async () => {
    m.user.findUnique.mockResolvedValue({ id: "u2", role: "BUYER", vendor: null, organiserProfile: null, supplierAccount: null } as never);
    m.order.findMany.mockResolvedValue([] as never);
    m.order.count.mockResolvedValue(0 as never);
    m.conversation.findFirst.mockResolvedValue(null as never);

    const user = await adminListingsService.getUser("u2");

    expect(user.supportConversationId).toBeNull();
    expect(user.recentOrders).toEqual([]);
    expect(user.orderCount).toBe(0);
  });

  it("passes through the joined vendor/organiser/supplier snapshots untouched", async () => {
    const vendor = { id: "v1", storeName: "Queen Foods", verificationStatus: "APPROVED", isSuspended: false, country: "GB" };
    m.user.findUnique.mockResolvedValue({ id: "u3", role: "VENDOR", vendor, organiserProfile: null, supplierAccount: null } as never);
    m.order.findMany.mockResolvedValue([] as never);
    m.order.count.mockResolvedValue(0 as never);
    m.conversation.findFirst.mockResolvedValue(null as never);

    const user = await adminListingsService.getUser("u3");

    expect(user.vendor).toEqual(vendor);
  });
});
