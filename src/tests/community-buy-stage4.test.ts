import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findContribution: vi.fn(),
  send: vi.fn(),
  status: vi.fn(),
  setHeader: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: { campaignContribution: { findUnique: m.findContribution } },
}));

import { env } from "../config/env";
import { campaignRisk } from "../modules/community-buy/campaign-operations.service";
import { getReceiptPage, receiptsService } from "../modules/public-site/receipts-page";

const soon = new Date(Date.now() + 86_400_000);
const later = new Date(Date.now() + 10 * 86_400_000);
const BASE = { status: "LIVE", deadline: later, confirmedShares: 2, minimumShares: 10, failedPayments: 0 };

describe("CB79 risk status", () => {
  it("is normal with time left", () => expect(campaignRisk(BASE)).toBe("Normal"));
  it("is at risk when closing soon and below minimum", () => expect(campaignRisk({ ...BASE, deadline: soon })).toBe("At risk"));
  it("isn't at risk once the minimum is met", () => expect(campaignRisk({ ...BASE, deadline: soon, confirmedShares: 10 })).toBe("Normal"));
  it("needs attention in a completion period", () => expect(campaignRisk({ ...BASE, status: "RESCUE_WINDOW" })).toBe("Needs attention"));
  it("needs attention with a failed payment", () => expect(campaignRisk({ ...BASE, failedPayments: 1 })).toBe("Needs attention"));
  it("reads as paused above everything else", () => expect(campaignRisk({ ...BASE, status: "PAUSED", failedPayments: 3 })).toBe("Paused"));
});

const CONTRIBUTION = {
  id: "contribution-abc123", amount: 8000, buyerServiceFeeAmount: 400, deliveryFeeAmountMinor: 500, currency: "GBP", status: "PAID", createdAt: new Date("2026-11-06T10:00:00Z"),
  participant: { userId: "buyer", campaign: { title: "Puna <yam>" } },
};

async function page(token: string) {
  m.status.mockReturnValue({ send: m.send });
  await getReceiptPage({ params: { token } } as never, { setHeader: m.setHeader, status: m.status } as never);
  return { code: m.status.mock.calls.at(-1)?.[0] as number, html: m.send.mock.calls.at(-1)?.[0] as string };
}

const sign = (claims: object, options: jwt.SignOptions = {}) => jwt.sign(claims, env.jwtSecret, { subject: "buyer", expiresIn: "15m", ...options });

describe("CB27 receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findContribution.mockResolvedValue(CONTRIBUTION);
  });

  it("only gives a link to the buyer who made the contribution", async () => {
    await expect(receiptsService.contributionLink("someone-else", "contribution-abc123")).rejects.toMatchObject({ statusCode: 404 });
    await expect(receiptsService.contributionLink("buyer", "contribution-abc123")).resolves.toMatchObject({ url: expect.stringContaining("/receipt/") });
  });

  it("shows the client's fields, escaped", async () => {
    const { code, html } = await page(sign({ purpose: "receipt", kind: "contribution", id: "contribution-abc123" }));
    expect(code).toBe(200);
    expect(html).toContain("Contribution receipt");
    expect(html).toContain("Puna &lt;yam&gt;");
    expect(html).toContain("Contribution reference");
    expect(html).toContain("Total paid");
    expect(html).toContain("£89.00");
    expect(m.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("doesn't say paid before anything was charged", async () => {
    m.findContribution.mockResolvedValue({ ...CONTRIBUTION, status: "PLEDGED" });
    const { html } = await page(sign({ purpose: "receipt", kind: "contribution", id: "contribution-abc123" }));
    expect(html).not.toContain("Total paid");
    expect(html).toContain("Total if it goes ahead");
    expect(html).toContain("Not charged yet");
  });

  it.each([
    ["an expired link", () => sign({ purpose: "receipt", kind: "contribution", id: "c" }, { expiresIn: -10 })],
    ["a tampered link", () => `${sign({ purpose: "receipt", kind: "contribution", id: "c" })}x`],
    ["a normal login token", () => sign({ role: "BUYER" })],
    ["a token for another purpose", () => sign({ purpose: "other", kind: "contribution", id: "c" })],
  ])("refuses %s", async (_label, make) => {
    const { code, html } = await page(make());
    expect(code).toBe(410);
    expect(html).not.toContain("Puna");
  });

  it("refuses a link for someone else's contribution", async () => {
    const { code, html } = await page(jwt.sign({ purpose: "receipt", kind: "contribution", id: "c" }, env.jwtSecret, { subject: "attacker" }));
    expect(code).toBe(410);
    expect(html).not.toContain("Puna");
  });
});
