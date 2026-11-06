import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  demand: { findMany: vi.fn() },
  supplier: { findMany: vi.fn() },
  notify: vi.fn(),
  settingGet: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: { demandRequest: m.demand, supplierAccount: m.supplier },
}));
vi.mock("../modules/community-buy/community-buy-notices", () => ({ notifyUserInAppAndEmail: m.notify }));
vi.mock("../modules/admin/launch-settings.service", () => ({ launchSettingsService: { get: m.settingGet } }));
vi.mock("../modules/community-buy/review-requests.service", () => ({ reviewRequestsService: {} }));

import { supplierOffersService } from "../modules/community-buy/supplier-offers.service";
import { discoveryScore } from "../modules/vendors/vendors.service";

const NOW = new Date("2026-11-06T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const STORE = { totalOrders: 0, totalProducts: 2, hasAvatar: false, rating: 0, totalReviews: 0, createdAt: daysAgo(5) };

describe("discovery ranking", () => {
  it("lifts a new store that has foodstuff but no orders", () => {
    expect(discoveryScore(STORE, 30, NOW)).toBeGreaterThan(discoveryScore(STORE, 0, NOW));
  });

  it("stops once the boost window ends", () => {
    expect(discoveryScore({ ...STORE, createdAt: daysAgo(31) }, 30, NOW)).toBe(discoveryScore(STORE, 0, NOW));
  });

  it("never lifts an empty store", () => {
    expect(discoveryScore({ ...STORE, totalProducts: 0 }, 30, NOW)).toBe(0);
  });

  it("stops at the first order", () => {
    expect(discoveryScore({ ...STORE, totalOrders: 1 }, 30, NOW)).toBe(discoveryScore({ ...STORE, totalOrders: 1 }, 0, NOW));
  });

  it("doesn't let a boosted store outrank a proven one", () => {
    const proven = { ...STORE, totalOrders: 10, totalProducts: 10, rating: 4.5, totalReviews: 6, createdAt: daysAgo(200) };
    expect(discoveryScore(proven, 30, NOW)).toBeGreaterThan(discoveryScore(STORE, 30, NOW));
  });

  it("counts rating only when there are reviews", () => {
    expect(discoveryScore({ ...STORE, createdAt: daysAgo(90), rating: 5, totalReviews: 0 }, 0, NOW)).toBe(4);
    expect(discoveryScore({ ...STORE, createdAt: daysAgo(90), rating: 5, totalReviews: 2 }, 0, NOW)).toBe(14);
  });
});

describe("demand matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.settingGet.mockResolvedValue(3);
    m.notify.mockResolvedValue(undefined);
  });

  const requests = (foodstuff: string, count: number) => Array.from({ length: count }, () => ({ foodstuff }));

  it("waits for enough requests", async () => {
    m.demand.findMany.mockResolvedValue(requests("Yam", 2));
    expect(await supplierOffersService.matchDemandToSuppliers(NOW)).toEqual({ foodstuffs: 0, notified: 0 });
    expect(m.supplier.findMany).not.toHaveBeenCalled();
  });

  it("ignores upper and lower case when counting, and tells only suppliers of it", async () => {
    m.demand.findMany.mockResolvedValue([{ foodstuff: "Puna Yam" }, { foodstuff: "puna yam" }, { foodstuff: " PUNA YAM " }]);
    m.supplier.findMany.mockResolvedValue([{ userId: "yam-supplier", categories: ["Yam"] }, { userId: "oil-supplier", categories: ["Oil"] }, { userId: "no-categories", categories: [] }]);

    const result = await supplierOffersService.matchDemandToSuppliers(NOW);

    expect(result).toEqual({ foodstuffs: 1, notified: 1 });
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify.mock.calls[0][0]).toMatchObject({ userId: "yam-supplier", event: "demand_match" });
  });

  it("only looks at approved real suppliers, and real requests from the last week", async () => {
    m.demand.findMany.mockResolvedValue(requests("Yam", 3));
    m.supplier.findMany.mockResolvedValue([]);
    await supplierOffersService.matchDemandToSuppliers(NOW);
    expect(m.demand.findMany.mock.calls[0][0].where).toEqual({ createdAt: { gte: daysAgo(7) }, user: { isTest: false } });
    expect(m.supplier.findMany.mock.calls[0][0].where).toEqual({ supplierState: "APPROVED", user: { isTest: false } });
  });

  it("repeats at most weekly per supplier and foodstuff", async () => {
    m.demand.findMany.mockResolvedValue(requests("Yam", 3));
    m.supplier.findMany.mockResolvedValue([{ userId: "s1", categories: ["Yam"] }]);
    await supplierOffersService.matchDemandToSuppliers(NOW);
    await supplierOffersService.matchDemandToSuppliers(new Date(NOW.getTime() + 3_600_000));
    expect(m.notify.mock.calls[0][0].dedupeKey).toBe(m.notify.mock.calls[1][0].dedupeKey);
  });
});
