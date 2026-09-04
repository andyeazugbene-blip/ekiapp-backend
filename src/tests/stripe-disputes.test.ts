import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    stripeDispute: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { stripeDisputesService } from "../modules/stripe/stripe-disputes.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("stripeDisputesService.list", () => {
  it("lists real StripeDispute rows, newest first, optionally filtered by status", async () => {
    m.stripeDispute.findMany.mockResolvedValue([{ id: "d1" }] as never);

    const result = await stripeDisputesService.list("needs_response");

    expect(result).toEqual([{ id: "d1" }]);
    expect(m.stripeDispute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "needs_response" }, orderBy: { createdAt: "desc" } }),
    );
  });
});

describe("stripeDisputesService.markReviewed", () => {
  it("throws when the dispute doesn't exist", async () => {
    m.stripeDispute.findUnique.mockResolvedValue(null);
    await expect(stripeDisputesService.markReviewed("missing", "note")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("is idempotent — an already-resolved dispute is not re-resolved", async () => {
    m.stripeDispute.findUnique.mockResolvedValue({ id: "d1", resolvedAt: new Date("2026-01-01") } as never);
    const result = await stripeDisputesService.markReviewed("d1", "second note");
    expect(result).toEqual({ id: "d1", resolvedAt: new Date("2026-01-01") });
    expect(m.stripeDispute.update).not.toHaveBeenCalled();
  });

  it("marks an open dispute reviewed with the given note", async () => {
    m.stripeDispute.findUnique.mockResolvedValue({ id: "d2", resolvedAt: null } as never);
    m.stripeDispute.update.mockResolvedValue({ id: "d2", resolvedAt: new Date(), note: "handled" } as never);

    await stripeDisputesService.markReviewed("d2", "handled");

    expect(m.stripeDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d2" }, data: expect.objectContaining({ note: "handled" }) }),
    );
  });
});
