import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findCampaign: vi.fn(),
  findInterest: vi.fn(),
  updateInterest: vi.fn(),
  notify: vi.fn(),
  enqueueEmail: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: m.findCampaign },
    campaignInterest: { findMany: m.findInterest, update: m.updateInterest },
  },
}));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: m.enqueueEmail }));
vi.mock("../modules/community-buy/community-buy-notices", () => ({ notifyUserInAppAndEmail: m.notify }));
vi.mock("../modules/community-buy/community-campaigns.service", () => ({ communityCampaignsService: {} }));
vi.mock("../modules/community-buy/supplier-account.service", () => ({ supplierAccountService: {} }));

import { notifyOfferCampaignLive } from "../modules/community-buy/review-requests.service";

beforeEach(() => {
  vi.clearAllMocks();
  m.findCampaign.mockResolvedValue({ title: "Puna yam", organiser: { userId: "organiser" }, supplierOffer: null });
  m.findInterest.mockResolvedValue([]);
});

describe("telling interested people a Community Buy opened", () => {
  it("emails someone with no account once, then forgets their address", async () => {
    m.findInterest.mockResolvedValue([{ id: "i1", userId: null, email: "ana@example.com" }]);

    await notifyOfferCampaignLive("camp-1");

    expect(m.enqueueEmail).toHaveBeenCalledTimes(1);
    expect(m.enqueueEmail.mock.calls[0][0].to).toBe("ana@example.com");
    expect(m.updateInterest).toHaveBeenCalledWith({ where: { id: "i1" }, data: { notifiedAt: expect.any(Date), email: null } });
  });

  it("only looks at people not yet told", async () => {
    await notifyOfferCampaignLive("camp-1");
    expect(m.findInterest.mock.calls[0][0].where).toEqual({ campaignId: "camp-1", notifiedAt: null });
  });

  it("notifies an account holder through the inbox, without repeats", async () => {
    m.findInterest.mockResolvedValue([{ id: "i2", userId: "buyer", email: null }]);

    await notifyOfferCampaignLive("camp-1");

    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "buyer", dedupeKey: "campaign_interest_open:camp-1:buyer" }));
    expect(m.enqueueEmail).not.toHaveBeenCalled();
  });

  it("still tells the organiser if this step fails", async () => {
    m.findInterest.mockRejectedValue(new Error("db down"));

    await notifyOfferCampaignLive("camp-1");

    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "organiser", event: "offer_campaign_live" }));
  });
});
