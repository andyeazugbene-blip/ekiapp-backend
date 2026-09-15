/**
 * M7 — CommunityBuyOrganiserFee (spec §13.3/§15.6). Covers accrual
 * (exactly-once per capture, third-party-supply-only, self-dealing
 * exclusion, market-rate gating), hold/release, and the settlement gate —
 * cash settlement (STRIPE_CONNECT_TRANSFER) must refuse by default (spec
 * §1.3/§26 — no confirmed settlement route), while the two non-cash routes
 * spec §1.3 explicitly allows for v1 must succeed without any Stripe call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    campaignContribution: { findUnique: vi.fn() },
    organiserFeeAccrualEvent: { create: vi.fn() },
    communityBuyOrganiserFee: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    supplierProfile: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { organiserFeeService } from "../modules/community-buy/organiser-fee.service";

const m = vi.mocked(prisma, true);
const CAMPAIGN_ID = "camp-1";

function baseContribution(overrides: Partial<any> = {}) {
  return {
    id: "contrib-1",
    campaignId: CAMPAIGN_ID,
    currency: "GBP",
    quantity: 2,
    amount: 2000,
    isOrganiserTopUp: false,
    campaign: {
      id: CAMPAIGN_ID,
      organiserId: "org-1",
      fulfilmentOwner: "SUPPLIER",
      country: "GB",
      pricePerShareMinor: 1000,
      supplierAccountId: "supplier-account-1",
      supplierId: null,
    },
    ...overrides,
  };
}

const ORIGINAL_ENV = process.env.COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED;
  m.marketConfiguration.count.mockResolvedValue(1 as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED;
  else process.env.COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED = ORIGINAL_ENV;
});

describe("accrueForCapturedContribution()", () => {
  it("creates a new fee row on the first captured order, snapshotting feePerCapturedOrder from pricePerShareMinor x organiserFeeBps", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockResolvedValue(baseContribution() as any);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", organiserFeeBps: 500 } as any);
    m.organiserFeeAccrualEvent.create.mockResolvedValue({} as any);
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue(null as any);
    m.communityBuyOrganiserFee.create.mockResolvedValue({} as any);

    await svc.accrueForCapturedContribution("contrib-1");

    // feePerCapturedOrder = round(1000 * 500 / 10000) = 50; quantity=2 -> gross=100
    expect(m.communityBuyOrganiserFee.create).toHaveBeenCalledWith({
      data: {
        campaignId: CAMPAIGN_ID,
        organiserId: "org-1",
        supplierId: "supplier-account-1",
        currency: "GBP",
        feePerCapturedOrder: 50,
        capturedQuantity: 2,
        grossFeeAmount: 100,
        netFeeAmount: 100,
      },
    });
    expect(m.organiserFeeAccrualEvent.create).toHaveBeenCalledWith({ data: { campaignId: CAMPAIGN_ID, contributionId: "contrib-1", quantity: 2, amount: 2000 } });
  });

  it("increments an existing fee row on a second captured order for the same campaign", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockResolvedValue(baseContribution({ id: "contrib-2", quantity: 1 }) as any);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", organiserFeeBps: 500 } as any);
    m.organiserFeeAccrualEvent.create.mockResolvedValue({} as any);
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ campaignId: CAMPAIGN_ID, grossFeeAmount: 100, refundDeductionAmount: 0, disputeDeductionAmount: 0 } as any);
    m.communityBuyOrganiserFee.update.mockResolvedValue({} as any);

    await svc.accrueForCapturedContribution("contrib-2");

    expect(m.communityBuyOrganiserFee.update).toHaveBeenCalledWith({
      where: { campaignId: CAMPAIGN_ID },
      data: { capturedQuantity: { increment: 1 }, grossFeeAmount: 150, netFeeAmount: 150 },
    });
    expect(m.communityBuyOrganiserFee.create).not.toHaveBeenCalled();
  });

  it("never accrues an organiser's own rescue-window top-up (self-dealing exclusion)", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockResolvedValue(baseContribution({ isOrganiserTopUp: true }) as any);

    await svc.accrueForCapturedContribution("contrib-1");

    expect(m.marketConfiguration.findUnique).not.toHaveBeenCalled();
    expect(m.communityBuyOrganiserFee.create).not.toHaveBeenCalled();
  });

  it("never accrues for a self-fulfilled campaign (spec §13.3: third-party supply only)", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockResolvedValue(baseContribution({ campaign: { ...baseContribution().campaign, fulfilmentOwner: "SELF" } }) as any);

    await svc.accrueForCapturedContribution("contrib-1");

    expect(m.communityBuyOrganiserFee.create).not.toHaveBeenCalled();
  });

  it("never invents a default rate — no accrual when the market has no organiserFeeBps configured", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockResolvedValue(baseContribution() as any);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", organiserFeeBps: null } as any);

    await svc.accrueForCapturedContribution("contrib-1");

    expect(m.communityBuyOrganiserFee.create).not.toHaveBeenCalled();
  });

  it("no fee created twice for the same capture — a duplicate accrual attempt (P2002 on OrganiserFeeAccrualEvent) is a safe no-op", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockResolvedValue(baseContribution() as any);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", organiserFeeBps: 500 } as any);
    m.organiserFeeAccrualEvent.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    await svc.accrueForCapturedContribution("contrib-1");

    expect(m.communityBuyOrganiserFee.findUnique).not.toHaveBeenCalled();
    expect(m.communityBuyOrganiserFee.create).not.toHaveBeenCalled();
  });

  it("never throws — a genuine DB failure is caught and logged, never propagated (payment confirmation must never be put at risk)", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockRejectedValue(new Error("DB unavailable"));
    await expect(svc.accrueForCapturedContribution("contrib-1")).resolves.toBeUndefined();
  });

  it("no-ops when the contribution doesn't exist", async () => {
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.campaignContribution.findUnique.mockResolvedValue(null as any);
    await svc.accrueForCapturedContribution("missing");
    expect(m.marketConfiguration.findUnique).not.toHaveBeenCalled();
  });
});

describe("hold()/release()/holdForSystemReason()", () => {
  it("hold() requires a reasonCode", async () => {
    await expect(organiserFeeService.hold("admin-1", CAMPAIGN_ID, "")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("hold() refuses once already SETTLED", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "SETTLED", heldReasonCodes: [] } as any);
    await expect(organiserFeeService.hold("admin-1", CAMPAIGN_ID, "dispute_open")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("hold() records the reason code and moves to HELD", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "ACCRUED", heldReasonCodes: [] } as any);
    m.communityBuyOrganiserFee.update.mockResolvedValue({ status: "HELD", heldReasonCodes: ["dispute_open"] } as any);

    const result = await organiserFeeService.hold("admin-1", CAMPAIGN_ID, "dispute_open");
    expect(result.status).toBe("HELD");
  });

  it("release() only transitions HELD -> ACCRUED", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "ACCRUED" } as any);
    await expect(organiserFeeService.release("admin-1", CAMPAIGN_ID)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("holdForSystemReason() never throws when no fee row exists yet", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue(null as any);
    await expect(organiserFeeService.holdForSystemReason(CAMPAIGN_ID, "dispute_open")).resolves.toBeUndefined();
  });
});

describe("settleFee() — cash settlement gated, non-cash routes work today", () => {
  it("refuses STRIPE_CONNECT_TRANSFER when the settlement route is unconfirmed (the default, safe state)", async () => {
    await expect(organiserFeeService.settleFee("admin-1", CAMPAIGN_ID, "STRIPE_CONNECT_TRANSFER")).rejects.toMatchObject({ code: "ORGANISER_FEE_SETTLEMENT_ROUTE_NOT_CONFIRMED" });
    expect(m.communityBuyOrganiserFee.findUnique).not.toHaveBeenCalled();
  });

  it("EXTERNAL_SUPPLIER_ARRANGEMENT settles without any confirmation flag — no cash moves through Eki", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "ACCRUED", netFeeAmount: 100 } as any);
    m.communityBuyOrganiserFee.updateMany.mockResolvedValue({ count: 1 } as any);
    m.communityBuyOrganiserFee.findUniqueOrThrow.mockResolvedValue({ status: "SETTLED", settlementMethod: "EXTERNAL_SUPPLIER_ARRANGEMENT" } as any);

    const result = await organiserFeeService.settleFee("admin-1", CAMPAIGN_ID, "EXTERNAL_SUPPLIER_ARRANGEMENT", "invoice-123");
    expect(result.status).toBe("SETTLED");
  });

  it("NON_CASH_REWARD settles without any confirmation flag", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "ACCRUED", netFeeAmount: 100 } as any);
    m.communityBuyOrganiserFee.updateMany.mockResolvedValue({ count: 1 } as any);
    m.communityBuyOrganiserFee.findUniqueOrThrow.mockResolvedValue({ status: "SETTLED", settlementMethod: "NON_CASH_REWARD" } as any);

    const result = await organiserFeeService.settleFee("admin-1", CAMPAIGN_ID, "NON_CASH_REWARD");
    expect(result.status).toBe("SETTLED");
  });

  it("refuses to settle a fee that isn't ACCRUED (e.g. currently HELD)", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "HELD", netFeeAmount: 100 } as any);
    await expect(organiserFeeService.settleFee("admin-1", CAMPAIGN_ID, "NON_CASH_REWARD")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to settle when nothing has actually been accrued", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "ACCRUED", netFeeAmount: 0 } as any);
    await expect(organiserFeeService.settleFee("admin-1", CAMPAIGN_ID, "NON_CASH_REWARD")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("even with the flag set, STRIPE_CONNECT_TRANSFER still enforces the normal ACCRUED/net-amount guards", async () => {
    process.env.COMMUNITY_BUY_ORGANISER_FEE_SETTLEMENT_CONFIRMED = "true";
    const { organiserFeeService: svc } = await import("../modules/community-buy/organiser-fee.service");
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "HELD", netFeeAmount: 100 } as any);
    await expect(svc.settleFee("admin-1", CAMPAIGN_ID, "STRIPE_CONNECT_TRANSFER")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a lost race on the guarded settle claim refuses rather than double-settling", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", status: "ACCRUED", netFeeAmount: 100 } as any);
    m.communityBuyOrganiserFee.updateMany.mockResolvedValue({ count: 0 } as any);
    await expect(organiserFeeService.settleFee("admin-1", CAMPAIGN_ID, "NON_CASH_REWARD")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("read views", () => {
  it("get() 404s when no fee record exists", async () => {
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue(null as any);
    await expect(organiserFeeService.get(CAMPAIGN_ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("getMyFee() never exposes another organiser's record", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: CAMPAIGN_ID, organiserId: "org-1" } as any);
    await expect(organiserFeeService.getMyFee("org-2", CAMPAIGN_ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("getMyFee() returns the fee for the campaign's own organiser", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: CAMPAIGN_ID, organiserId: "org-1" } as any);
    m.communityBuyOrganiserFee.findUnique.mockResolvedValue({ id: "fee-1", campaignId: CAMPAIGN_ID } as any);
    const result = await organiserFeeService.getMyFee("org-1", CAMPAIGN_ID);
    expect(result.id).toBe("fee-1");
  });
});
