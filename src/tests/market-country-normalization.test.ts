import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveMarketCode,
  countryNamesForMarketCode,
  LAUNCH_MARKET_COUNTRIES,
  marketCodeToCountryName,
  isApprovedLaunchMarketCode,
} from "../shared/currency";

/**
 * Regression coverage for the Community Buy country-normalization bug:
 * OrganiserProfile.country / SupplierProfile.country / CommunityCampaign
 * .country are all raw free-text strings straight from request.body.country
 * (a real mobile client sends "United Kingdom", not "GB"), but
 * marketConfigurationService.get() did a literal MarketConfiguration
 * .countryCode lookup — meaning EVERY organiser/supplier application,
 * campaign create/publish, and pledge/payment check silently 403'd with
 * "not open in this market yet" for every real market, always, regardless
 * of its actual enabled flags. Confirmed live against the real QA DB and
 * API before fixing (Nigeria correctly rejected; "United Kingdom" also
 * incorrectly rejected for a market that was genuinely enabled).
 */
describe("resolveMarketCode — the 10 approved launch markets, every real spelling", () => {
  const cases: [string, string][] = [
    ["United Kingdom", "GB"], ["UK", "GB"], ["gb", "GB"], ["England", "GB"], ["Scotland", "GB"], ["Wales", "GB"],
    ["United States", "US"], ["USA", "US"], ["United States of America", "US"], ["us", "US"],
    ["Canada", "CA"], ["ca", "CA"],
    ["France", "FR"], ["fr", "FR"],
    ["Spain", "ES"], ["es", "ES"],
    ["Portugal", "PT"], ["pt", "PT"],
    ["Switzerland", "CH"], ["ch", "CH"],
    ["Belgium", "BE"], ["be", "BE"],
    ["Italy", "IT"], ["it", "IT"],
    ["Croatia", "HR"], ["hr", "HR"],
  ];

  it.each(cases)("resolves %s to market code %s", (raw, expectedCode) => {
    expect(resolveMarketCode(raw)).toBe(expectedCode);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveMarketCode("  united kingdom  ")).toBe("GB");
    expect(resolveMarketCode("SWITZERLAND")).toBe("CH");
  });

  it("returns null for a country that is not one of the 10 approved launch markets — never weakens gating by guessing", () => {
    expect(resolveMarketCode("Nigeria")).toBeNull();
    expect(resolveMarketCode("Ghana")).toBeNull();
    expect(resolveMarketCode("Germany")).toBeNull();
    expect(resolveMarketCode("Some Made Up Place")).toBeNull();
  });

  it("returns null for empty/missing input", () => {
    expect(resolveMarketCode("")).toBeNull();
    expect(resolveMarketCode(null)).toBeNull();
    expect(resolveMarketCode(undefined)).toBeNull();
  });

  it("LAUNCH_MARKET_COUNTRIES exposes exactly the 10 approved markets, one canonical name each", () => {
    const codes = LAUNCH_MARKET_COUNTRIES.map((m) => m.code).sort();
    expect(codes).toEqual(["BE", "CA", "CH", "ES", "FR", "GB", "HR", "IT", "PT", "US"]);
  });

  it("round-trips with countryNamesForMarketCode for every launch market", () => {
    for (const { code } of LAUNCH_MARKET_COUNTRIES) {
      const names = countryNamesForMarketCode(code);
      for (const name of names) {
        expect(resolveMarketCode(name)).toBe(code);
      }
    }
  });
});

describe("marketCodeToCountryName — the display-name resolver (never a raw code visible to a user)", () => {
  it.each(LAUNCH_MARKET_COUNTRIES.map((m) => [m.code, m.name] as const))(
    "resolves %s to its canonical full name %s",
    (code, expectedName) => {
      expect(marketCodeToCountryName(code)).toBe(expectedName);
    },
  );

  it("is case-insensitive", () => {
    expect(marketCodeToCountryName("gb")).toBe("United Kingdom");
    expect(marketCodeToCountryName("ch")).toBe("Switzerland");
  });

  it("returns null for a code outside the 10 launch markets — never fabricates a name for Africa or anywhere else", () => {
    expect(marketCodeToCountryName("NG")).toBeNull();
    expect(marketCodeToCountryName("GH")).toBeNull();
    expect(marketCodeToCountryName("XX")).toBeNull();
  });
});

describe("isApprovedLaunchMarketCode — Africa (and everything else) must be false", () => {
  it("is true for exactly the 10 approved launch market codes", () => {
    for (const { code } of LAUNCH_MARKET_COUNTRIES) {
      expect(isApprovedLaunchMarketCode(code)).toBe(true);
      expect(isApprovedLaunchMarketCode(code.toLowerCase())).toBe(true);
    }
  });

  it("is false for Nigeria/Ghana and any other non-launch code", () => {
    expect(isApprovedLaunchMarketCode("NG")).toBe(false);
    expect(isApprovedLaunchMarketCode("GH")).toBe(false);
    expect(isApprovedLaunchMarketCode("KE")).toBe(false);
    expect(isApprovedLaunchMarketCode("ZA")).toBe(false);
  });

  it("is false for null/undefined/empty", () => {
    expect(isApprovedLaunchMarketCode(null)).toBe(false);
    expect(isApprovedLaunchMarketCode(undefined)).toBe(false);
    expect(isApprovedLaunchMarketCode("")).toBe(false);
  });
});

vi.mock("../lib/prisma", () => ({
  prisma: {
    marketConfiguration: { count: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  m.marketConfiguration.count.mockResolvedValue(10 as never); // already seeded, skip ensureDefaults' upsert loop
});

describe("marketConfigurationService.get — normalizes raw country input before querying", () => {
  it("a full country name resolves to the real countryCode row (the actual production bug)", async () => {
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true } as never);

    const config = await marketConfigurationService.get("United Kingdom");

    expect(m.marketConfiguration.findUnique).toHaveBeenCalledWith({ where: { countryCode: "GB" } });
    expect(config?.communityBuyEnabled).toBe(true);
  });

  it("a literal ISO code still works unchanged (admin-web always sends the real code)", async () => {
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "CH" } as never);

    await marketConfigurationService.get("CH");

    expect(m.marketConfiguration.findUnique).toHaveBeenCalledWith({ where: { countryCode: "CH" } });
  });

  it("an unrecognized country still queries literally (and correctly finds nothing) rather than throwing", async () => {
    m.marketConfiguration.findUnique.mockResolvedValue(null as never);

    const config = await marketConfigurationService.get("Nigeria");

    expect(m.marketConfiguration.findUnique).toHaveBeenCalledWith({ where: { countryCode: "NIGERIA" } });
    expect(config).toBeNull();
  });
});
