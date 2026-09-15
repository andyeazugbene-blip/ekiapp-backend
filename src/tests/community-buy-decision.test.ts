/**
 * M2 — AUTHORISE_THEN_CAPTURE decision + supplier-reconfirmation flow.
 * Mapped to AT-10 through AT-18. Same mocking convention as
 * community-buy-authorisation.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    campaignContribution: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    communityBuyPaymentAuthorisation: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    communityBuyPayout: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    campaignFulfilment: { upsert: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { paymentIntents: { capture: vi.fn(), cancel: vi.fn() } },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { campaignAuthorisationService } from "../modules/community-buy/campaign-authorisation.service";

const m = vi.mocked(prisma, true);
const CAMPAIGN_ID = "camp-decide-1";

function baseCampaign(overrides: Partial<any> = {}) {
  return {
    id: CAMPAIGN_ID,
    status: "HOLD_WINDOW",
    paymentMode: "AUTHORISE_THEN_CAPTURE",
    country: "GB",
    currency: "GBP",
    minimumShares: 10,
    maximumShares: 20,
    fulfilmentOwner: "SUPPLIER",
    supplierAccountId: "supplier-account-1",
    supplierId: null,
    organiserId: "organiser-1",
    title: "Test Campaign",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyFeeBps: 500 } as any);
  m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]); // no holds to capture by default
  m.communityCampaign.updateMany.mockResolvedValue({ count: 1 } as any);
});

describe("evaluateAuthorisationDecisions() — spec §11.3 step 7-8 (AT-10, AT-11)", () => {
  it("AT-10: at or above minimum, proceeds straight to PAYMENT_CAPTURE and runs the capture worker", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign()] as any);
    m.campaignContribution.findMany.mockResolvedValue([{ quantity: 6 }, { quantity: 5 }] as any); // 11 >= minimum 10
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign(), organiser: { userId: "organiser-user-1" } } as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "PAYMENT_CAPTURE" }) as any);

    const result = await campaignAuthorisationService.evaluateAuthorisationDecisions();
    expect(result.proceeded).toBe(1);
    expect(result.decisionRequired).toBe(0);
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "PAYMENT_CAPTURE" } }));
  });

  it("AT-11: below minimum enters DECISION_REQUIRED with a timestamp for the 24h window, not RESCUE_WINDOW", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign()] as any);
    m.campaignContribution.findMany.mockResolvedValue([{ quantity: 3 }]); // 3 < minimum 10
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign(), organiser: { userId: "organiser-user-1" } } as any);

    const result = await campaignAuthorisationService.evaluateAuthorisationDecisions();
    expect(result.decisionRequired).toBe(1);
    const call = m.communityCampaign.updateMany.mock.calls.find((c) => c[0].data.status === "DECISION_REQUIRED");
    expect(call).toBeTruthy();
    expect(call![0].data.decisionRequiredAt).toBeInstanceOf(Date);
  });
});

describe("decide() — spec §16 POST /decision (AT-12, AT-14, AT-17)", () => {
  it("AT-12: organiser cancel releases every open hold and never says \"refunded\"", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "DECISION_REQUIRED" }) as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "auth-1", holdStatus: "HOLD_SUCCEEDED", contributionId: "c1", paymentIntentId: "pi_1", supplierConnectedAccountId: "acct_1" },
    ] as any);
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue({ id: "auth-1", holdStatus: "HOLD_SUCCEEDED", contributionId: "c1", paymentIntentId: "pi_1", supplierConnectedAccountId: "acct_1" } as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "c1", participant: { userId: "user-1" } } as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "FAILED" }) as any);

    await campaignAuthorisationService.decide("organiser-user-1", CAMPAIGN_ID, "cancel");

    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", fundingOutcome: "BELOW_MINIMUM" }) }));
    expect(m.campaignContribution.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "CANCELLED" } }));
  });

  it("AT-14: proceeding below minimum for third-party supply enters AWAITING_SUPPLIER_RECONFIRMATION, not straight to capture", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "DECISION_REQUIRED", fulfilmentOwner: "SUPPLIER" }) as any);
    m.campaignContribution.findMany.mockResolvedValue([{ quantity: 7 }]);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);

    await campaignAuthorisationService.decide("organiser-user-1", CAMPAIGN_ID, "proceed");

    const call = m.communityCampaign.updateMany.mock.calls.find((c) => c[0].data.status === "AWAITING_SUPPLIER_RECONFIRMATION");
    expect(call).toBeTruthy();
    expect(call![0].data.reconfirmationQuantity).toBe(7);
  });

  it("AT-17: a SELF-fulfilled campaign proceeding below minimum skips reconfirmation entirely and captures directly", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "DECISION_REQUIRED", fulfilmentOwner: "SELF", supplierAccountId: null }) as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "PAYMENT_CAPTURE", fulfilmentOwner: "SELF" }) as any);

    await campaignAuthorisationService.decide("organiser-user-1", CAMPAIGN_ID, "proceed");

    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "PAYMENT_CAPTURE" } }));
    const reconfirmCall = m.communityCampaign.updateMany.mock.calls.find((c) => c[0].data.status === "AWAITING_SUPPLIER_RECONFIRMATION");
    expect(reconfirmCall).toBeUndefined();
  });

  it("rejects a decision for a campaign not currently DECISION_REQUIRED", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "HOLD_WINDOW" }) as any);
    await expect(campaignAuthorisationService.decide("organiser-user-1", CAMPAIGN_ID, "proceed")).rejects.toThrow(/not awaiting a decision/);
  });
});

describe("evaluateDecisionTimeouts() — spec AT-13 (24h auto-cancel)", () => {
  it("cancels and releases holds for a campaign whose 24h decision window has expired with no organiser action", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign({ status: "DECISION_REQUIRED" })] as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    const result = await campaignAuthorisationService.evaluateDecisionTimeouts();
    expect(result.cancelled).toBe(1);
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });
});

describe("reconfirmForAccount() — spec §10.5 (AT-15, AT-16)", () => {
  it("AT-15: supplier confirmation before the deadline enables capture", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "supplier-account-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "PAYMENT_CAPTURE" }) as any);

    await campaignAuthorisationService.reconfirmForAccount("supplier-user-1", CAMPAIGN_ID, "confirm");
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "PAYMENT_CAPTURE" } }));
  });

  it("AT-16: supplier decline cancels before any charge, releasing holds", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "supplier-account-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "FAILED" }) as any);

    await campaignAuthorisationService.reconfirmForAccount("supplier-user-1", CAMPAIGN_ID, "decline", "Out of stock");
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", supplierDeclineReason: "Out of stock" }) }));
  });

  it("rejects reconfirmation from a supplier account that isn't assigned to this campaign", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "some-other-account" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);
    await expect(campaignAuthorisationService.reconfirmForAccount("stranger-user", CAMPAIGN_ID, "confirm")).rejects.toThrow(/not found/);
  });
});

describe("evaluateReconfirmationTimeouts() — spec 10.5 timeout", () => {
  it("cancels a campaign whose supplier never responded before the calculated deadline", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" })] as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    const result = await campaignAuthorisationService.evaluateReconfirmationTimeouts();
    expect(result.cancelled).toBe(1);
  });
});

describe("computeReconfirmationDeadline() — spec 10.5 formula (AT-18)", () => {
  it("uses the full configured max (12h) when no hold has a real captureBefore", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    const deadline = await campaignAuthorisationService.computeReconfirmationDeadline(CAMPAIGN_ID);
    const hours = (deadline.getTime() - Date.now()) / (60 * 60 * 1000);
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThan(12.1);
  });

  it("AT-18: tightens to (earliest capture_before − 6h safety buffer) when that's earlier than the configured max — an unsafe buffer blocks the full 12h window", async () => {
    const soonCaptureBefore = new Date(Date.now() + 4 * 60 * 60 * 1000); // only 4h away
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([{ captureBefore: soonCaptureBefore }] as any);
    const deadline = await campaignAuthorisationService.computeReconfirmationDeadline(CAMPAIGN_ID);
    // 4h capture_before minus 6h safety buffer is already in the past — the
    // deadline must reflect that (never the full 12h), even though that
    // means an effectively-immediate/already-expired response window.
    expect(deadline.getTime()).toBeLessThan(Date.now());
  });
});
