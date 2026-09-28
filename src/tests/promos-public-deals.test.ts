import { describe, it, expect, vi, beforeEach } from "vitest";

// promosService.listPublicDeals is the legacy "Hot Deals" read the buyer
// Home screen actually calls (GET /api/promo-codes/deals) — it snapshots
// productIds from an audit-log blob taken at deal-creation time rather than
// joining the live Product row, so it never noticed a vendor unpublishing
// (drafting) a product afterward. These tests guard the fix: every
// referenced product's current isActive state is re-checked on every read.
vi.mock("../lib/prisma", () => ({
  prisma: {
    promoCode: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { promosService } from "../modules/promos/promos.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

function promoRow(id: string, code: string) {
  return { id, vendorId: "vendor-1", code, value: 500, type: "FIXED_AMOUNT", vendor: { storeName: "Queen Foods" }, validUntil: null };
}

function auditRow(entityId: string, productIds: string[]) {
  return { entityId, metadata: { productIds, audience: "all" } };
}

describe("promosService.listPublicDeals — draft/unpublished products never shown live", () => {
  it("keeps a bundle deal but drops the drafted product from its productIds, when at least one item is still active", async () => {
    m.promoCode.findMany
      .mockResolvedValueOnce([promoRow("promo-1", "BUNDLE1")] as never) // bundles scan
      .mockResolvedValueOnce([] as never); // flash scan
    m.auditLog.findMany.mockResolvedValue([auditRow("promo-1", ["p-active", "p-drafted"])] as never);
    m.product.findMany.mockResolvedValue([{ id: "p-active" }] as never); // only p-active is still isActive:true

    const deals = await promosService.listPublicDeals();

    expect(deals.bundles).toHaveLength(1);
    expect(deals.bundles[0].productIds).toEqual(["p-active"]);
  });

  it("drops a bundle deal entirely once every one of its products has been drafted", async () => {
    m.promoCode.findMany
      .mockResolvedValueOnce([promoRow("promo-1", "BUNDLE1")] as never)
      .mockResolvedValueOnce([] as never);
    m.auditLog.findMany.mockResolvedValue([auditRow("promo-1", ["p-drafted-1", "p-drafted-2"])] as never);
    m.product.findMany.mockResolvedValue([] as never); // neither is active any more

    const deals = await promosService.listPublicDeals();

    expect(deals.bundles).toEqual([]);
  });

  it("keeps a store-wide deal (no productIds ever logged) regardless of any product's draft state", async () => {
    m.promoCode.findMany
      .mockResolvedValueOnce([promoRow("promo-1", "BUNDLE1")] as never)
      .mockResolvedValueOnce([] as never);
    m.auditLog.findMany.mockResolvedValue([auditRow("promo-1", [])] as never);
    m.product.findMany.mockResolvedValue([] as never);

    const deals = await promosService.listPublicDeals();

    expect(deals.bundles).toHaveLength(1);
    expect(deals.bundles[0].productIds).toEqual([]);
  });

  it("drops a flash-sale deal once its one product has been drafted", async () => {
    m.promoCode.findMany
      .mockResolvedValueOnce([] as never) // bundles scan
      .mockResolvedValueOnce([promoRow("promo-2", "FLASH1")] as never); // flash scan
    m.auditLog.findMany.mockResolvedValue([auditRow("promo-2", ["p-drafted"])] as never);
    m.product.findMany.mockResolvedValue([] as never);

    const deals = await promosService.listPublicDeals();

    expect(deals.flashSales).toEqual([]);
  });

  it("keeps a flash-sale deal whose product is still active", async () => {
    m.promoCode.findMany
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([promoRow("promo-2", "FLASH1")] as never);
    m.auditLog.findMany.mockResolvedValue([auditRow("promo-2", ["p-active"])] as never);
    m.product.findMany.mockResolvedValue([{ id: "p-active" }] as never);

    const deals = await promosService.listPublicDeals();

    expect(deals.flashSales).toHaveLength(1);
    expect(deals.flashSales[0].productId).toBe("p-active");
  });

  it("skips the product lookup entirely when no deal references any product (no wasted query)", async () => {
    m.promoCode.findMany.mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);
    m.auditLog.findMany.mockResolvedValue([] as never);

    const deals = await promosService.listPublicDeals();

    expect(m.product.findMany).not.toHaveBeenCalled();
    expect(deals).toEqual({ bundles: [], flashSales: [] });
  });
});
