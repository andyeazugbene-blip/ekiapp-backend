import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findCampaign: vi.fn(),
  upsertInterest: vi.fn(),
  send: vi.fn(),
  setHeader: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: m.findCampaign },
    campaignInterest: { upsert: m.upsertInterest },
  },
}));

import { normalisePartnerCode } from "../modules/admin/partner-cohorts.service";
import { getPublicCommunityBuyPage, registerPublicCampaignInterest } from "../modules/public-site/community-buy-page";

const CAMPAIGN = {
  id: "camp-1", title: "Puna yam <b>", description: "Fresh", status: "LIVE", currency: "GBP", pricePerShareMinor: 4000, minimumShares: 10, goalShares: 20,
  confirmedShares: 5, deadline: new Date(Date.now() + 3 * 86_400_000), images: ["https://example.test/y.jpg"], paymentMode: "PLEDGE_THEN_CHARGE", organiser: { user: { isTest: false } },
};

async function page(id = "camp-1") {
  const response = { setHeader: m.setHeader, status: m.status };
  m.status.mockReturnValue({ send: m.send });
  await getPublicCommunityBuyPage({ params: { id } } as never, response as never);
  return { code: m.status.mock.calls.at(-1)?.[0] as number, html: m.send.mock.calls.at(-1)?.[0] as string };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.findCampaign.mockResolvedValue(CAMPAIGN);
});

describe("partner codes", () => {
  it("upper-cases a good code", () => {
    expect(normalisePartnerCode(" wosi-01 ")).toBe("WOSI-01");
  });

  it.each([["x"], ["has space"], ["<script>"], [""], [123], [null], ["A".repeat(33)]])("drops %s without blocking sign-up", (raw) => {
    expect(normalisePartnerCode(raw)).toBeUndefined();
  });
});

describe("the web page for a shared Community Buy link", () => {
  it("shows a live campaign, with store buttons and escaped text", async () => {
    const { code, html } = await page();
    expect(code).toBe(200);
    expect(html).toContain("Puna yam &lt;b&gt;");
    expect(html).not.toContain("Puna yam <b>");
    expect(html).toContain("ekiapp://community-buy/camp-1");
    expect(html).toContain("apps.apple.com");
    expect(html).toContain("play.google.com");
  });

  it("uses the hold wording only for a campaign that really places a hold", async () => {
    expect((await page()).html).not.toContain("temporary hold");
    m.findCampaign.mockResolvedValue({ ...CAMPAIGN, paymentMode: "AUTHORISE_THEN_CAPTURE" });
    expect((await page()).html).toContain("A temporary hold is placed shortly before the deadline");
  });

  it("offers an interest sign-up while it's in review, with no way to join", async () => {
    m.findCampaign.mockResolvedValue({ ...CAMPAIGN, status: "UNDER_REVIEW" });
    const { code, html } = await page();
    expect(code).toBe(200);
    expect(html).toContain("Coming soon");
    expect(html).toContain("Tell me when it opens");
    expect(html).not.toContain("ekiapp://community-buy");
  });

  it.each(["DRAFT", "REJECTED", "CANCELLED", "COMPLETED"])("doesn't show a %s campaign", async (status) => {
    m.findCampaign.mockResolvedValue({ ...CAMPAIGN, status });
    const { code, html } = await page();
    expect(code).toBe(404);
    expect(html).not.toContain("Puna yam");
    expect(html).toContain("isn't available");
  });

  it("never shows a demo campaign, or an unknown id as an error", async () => {
    m.findCampaign.mockResolvedValue({ ...CAMPAIGN, organiser: { user: { isTest: true } } });
    expect((await page()).html).not.toContain("Puna yam");
    m.findCampaign.mockResolvedValue(null);
    expect((await page()).html).toContain("isn't available");
  });
});

describe("interest without an account", () => {
  beforeEach(() => {
    m.findCampaign.mockResolvedValue({ ...CAMPAIGN, status: "UNDER_REVIEW" });
  });

  it("saves one row per email, whatever the case", async () => {
    await registerPublicCampaignInterest("camp-1", " Ana@Example.COM ");
    expect(m.upsertInterest).toHaveBeenCalledWith(expect.objectContaining({
      where: { campaignId_email: { campaignId: "camp-1", email: "ana@example.com" } },
      create: { campaignId: "camp-1", email: "ana@example.com" },
    }));
  });

  it.each([["nope"], [""], [null], [42], [`${"a".repeat(250)}@b.co`]])("refuses %s", async (email) => {
    await expect(registerPublicCampaignInterest("camp-1", email)).rejects.toMatchObject({ code: "INVALID_EMAIL" });
    expect(m.upsertInterest).not.toHaveBeenCalled();
  });

  it("refuses a campaign that isn't coming soon, or a demo one", async () => {
    m.findCampaign.mockResolvedValue({ ...CAMPAIGN, status: "LIVE" });
    await expect(registerPublicCampaignInterest("camp-1", "a@b.co")).rejects.toMatchObject({ statusCode: 404 });
    m.findCampaign.mockResolvedValue({ ...CAMPAIGN, status: "UNDER_REVIEW", organiser: { user: { isTest: true } } });
    await expect(registerPublicCampaignInterest("camp-1", "a@b.co")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.upsertInterest).not.toHaveBeenCalled();
  });
});
