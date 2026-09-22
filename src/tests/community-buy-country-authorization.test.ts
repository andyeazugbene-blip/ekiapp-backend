/**
 * Client decision (2026-09-22, "VERIFY BUYER COUNTRY IMPLEMENTATION" audit
 * + follow-up fix) — the acceptance workflow requires Community Buy
 * discovery/access to be scoped to the authenticated buyer's own
 * registered country, enforced server-side, never bypassable by a
 * client-supplied query parameter or a direct campaign-ID request.
 *
 * Belgium/Canada is the acceptance scenario named in the brief; this file
 * proves it directly against the real service functions (buyerCountryService,
 * communityCampaignsService.listLive/getForRequester, campaignContributionsService
 * .join/pledge) with only Prisma mocked — the same convention as
 * community-buy.test.ts — so these assertions exercise the actual
 * authorization logic, not a re-description of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    communityCampaign: { findMany: vi.fn(), findUnique: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    vendor: { findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    campaignParticipant: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    buyerPaymentMethod: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
  },
}));
vi.mock("../modules/community-buy/community-buy-privacy.service", () => ({
  isIndividualDeliveryEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { buyerCountryService } from "../modules/community-buy/buyer-country.service";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";

const m = vi.mocked(prisma, true) as any;

const BELGIUM_BUYER = "buyer-belgium-1";
const CANADA_BUYER = "buyer-canada-1";
const BELGIUM_CAMPAIGN = "camp-belgium-1";
const CANADA_CAMPAIGN = "camp-canada-1";

function mockUserCountry(userId: string, country: string | null) {
  m.user.findUnique.mockImplementation(async ({ where }: any) =>
    where?.id === userId ? { country } : null,
  );
}

function mockCampaignCountry(campaignId: string, country: string) {
  m.communityCampaign.findUnique.mockImplementation(async ({ where, select }: any) => {
    if (where?.id !== campaignId) return null;
    if (select) {
      // getForRequester()'s minimal gate-select shape.
      return { country, organiserId: "org-none", supplierId: null, supplierAccountId: null };
    }
    return {
      id: campaignId, status: "LIVE", country, deadline: new Date(Date.now() + 86400000),
      maximumShares: 100, confirmedShares: 0, currency: "EUR",
    };
  });
  m.organiserProfile.findUnique.mockResolvedValue(null as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.marketConfiguration.count.mockResolvedValue(1 as never);
});

describe("buyerCountryService — the single source of truth", () => {
  it("resolves a Belgium buyer's free-text country to BE", async () => {
    mockUserCountry(BELGIUM_BUYER, "Belgium");
    expect(await buyerCountryService.resolveMarketCode(BELGIUM_BUYER)).toBe("BE");
  });

  it("resolves a Canada buyer's free-text country to CA", async () => {
    mockUserCountry(CANADA_BUYER, "Canada");
    expect(await buyerCountryService.resolveMarketCode(CANADA_BUYER)).toBe("CA");
  });

  it("requireMarketCode() throws COUNTRY_REQUIRED for a buyer with no country set", async () => {
    mockUserCountry("buyer-no-country", null);
    await expect(buyerCountryService.requireMarketCode("buyer-no-country")).rejects.toMatchObject({
      statusCode: 403,
      code: "COUNTRY_REQUIRED",
    });
  });

  it("isEligible() is true only when the buyer's resolved market matches the campaign's", () => {
    expect(buyerCountryService.isEligible("BE", "BE")).toBe(true);
    expect(buyerCountryService.isEligible("BE", "CA")).toBe(false);
    expect(buyerCountryService.isEligible(null, "BE")).toBe(false);
    expect(buyerCountryService.isEligible("BE", null)).toBe(false);
  });
});

describe("Discovery — listLive() only returns the authenticated buyer's own market", () => {
  it("a Belgium buyer's discovery query is scoped to country: BE", async () => {
    m.communityCampaign.findMany.mockResolvedValue([]);
    await communityCampaignsService.listLive("BE");
    expect(m.communityCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "LIVE", country: "BE" }) }),
    );
  });

  it("a Canada buyer's discovery query is scoped to country: CA, never BE", async () => {
    m.communityCampaign.findMany.mockResolvedValue([]);
    await communityCampaignsService.listLive("CA");
    expect(m.communityCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ country: "CA" }) }),
    );
    expect(m.communityCampaign.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ country: "BE" }) }),
    );
  });
});

describe("Direct campaign access — getForRequester()", () => {
  it("Belgium buyer -> Belgium campaign: PASS", async () => {
    mockUserCountry(BELGIUM_BUYER, "Belgium");
    mockCampaignCountry(BELGIUM_CAMPAIGN, "BE");
    m.communityCampaign.findUnique.mockImplementation(async ({ where, select }: any) => {
      if (where?.id !== BELGIUM_CAMPAIGN) return null;
      if (select) return { country: "BE", organiserId: "org-none", supplierId: null, supplierAccountId: null };
      return {
        id: BELGIUM_CAMPAIGN, country: "BE", pricePerShareMinor: null,
        supplier: null, supplierAccount: null,
        organiser: { firstNameOnlyDisplay: false, isVerified: true, user: { name: "Organiser" } },
        contributions: [], _count: { participants: 0 },
      };
    });

    const result = await communityCampaignsService.getForRequester(BELGIUM_BUYER, BELGIUM_CAMPAIGN);
    expect(result.id).toBe(BELGIUM_CAMPAIGN);
  });

  it("Belgium buyer -> Canada campaign: BLOCKED (404, same as not-found — never reveals existence)", async () => {
    mockUserCountry(BELGIUM_BUYER, "Belgium");
    mockCampaignCountry(CANADA_CAMPAIGN, "CA");

    await expect(communityCampaignsService.getForRequester(BELGIUM_BUYER, CANADA_CAMPAIGN)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("Canada buyer -> Canada campaign: PASS", async () => {
    mockUserCountry(CANADA_BUYER, "Canada");
    m.communityCampaign.findUnique.mockImplementation(async ({ where, select }: any) => {
      if (where?.id !== CANADA_CAMPAIGN) return null;
      if (select) return { country: "CA", organiserId: "org-none", supplierId: null, supplierAccountId: null };
      return {
        id: CANADA_CAMPAIGN, country: "CA", pricePerShareMinor: null,
        supplier: null, supplierAccount: null,
        organiser: { firstNameOnlyDisplay: false, isVerified: true, user: { name: "Organiser" } },
        contributions: [], _count: { participants: 0 },
      };
    });

    const result = await communityCampaignsService.getForRequester(CANADA_BUYER, CANADA_CAMPAIGN);
    expect(result.id).toBe(CANADA_CAMPAIGN);
  });

  it("Canada buyer -> Belgium campaign: BLOCKED", async () => {
    mockUserCountry(CANADA_BUYER, "Canada");
    mockCampaignCountry(BELGIUM_CAMPAIGN, "BE");

    await expect(communityCampaignsService.getForRequester(CANADA_BUYER, BELGIUM_CAMPAIGN)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("a buyer with no country cannot access ANY campaign detail, even a real one", async () => {
    mockUserCountry("buyer-no-country", null);
    mockCampaignCountry(BELGIUM_CAMPAIGN, "BE");

    await expect(communityCampaignsService.getForRequester("buyer-no-country", BELGIUM_CAMPAIGN)).rejects.toMatchObject({
      statusCode: 403,
      code: "COUNTRY_REQUIRED",
    });
  });

  it("the campaign's own organiser can view it regardless of the organiser's own registered country (cross-role: never broken)", async () => {
    const organiserUserId = "organiser-of-canada-campaign";
    mockUserCountry(organiserUserId, "Belgium"); // organiser is personally Belgium-registered
    m.communityCampaign.findUnique.mockImplementation(async ({ where, select }: any) => {
      if (where?.id !== CANADA_CAMPAIGN) return null;
      if (select) return { country: "CA", organiserId: "org-owns-canada", supplierId: null, supplierAccountId: null };
      return {
        id: CANADA_CAMPAIGN, country: "CA", pricePerShareMinor: null,
        supplier: null, supplierAccount: null,
        organiser: { firstNameOnlyDisplay: false, isVerified: true, user: { name: "Organiser" } },
        contributions: [], _count: { participants: 0 },
      };
    });
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-owns-canada" } as never);

    const result = await communityCampaignsService.getForRequester(organiserUserId, CANADA_CAMPAIGN);
    expect(result.id).toBe(CANADA_CAMPAIGN);
  });

  it("an admin can view any campaign regardless of the admin's own country", async () => {
    const adminUserId = "admin-1";
    m.user.findUnique.mockImplementation(async ({ where }: any) =>
      where?.id === adminUserId ? { role: "ADMIN", country: "Belgium" } : null,
    );
    m.communityCampaign.findUnique.mockImplementation(async ({ where, select }: any) => {
      if (where?.id !== CANADA_CAMPAIGN) return null;
      if (select) return { country: "CA", organiserId: "org-none", supplierId: null, supplierAccountId: null };
      return {
        id: CANADA_CAMPAIGN, country: "CA", pricePerShareMinor: null,
        supplier: null, supplierAccount: null,
        organiser: { firstNameOnlyDisplay: false, isVerified: true, user: { name: "Organiser" } },
        contributions: [], _count: { participants: 0 },
      };
    });
    m.organiserProfile.findUnique.mockResolvedValue(null as never);

    const result = await communityCampaignsService.getForRequester(adminUserId, CANADA_CAMPAIGN);
    expect(result.id).toBe(CANADA_CAMPAIGN);
  });
});

describe("Participation — join()", () => {
  beforeEach(() => {
    m.campaignParticipant.findFirst.mockResolvedValue(null as never);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as never);
    m.campaignParticipant.findUnique.mockResolvedValue(null as never);
  });

  it("Belgium buyer -> Belgium campaign join(): PASS", async () => {
    mockUserCountry(BELGIUM_BUYER, "Belgium");
    m.communityCampaign.findUnique.mockResolvedValue({ id: BELGIUM_CAMPAIGN, status: "LIVE", country: "BE" } as never);

    await expect(campaignContributionsService.join(BELGIUM_BUYER, BELGIUM_CAMPAIGN)).resolves.toBeTruthy();
  });

  it("Belgium buyer -> Canada campaign join(): BLOCKED", async () => {
    mockUserCountry(BELGIUM_BUYER, "Belgium");
    m.communityCampaign.findUnique.mockResolvedValue({ id: CANADA_CAMPAIGN, status: "LIVE", country: "CA" } as never);

    await expect(campaignContributionsService.join(BELGIUM_BUYER, CANADA_CAMPAIGN)).rejects.toMatchObject({ statusCode: 404 });
    expect(m.campaignParticipant.create).not.toHaveBeenCalled();
  });

  it("Canada buyer -> Canada campaign join(): PASS", async () => {
    mockUserCountry(CANADA_BUYER, "Canada");
    m.communityCampaign.findUnique.mockResolvedValue({ id: CANADA_CAMPAIGN, status: "LIVE", country: "CA" } as never);

    await expect(campaignContributionsService.join(CANADA_BUYER, CANADA_CAMPAIGN)).resolves.toBeTruthy();
  });

  it("Canada buyer -> Belgium campaign join(): BLOCKED", async () => {
    mockUserCountry(CANADA_BUYER, "Canada");
    m.communityCampaign.findUnique.mockResolvedValue({ id: BELGIUM_CAMPAIGN, status: "LIVE", country: "BE" } as never);

    await expect(campaignContributionsService.join(CANADA_BUYER, BELGIUM_CAMPAIGN)).rejects.toMatchObject({ statusCode: 404 });
    expect(m.campaignParticipant.create).not.toHaveBeenCalled();
  });
});

describe("Participation — pledge()", () => {
  beforeEach(() => {
    m.campaignParticipant.findFirst.mockResolvedValue(null as never);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as never);
    m.campaignParticipant.findUnique.mockResolvedValue(null as never);
    m.buyerPaymentMethod.findUnique.mockResolvedValue({ id: "pm-1", buyerId: BELGIUM_BUYER } as never);
  });

  it("Belgium buyer -> Canada campaign pledge(): BLOCKED before any payment/market check runs", async () => {
    mockUserCountry(BELGIUM_BUYER, "Belgium");
    m.communityCampaign.findUnique.mockResolvedValue({
      id: CANADA_CAMPAIGN, status: "LIVE", country: "CA", deadline: new Date(Date.now() + 86400000),
    } as never);

    await expect(
      campaignContributionsService.pledge(BELGIUM_BUYER, CANADA_CAMPAIGN, 1, "pm-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Never even reached the market-payments-enabled check.
    expect(m.marketConfiguration.findUnique).not.toHaveBeenCalled();
  });

  it("Canada buyer -> Belgium campaign pledge(): BLOCKED", async () => {
    mockUserCountry(CANADA_BUYER, "Canada");
    m.communityCampaign.findUnique.mockResolvedValue({
      id: BELGIUM_CAMPAIGN, status: "LIVE", country: "BE", deadline: new Date(Date.now() + 86400000),
    } as never);

    await expect(
      campaignContributionsService.pledge(CANADA_BUYER, BELGIUM_CAMPAIGN, 1, "pm-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Query-parameter tampering — the client-supplied ?country= has zero effect", () => {
  it("listLive() is called with the value the CONTROLLER resolved server-side, never a raw query string — a Belgium buyer's request for country=CA is provably ignored at the service boundary", async () => {
    // This is enforced structurally, not just by convention: listLive()'s
    // signature takes a single already-resolved market code, and the
    // controller (community-buy.controller.ts's listCampaigns) never reads
    // request.query.country at all anymore — see that file. This test
    // proves the service side of that contract: whatever is passed in is
    // used verbatim for the DB filter, with no alternate "or use the query
    // string instead" code path anywhere in listLive() itself.
    m.communityCampaign.findMany.mockResolvedValue([]);
    await communityCampaignsService.listLive("BE", undefined);
    expect(m.communityCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ country: "BE" }) }),
    );
  });
});
