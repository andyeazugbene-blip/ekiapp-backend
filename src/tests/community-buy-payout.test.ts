/**
 * M2 — CommunityBuyPayout governance. Explicitly verifies the "never
 * falsely claim custody" rule: triggerManualPayout() must refuse unless
 * COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED=true is set, regardless of
 * approval state — see campaign-payout.service.ts's own doc comment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityBuyPayout: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { payouts: { create: vi.fn() } },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";

const m = vi.mocked(prisma, true);
const s = vi.mocked(stripe, true);
const CAMPAIGN_ID = "camp-payout-1";

function basePayout(overrides: Partial<any> = {}) {
  return {
    id: "payout-1",
    campaignId: CAMPAIGN_ID,
    supplierId: "supplier-account-1",
    supplierConnectedAccountId: "acct_connected_1",
    currency: "GBP",
    netPayoutAmount: 1900,
    status: "READY",
    holdReasonCodes: [],
    idempotencyKey: null,
    retryCount: 0,
    ...overrides,
  };
}

const ORIGINAL_ENV = process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED;
  else process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = ORIGINAL_ENV;
});

describe("triggerManualPayout() — never falsely claims custody", () => {
  it("refuses with PAYOUT_CUSTODY_NOT_CONFIRMED when the confirmation env flag is unset — the default, safe state", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_CUSTODY_NOT_CONFIRMED" });
    expect(s.payouts.create).not.toHaveBeenCalled();
    expect(m.communityBuyPayout.updateMany).not.toHaveBeenCalled();
  });

  it("refuses even for a READY payout when the flag is explicitly 'false'", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "false";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ code: "PAYOUT_CUSTODY_NOT_CONFIRMED" });
    expect(s.payouts.create).not.toHaveBeenCalled();
  });

  it("only moves money once the flag is explicitly 'true' AND the payout is READY", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    s.payouts.create.mockResolvedValue({ id: "po_1" } as any);
    m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "IN_TRANSIT", providerPayoutId: "po_1" }) as any);

    const result = await campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID);
    expect(result.status).toBe("IN_TRANSIT");
    expect(s.payouts.create).toHaveBeenCalledWith({ amount: 1900, currency: "GBP" }, expect.objectContaining({ stripeAccount: "acct_connected_1" }));
  });

  it("rejects releasing a payout that isn't READY, even with custody confirmed", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "HELD" }) as any);
    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toThrow(/not ready/);
    expect(s.payouts.create).not.toHaveBeenCalled();
  });

  it("a failed Stripe payout call marks the record FAILED, never silently PAID", async () => {
    process.env.COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED = "true";
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout() as any);
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    s.payouts.create.mockRejectedValue(new Error("insufficient funds"));

    await expect(campaignPayoutService.triggerManualPayout("admin-1", CAMPAIGN_ID)).rejects.toThrow(/Payout failed/);
    expect(m.communityBuyPayout.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });
});

describe("markReady()/hold() — governance only, never move money", () => {
  it("markReady() only transitions HELD -> READY", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "HELD" }) as any);
    m.communityBuyPayout.updateMany.mockResolvedValue({ count: 1 } as any);
    m.communityBuyPayout.findUniqueOrThrow.mockResolvedValue(basePayout({ status: "READY" }) as any);
    await campaignPayoutService.markReady("admin-1", CAMPAIGN_ID);
    expect(s.payouts.create).not.toHaveBeenCalled();
  });

  it("hold() records a reason code and never moves money", async () => {
    const { campaignPayoutService } = await import("../modules/community-buy/campaign-payout.service");
    m.communityBuyPayout.findUnique.mockResolvedValue(basePayout({ status: "READY", holdReasonCodes: [] }) as any);
    m.communityBuyPayout.update.mockResolvedValue(basePayout({ status: "HELD", holdReasonCodes: ["dispute"] }) as any);
    const result = await campaignPayoutService.hold("admin-1", CAMPAIGN_ID, "dispute");
    expect(result.status).toBe("HELD");
    expect(s.payouts.create).not.toHaveBeenCalled();
  });
});
