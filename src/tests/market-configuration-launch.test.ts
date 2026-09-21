/**
 * Client decision (2026-09-22, "FINAL CLIENT DECISIONS — APPLY NOW") — real
 * regression coverage for which countries Community Buy can actually accept
 * money in. market-configuration.service.ts had zero dedicated test
 * coverage despite gating exactly this. Proves: the ten approved markets
 * (GB/US/CA + 7 European) seed enabled with PLEDGE_THEN_CHARGE on a fresh
 * database, no African market is ever seeded or enabled, an unconfigured/
 * unknown country is safely treated as payments-disabled (never a silent
 * default-allow), and a new campaign always snapshots PLEDGE_THEN_CHARGE
 * unless a market is explicitly configured otherwise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    marketConfiguration: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("./../modules/community-buy/community-buy-privacy.service", () => ({
  isIndividualDeliveryEnabled: vi.fn().mockReturnValue(false),
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService, INITIAL_MARKETS } from "../modules/community-buy/market-configuration.service";

const m = vi.mocked(prisma, true) as any;

const APPROVED_COUNTRY_CODES = ["GB", "US", "CA", "FR", "ES", "PT", "CH", "BE", "IT", "HR"];
const AFRICAN_COUNTRY_CODES = ["NG", "GH", "KE", "ZA", "EG"];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("INITIAL_MARKETS — the approved launch-market list itself", () => {
  it("contains exactly the ten client-approved markets, no more, no fewer", () => {
    const codes = INITIAL_MARKETS.map((m) => m.countryCode).sort();
    expect(codes).toEqual([...APPROVED_COUNTRY_CODES].sort());
  });

  it("never contains an African market — omission here is what keeps Africa unavailable", () => {
    const codes = INITIAL_MARKETS.map((m) => m.countryCode);
    for (const africanCode of AFRICAN_COUNTRY_CODES) {
      expect(codes).not.toContain(africanCode);
    }
  });
});

describe("ensureDefaults() — a fresh database seeds every approved market already enabled", () => {
  it("upserts all ten markets with communityBuyEnabled/organiser/supplier applications/payments all true, and PLEDGE_THEN_CHARGE, when the table is empty", async () => {
    m.marketConfiguration.count.mockResolvedValue(0);
    m.marketConfiguration.upsert.mockResolvedValue({});

    await marketConfigurationService.list(); // triggers ensureDefaults() internally

    expect(m.marketConfiguration.upsert).toHaveBeenCalledTimes(10);
    for (const call of m.marketConfiguration.upsert.mock.calls) {
      const created = call[0].create;
      expect(created.communityBuyEnabled).toBe(true);
      expect(created.organiserApplicationsEnabled).toBe(true);
      expect(created.supplierApplicationsEnabled).toBe(true);
      expect(created.communityBuyPaymentsEnabled).toBe(true);
      expect(created.communityBuyPaymentMode).toBe("PLEDGE_THEN_CHARGE");
    }
    const seededCodes = m.marketConfiguration.upsert.mock.calls.map((c: any) => c[0].create.countryCode).sort();
    expect(seededCodes).toEqual([...APPROVED_COUNTRY_CODES].sort());
  });

  it("never re-seeds when the table already has rows — a non-empty table is left exactly as an admin configured it", async () => {
    m.marketConfiguration.count.mockResolvedValue(1);

    await marketConfigurationService.list();

    expect(m.marketConfiguration.upsert).not.toHaveBeenCalled();
  });
});

describe("isCommunityBuyPaymentsEnabled() — the real gate attemptCharge() checks before charging a participant", () => {
  it("is true for an approved, fully-configured market", async () => {
    m.marketConfiguration.count.mockResolvedValue(10);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    });

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("GB")).toBe(true);
  });

  it("is false for a market with no MarketConfiguration row at all — never a silent default-allow", async () => {
    m.marketConfiguration.count.mockResolvedValue(10);
    m.marketConfiguration.findUnique.mockResolvedValue(null);

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("NG")).toBe(false);
  });

  it("is false when communityBuyEnabled is true but communityBuyPaymentsEnabled is false — the two flags are independent gates", async () => {
    m.marketConfiguration.count.mockResolvedValue(10);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "XX", communityBuyEnabled: true, communityBuyPaymentsEnabled: false, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    });

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("XX")).toBe(false);
  });

  it("is false when communityBuyPaymentMode is null (never configured) even if both boolean flags are true", async () => {
    m.marketConfiguration.count.mockResolvedValue(10);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "XX", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: null,
    });

    expect(await marketConfigurationService.isCommunityBuyPaymentsEnabled("XX")).toBe(false);
  });
});

describe("resolveNewCampaignPaymentMode() — every new campaign snapshots PLEDGE_THEN_CHARGE unless explicitly overridden", () => {
  it("resolves PLEDGE_THEN_CHARGE for an approved market with no explicit AUTHORISE_THEN_CAPTURE override", async () => {
    m.marketConfiguration.count.mockResolvedValue(10);
    m.marketConfiguration.findUnique.mockResolvedValue({
      countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentMode: "PLEDGE_THEN_CHARGE",
    });

    expect(await marketConfigurationService.resolveNewCampaignPaymentMode("GB")).toBe("PLEDGE_THEN_CHARGE");
  });

  it("resolves PLEDGE_THEN_CHARGE (never invents AUTHORISE_THEN_CAPTURE) for an unconfigured market", async () => {
    m.marketConfiguration.count.mockResolvedValue(10);
    m.marketConfiguration.findUnique.mockResolvedValue(null);

    expect(await marketConfigurationService.resolveNewCampaignPaymentMode("NG")).toBe("PLEDGE_THEN_CHARGE");
  });
});
