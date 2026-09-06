/**
 * createVendor's multi-market onboarding path: markets[] (from the "Markets
 * you serve" multi-select) becomes markets[0] as the primary Vendor.country/
 * currency (unchanged downstream behavior for every existing single-country
 * caller) plus one VendorMarketAssignment per selected market. Every entry
 * must be an approved launch market — no partial grandfathering for a
 * brand-new vendor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    wallet: { upsert: vi.fn() },
    user: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../modules/vendors/vendor-markets.service", () => ({
  resolveCurrencyForMarket: vi.fn(),
  vendorMarketsService: { ensureInitialAssignment: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { resolveCurrencyForMarket, vendorMarketsService } from "../modules/vendors/vendor-markets.service";
import { vendorsService } from "../modules/vendors/vendors.service";

const m = vi.mocked(prisma, true);
const resolveCurrency = vi.mocked(resolveCurrencyForMarket);
const ensureInitialAssignment = vi.mocked(vendorMarketsService.ensureInitialAssignment);

beforeEach(() => {
  vi.clearAllMocks();
  m.vendor.findUnique.mockResolvedValue(null as never);
  m.vendor.findFirst.mockResolvedValue(null as never);
  resolveCurrency.mockResolvedValue("GBP" as never);
  m.$transaction.mockImplementation(async (callback: any) => {
    const tx = {
      vendor: { create: vi.fn().mockResolvedValue({ id: "vendor-new", storeName: "Test Store", country: "United Kingdom", currency: "GBP" }) },
      wallet: { upsert: vi.fn() },
      user: { updateMany: vi.fn() },
    };
    return callback(tx);
  });
});

describe("vendorsService.createVendor — markets[] multi-select onboarding", () => {
  it("rejects the whole request if ANY selected market is outside the 10 approved launch markets", async () => {
    await expect(
      vendorsService.createVendor("user-1", { storeName: "Test Store", markets: ["United Kingdom", "Nigeria"] }),
    ).rejects.toThrow(/approved launch markets/i);

    expect(m.vendor.findUnique).not.toHaveBeenCalled();
    expect(ensureInitialAssignment).not.toHaveBeenCalled();
  });

  it("creates the vendor with markets[0] as the primary country/currency, and one assignment per market", async () => {
    const vendor = await vendorsService.createVendor("user-1", {
      storeName: "Test Store",
      markets: ["United Kingdom", "France", "Belgium"],
    });

    expect(vendor.country).toBe("United Kingdom");
    expect(resolveCurrency).toHaveBeenCalledWith("United Kingdom");
    expect(ensureInitialAssignment).toHaveBeenCalledTimes(3);
    expect(ensureInitialAssignment).toHaveBeenNthCalledWith(1, "vendor-new", "United Kingdom", expect.anything());
    expect(ensureInitialAssignment).toHaveBeenNthCalledWith(2, "vendor-new", "France", expect.anything());
    expect(ensureInitialAssignment).toHaveBeenNthCalledWith(3, "vendor-new", "Belgium", expect.anything());
  });

  it("a single-country legacy request (no markets[]) still creates exactly one assignment for that country", async () => {
    await vendorsService.createVendor("user-1", { storeName: "Test Store", country: "United Kingdom" });

    expect(ensureInitialAssignment).toHaveBeenCalledTimes(1);
    expect(ensureInitialAssignment).toHaveBeenCalledWith("vendor-new", "United Kingdom", expect.anything());
  });

  it("creates no assignment at all when no country/markets are given (fully optional onboarding field)", async () => {
    await vendorsService.createVendor("user-1", { storeName: "Test Store" });

    expect(ensureInitialAssignment).not.toHaveBeenCalled();
  });
});
