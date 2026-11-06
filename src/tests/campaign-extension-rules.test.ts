import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), updateMany: vi.fn() },
  extension: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  offer: { findUnique: vi.fn() },
  transaction: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: m.campaign,
    campaignExtensionRequest: m.extension,
    supplierOffer: m.offer,
    notification: { create: vi.fn(), createMany: vi.fn() },
    $transaction: m.transaction,
  },
}));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/community-buy/campaign-notifications", () => ({ notifyCampaignLiveDiscovery: vi.fn(), notifyClosingSoonDiscovery: vi.fn() }));

import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";

const future = (days: number) => new Date(Date.now() + days * 86_400_000);
const INPUT = { requestedDeadline: future(10).toISOString(), reason: "More time", supplierReconfirmed: true, priceUnchangedConfirmed: true, participantTermsUnchanged: true };
const CAMPAIGN = { id: "camp-1", title: "Yam", status: "LIVE", extensionCount: 0, deadline: future(5), paymentMode: "PLEDGE_THEN_CHARGE", holdWindowStartsAt: null, supplierOfferId: null };

function givenCampaign(overrides: Record<string, unknown> = {}) {
  vi.spyOn(communityCampaignsService, "requireOwnedByOrganiserForWrite").mockResolvedValue({ ...CAMPAIGN, ...overrides } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.values(m.extension).forEach((fn) => fn.mockReset());
  m.offer.findUnique.mockReset();
  m.extension.findFirst.mockResolvedValue(null);
  m.extension.create.mockImplementation(async ({ data }: { data: unknown }) => data);
});

describe("asking for an extension", () => {
  it("works while live, not only in a rescue window", async () => {
    givenCampaign();
    await expect(communityCampaignsService.requestExtension("org", "camp-1", INPUT)).resolves.toMatchObject({ status: "PENDING" });
  });

  it.each(["DRAFT", "UNDER_REVIEW", "SUCCEEDED", "FAILED", "HOLD_WINDOW"])("is refused while %s", async (status) => {
    givenCampaign({ status });
    await expect(communityCampaignsService.requestExtension("org", "camp-1", INPUT)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.extension.create).not.toHaveBeenCalled();
  });

  it("must move the deadline later", async () => {
    givenCampaign();
    await expect(communityCampaignsService.requestExtension("org", "camp-1", { ...INPUT, requestedDeadline: future(3).toISOString() })).rejects.toMatchObject({ code: "EXTENSION_NOT_LATER" });
  });

  it("is refused once card holds have started, because a placed hold could lapse", async () => {
    givenCampaign({ paymentMode: "AUTHORISE_THEN_CAPTURE", holdWindowStartsAt: future(-1) });
    await expect(communityCampaignsService.requestExtension("org", "camp-1", INPUT)).rejects.toMatchObject({ code: "EXTENSION_AFTER_HOLDS" });
  });

  it("allows only one open request", async () => {
    givenCampaign();
    m.extension.findFirst.mockResolvedValue({ id: "ext-open" });
    await expect(communityCampaignsService.requestExtension("org", "camp-1", INPUT)).rejects.toMatchObject({ code: "EXTENSION_ALREADY_OPEN" });
  });

  it("won't let an organiser vouch for an offer's supplier", async () => {
    givenCampaign({ supplierOfferId: "offer-1" });
    m.offer.findUnique.mockResolvedValue({ windowEndsAt: future(30), supplierAccount: { userId: "supplier" } });
    const created = await communityCampaignsService.requestExtension("org", "camp-1", INPUT);
    expect(created).toMatchObject({ supplierReconfirmed: false });
  });

  it("stays inside the offer's window", async () => {
    givenCampaign({ supplierOfferId: "offer-1" });
    m.offer.findUnique.mockResolvedValue({ windowEndsAt: future(8), supplierAccount: { userId: "supplier" } });
    await expect(communityCampaignsService.requestExtension("org", "camp-1", INPUT)).rejects.toMatchObject({ code: "CAMPAIGN_OUTSIDE_OFFER_LIMITS" });
  });
});

describe("the supplier's answer", () => {
  const REQUEST = { id: "ext-1", status: "PENDING", campaign: { id: "camp-1", title: "Yam", organiser: { userId: "org" }, supplierOffer: { supplierAccount: { userId: "supplier" } } } };

  it("is only accepted from that offer's supplier", async () => {
    m.extension.findUnique.mockResolvedValue(REQUEST);
    await expect(communityCampaignsService.reconfirmExtensionAsSupplier("someone-else", "ext-1", true)).rejects.toMatchObject({ statusCode: 404 });
    expect(m.extension.update).not.toHaveBeenCalled();
  });

  it("records a yes", async () => {
    m.extension.findUnique.mockResolvedValue(REQUEST);
    await communityCampaignsService.reconfirmExtensionAsSupplier("supplier", "ext-1", true);
    expect(m.extension.update).toHaveBeenCalledWith({ where: { id: "ext-1" }, data: { supplierReconfirmed: true } });
  });

  it("ends the request on a no", async () => {
    m.extension.findUnique.mockResolvedValue(REQUEST);
    m.extension.update.mockResolvedValue({ id: "ext-1", status: "REJECTED", campaignId: "camp-1" });
    await communityCampaignsService.reconfirmExtensionAsSupplier("supplier", "ext-1", false);
    expect(m.extension.update.mock.calls[0][0].data).toMatchObject({ status: "REJECTED", supplierReconfirmed: false });
  });

  it("can't change a decided request", async () => {
    m.extension.findUnique.mockResolvedValue({ ...REQUEST, status: "APPROVED" });
    await expect(communityCampaignsService.reconfirmExtensionAsSupplier("supplier", "ext-1", true)).rejects.toMatchObject({ statusCode: 409 });
  });
});
