import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: { count: vi.fn() },
    order: { count: vi.fn() },
    communityCampaign: { count: vi.fn() },
    supplierInvitation: { count: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { destinationsService } from "../modules/auth/destinations.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.product.count.mockResolvedValue(0);
  m.order.count.mockResolvedValue(0);
  m.communityCampaign.count.mockResolvedValue(0);
  m.supplierInvitation.count.mockResolvedValue(0);
});

describe("destinationsService.getForUser", () => {
  it("reports no store and no supplier capability for a plain account", async () => {
    m.user.findUnique.mockResolvedValue({ email: "a@example.test", vendor: null, supplierAccount: null });

    await expect(destinationsService.getForUser("u1")).resolves.toEqual({
      sell: { storeState: "none", ordersNeedingAttention: 0 },
      communityBuy: { activeCount: 0 },
      supply: { supplierState: "NOT_STARTED", invitationCount: 0 },
    });
    expect(m.product.count).not.toHaveBeenCalled();
    expect(m.order.count).not.toHaveBeenCalled();
  });

  it("only calls a store live once it is verified and has a published listing", async () => {
    m.user.findUnique.mockResolvedValue({ email: "a@example.test", vendor: { id: "v1", verificationStatus: "VERIFIED", isSuspended: false }, supplierAccount: null });

    await expect(destinationsService.getForUser("u1")).resolves.toMatchObject({ sell: { storeState: "setup" } });

    m.product.count.mockResolvedValue(2);
    m.order.count.mockResolvedValue(3);
    await expect(destinationsService.getForUser("u1")).resolves.toMatchObject({ sell: { storeState: "live", ordersNeedingAttention: 3 } });
  });

  it("never reports an unverified store as live, even with published rows", async () => {
    m.user.findUnique.mockResolvedValue({ email: "a@example.test", vendor: { id: "v1", verificationStatus: "PENDING", isSuspended: false }, supplierAccount: null });
    m.product.count.mockResolvedValue(5);

    await expect(destinationsService.getForUser("u1")).resolves.toMatchObject({ sell: { storeState: "setup" } });
  });

  it("reports a suspended store as restricted", async () => {
    m.user.findUnique.mockResolvedValue({ email: "a@example.test", vendor: { id: "v1", verificationStatus: "VERIFIED", isSuspended: true }, supplierAccount: null });
    m.product.count.mockResolvedValue(5);

    await expect(destinationsService.getForUser("u1")).resolves.toMatchObject({ sell: { storeState: "restricted" } });
  });

  it("one account can hold a store, Community Buys and supplier approval together", async () => {
    m.user.findUnique.mockResolvedValue({
      email: "Ade@Example.test",
      vendor: { id: "v1", verificationStatus: "VERIFIED", isSuspended: false },
      supplierAccount: { id: "s1", supplierState: "APPROVED" },
    });
    m.product.count.mockResolvedValue(1);
    m.communityCampaign.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    m.supplierInvitation.count.mockResolvedValue(1);

    await expect(destinationsService.getForUser("u1")).resolves.toEqual({
      sell: { storeState: "live", ordersNeedingAttention: 0 },
      communityBuy: { activeCount: 2 },
      supply: { supplierState: "APPROVED", invitationCount: 2 },
    });
    expect(m.supplierInvitation.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ email: "ade@example.test", status: "PENDING" }),
    }));
  });
});
