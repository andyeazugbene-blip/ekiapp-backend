/**
 * VendorMarketAssignment — the additive multi-market layer. Vendor.country/
 * Vendor.currency remain the vendor's PRIMARY market (every existing
 * single-country call site keeps working unchanged); this table lets a
 * vendor hold more than one active, independently-resolved market.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendorMarketAssignment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock("../modules/community-buy/market-configuration.service", () => ({
  marketConfigurationService: { get: vi.fn() },
}));

vi.mock("../shared/utils/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { recordAudit } from "../shared/utils/audit";
import { resolveCurrencyForMarket, vendorMarketsService } from "../modules/vendors/vendor-markets.service";

const m = vi.mocked(prisma, true);
const getMarketConfig = vi.mocked(marketConfigurationService.get);
const audit = vi.mocked(recordAudit);

beforeEach(() => {
  vi.clearAllMocks();
  getMarketConfig.mockImplementation(async (code: string) => {
    const table: Record<string, { currency: string }> = {
      GB: { currency: "GBP" }, US: { currency: "USD" }, CA: { currency: "CAD" },
      FR: { currency: "EUR" }, ES: { currency: "EUR" }, PT: { currency: "EUR" },
      CH: { currency: "CHF" }, BE: { currency: "EUR" }, IT: { currency: "EUR" }, HR: { currency: "EUR" },
    };
    return (table[code] ?? null) as never;
  });
});

describe("resolveCurrencyForMarket — per-market currency, not the coarser legacy map", () => {
  it("resolves Canada to CAD via MarketConfiguration, not EUR (currencyFromCountry has no CA entry)", async () => {
    expect(await resolveCurrencyForMarket("Canada")).toBe("CAD");
  });

  it("resolves Switzerland to CHF via MarketConfiguration, not EUR", async () => {
    expect(await resolveCurrencyForMarket("Switzerland")).toBe("CHF");
  });

  it("falls back to the legacy currencyFromCountry map for a non-launch-market country", async () => {
    expect(await resolveCurrencyForMarket("Nigeria")).toBe("NGN");
  });
});

describe("vendorMarketsService.addMarket", () => {
  it("rejects a market outside the 10 approved launch markets", async () => {
    await expect(
      vendorMarketsService.addMarket({ vendorId: "v1", actorId: "a1", rawMarket: "Nigeria" }),
    ).rejects.toThrow(/approved launch markets/i);
    expect(m.vendorMarketAssignment.upsert).not.toHaveBeenCalled();
  });

  it("creates a new active assignment with the market's own resolved currency, independent of any other market", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue(null as never);
    m.vendorMarketAssignment.upsert.mockResolvedValue({ marketCode: "FR", countryName: "France", currency: "EUR", enabled: true } as never);

    const result = await vendorMarketsService.addMarket({ vendorId: "v1", actorId: "a1", rawMarket: "France" });

    expect(result.currency).toBe("EUR");
    expect(m.vendorMarketAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vendorId_marketCode: { vendorId: "v1", marketCode: "FR" } },
        create: expect.objectContaining({ marketCode: "FR", countryName: "France", currency: "EUR", enabled: true }),
      }),
    );
  });

  it("re-adding an already-assigned market (duplicate) re-enables it via upsert rather than erroring or creating a second row", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ marketCode: "GB", enabled: false } as never);
    m.vendorMarketAssignment.upsert.mockResolvedValue({ marketCode: "GB", enabled: true } as never);

    const result = await vendorMarketsService.addMarket({ vendorId: "v1", actorId: "a1", rawMarket: "United Kingdom" });

    expect(result.enabled).toBe(true);
    expect(m.vendorMarketAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ enabled: true }) }),
    );
  });

  it("records a real audit entry with before/after state", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue(null as never);
    m.vendorMarketAssignment.upsert.mockResolvedValue({ marketCode: "FR", countryName: "France", currency: "EUR", enabled: true } as never);

    await vendorMarketsService.addMarket({ vendorId: "v1", actorId: "admin-1", rawMarket: "France", reason: "vendor requested expansion" });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "admin-1", action: "vendor.market.add", entityId: "v1", reason: "vendor requested expansion" }),
    );
  });
});

describe("vendorMarketsService.removeMarket — must keep at least one active market", () => {
  it("refuses to remove a vendor's only active market", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ id: "vma-1", marketCode: "GB", enabled: true } as never);
    m.vendorMarketAssignment.count.mockResolvedValue(1 as never);

    await expect(
      vendorMarketsService.removeMarket({ vendorId: "v1", actorId: "a1", rawMarket: "GB" }),
    ).rejects.toThrow(/at least one active market/i);
    expect(m.vendorMarketAssignment.delete).not.toHaveBeenCalled();
  });

  it("allows removing one of two active markets", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ id: "vma-2", marketCode: "FR", enabled: true } as never);
    m.vendorMarketAssignment.count.mockResolvedValue(2 as never);
    m.vendorMarketAssignment.delete.mockResolvedValue({} as never);

    await vendorMarketsService.removeMarket({ vendorId: "v1", actorId: "a1", rawMarket: "FR" });

    expect(m.vendorMarketAssignment.delete).toHaveBeenCalledWith({ where: { id: "vma-2" } });
  });

  it("allows removing an already-disabled market without the active-count guard", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ id: "vma-2", marketCode: "FR", enabled: false } as never);
    m.vendorMarketAssignment.delete.mockResolvedValue({} as never);

    await vendorMarketsService.removeMarket({ vendorId: "v1", actorId: "a1", rawMarket: "FR" });

    expect(m.vendorMarketAssignment.count).not.toHaveBeenCalled();
    expect(m.vendorMarketAssignment.delete).toHaveBeenCalled();
  });

  it("404s when the vendor has no assignment for that market", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue(null as never);

    await expect(
      vendorMarketsService.removeMarket({ vendorId: "v1", actorId: "a1", rawMarket: "FR" }),
    ).rejects.toThrow(/no assignment/i);
  });
});

describe("vendorMarketsService.setEnabled — soft toggle, same last-active-market guard when disabling", () => {
  it("refuses to disable a vendor's only active market", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ id: "vma-1", marketCode: "GB", enabled: true } as never);
    m.vendorMarketAssignment.count.mockResolvedValue(1 as never);

    await expect(
      vendorMarketsService.setEnabled({ vendorId: "v1", actorId: "a1", rawMarket: "GB", enabled: false }),
    ).rejects.toThrow(/at least one active market/i);
    expect(m.vendorMarketAssignment.update).not.toHaveBeenCalled();
  });

  it("allows disabling one of two active markets", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ id: "vma-2", marketCode: "FR", enabled: true } as never);
    m.vendorMarketAssignment.count.mockResolvedValue(2 as never);
    m.vendorMarketAssignment.update.mockResolvedValue({ marketCode: "FR", enabled: false } as never);

    const result = await vendorMarketsService.setEnabled({ vendorId: "v1", actorId: "a1", rawMarket: "FR", enabled: false });

    expect(result.enabled).toBe(false);
  });

  it("re-enabling a disabled market never needs the active-count guard", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ id: "vma-2", marketCode: "FR", enabled: false } as never);
    m.vendorMarketAssignment.update.mockResolvedValue({ marketCode: "FR", enabled: true } as never);

    await vendorMarketsService.setEnabled({ vendorId: "v1", actorId: "a1", rawMarket: "FR", enabled: true });

    expect(m.vendorMarketAssignment.count).not.toHaveBeenCalled();
  });
});

describe("vendorMarketsService.hasActiveMarket — the backend-authoritative gate", () => {
  it("returns false for a market outside the launch list, without querying the DB", async () => {
    expect(await vendorMarketsService.hasActiveMarket("v1", "Nigeria")).toBe(false);
    expect(m.vendorMarketAssignment.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for an inactive (disabled) assignment", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ enabled: false } as never);
    expect(await vendorMarketsService.hasActiveMarket("v1", "France")).toBe(false);
  });

  it("returns true only for an active assignment on the exact market", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ enabled: true } as never);
    expect(await vendorMarketsService.hasActiveMarket("v1", "France")).toBe(true);
  });

  it("returns false when the vendor has no row for that market at all", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue(null as never);
    expect(await vendorMarketsService.hasActiveMarket("v1", "France")).toBe(false);
  });
});

describe("vendorMarketsService.ensureInitialAssignment — preserves legacy/grandfathered vendor data without granting new access", () => {
  it("creates a canonical-code assignment for an approved launch market", async () => {
    m.vendorMarketAssignment.upsert.mockResolvedValue({} as never);

    await vendorMarketsService.ensureInitialAssignment("v1", "United Kingdom");

    expect(m.vendorMarketAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vendorId_marketCode: { vendorId: "v1", marketCode: "GB" } },
        create: expect.objectContaining({ marketCode: "GB", countryName: "United Kingdom", currency: "GBP", enabled: true }),
      }),
    );
  });

  it("still creates a row for a legacy non-launch-market country (e.g. Nigeria), under a non-canonical code — preserves data without granting real launch-market access", async () => {
    m.vendorMarketAssignment.upsert.mockResolvedValue({} as never);

    await vendorMarketsService.ensureInitialAssignment("v1", "Nigeria");

    expect(m.vendorMarketAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vendorId_marketCode: { vendorId: "v1", marketCode: "NIGERIA" } },
        create: expect.objectContaining({ marketCode: "NIGERIA", countryName: "Nigeria", currency: "NGN" }),
      }),
    );
  });

  it("is a no-op for an empty/blank country", async () => {
    await vendorMarketsService.ensureInitialAssignment("v1", "   ");
    expect(m.vendorMarketAssignment.upsert).not.toHaveBeenCalled();
  });
});
