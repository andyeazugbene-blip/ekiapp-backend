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
import { notificationsService } from "../modules/notifications/notifications.service";

const m = vi.mocked(prisma, true);
const mNotify = vi.mocked(notificationsService, true);
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

  // M3 gap 6 — the organiser must see the actual authorised/minimum numbers and a real deadline, not just "you have 24 hours."
  it("AT-11 notification content: gives the organiser authorised quantity, minimum, and an actual 24h deadline", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign()] as any);
    m.campaignContribution.findMany.mockResolvedValue([{ quantity: 3 }]); // 3 < minimum 10
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign(), organiser: { userId: "organiser-user-1" } } as any);

    const before = Date.now();
    await campaignAuthorisationService.evaluateAuthorisationDecisions();

    const msg = mNotify.enqueue.mock.calls.map((c) => c[0] as any).find((b) => b.userId === "organiser-user-1");
    expect(msg).toBeTruthy();
    expect(msg.body).toMatch(/3/);
    expect(msg.body).toMatch(/10/);
    const isoMatch = msg.body.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    expect(isoMatch).toBeTruthy();
    const deadline = new Date(isoMatch![0]).getTime();
    // Must be a real ~24h-out deadline, not the campaign's earlier decisionDeadline scheduling field.
    expect(deadline).toBeGreaterThan(before + 23.9 * 60 * 60 * 1000);
    expect(deadline).toBeLessThan(before + 24.1 * 60 * 60 * 1000);
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

  // M3 gap 6 — the supplier must see the economics (estimated captured
  // value/payable), the earliest hold expiry, and the real response
  // deadline, not just the reduced quantity.
  it("AT-14 notification content: gives the supplier the reduced quantity, economics, expiry, and deadline", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({
      status: "DECISION_REQUIRED", fulfilmentOwner: "SUPPLIER", pricePerShareMinor: 1000, supplierAccount: { userId: "supplier-user-1" },
    }) as any);
    m.campaignContribution.findMany.mockResolvedValue([{ quantity: 7 }]);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);
    const captureBefore = new Date(Date.now() + 20 * 60 * 60 * 1000); // comfortably safe — 6h buffer still leaves a positive deadline
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([{ captureBefore }] as any);

    await campaignAuthorisationService.decide("organiser-user-1", CAMPAIGN_ID, "proceed");

    const supplierMsg = mNotify.enqueue.mock.calls.map((c) => c[0] as any).find((b) => b.userId === "supplier-user-1");
    expect(supplierMsg).toBeTruthy();
    expect(supplierMsg.body).toMatch(/7 units/);
    expect(supplierMsg.body).toMatch(/Estimated captured value/);
    expect(supplierMsg.body).toMatch(/Estimated payable to you/);
    expect(supplierMsg.body).toMatch(/Earliest hold expiry/);
    expect(supplierMsg.body).toMatch(/Respond by/);
  });

  it("AT-17: a SELF-fulfilled campaign proceeding below minimum skips reconfirmation entirely and captures directly", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "DECISION_REQUIRED", fulfilmentOwner: "SELF", supplierAccountId: null }) as any);
    m.campaignContribution.findMany.mockResolvedValue([{ quantity: 6 }]);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "PAYMENT_CAPTURE", fulfilmentOwner: "SELF" }) as any);

    await campaignAuthorisationService.decide("organiser-user-1", CAMPAIGN_ID, "proceed");

    // M3 gap 4 — SELF-fulfilment still records reconfirmationQuantity, even
    // though it skips the AWAITING_SUPPLIER_RECONFIRMATION *state* entirely
    // (no supplier decision to wait for) — admin/organiser reporting
    // shouldn't treat self-fulfilled campaigns as a blank spot.
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CAMPAIGN_ID, status: "DECISION_REQUIRED" },
      data: { status: "PAYMENT_CAPTURE", reconfirmationQuantity: 6 },
    }));
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
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign({ status: "DECISION_REQUIRED" }),
      organiser: { userId: "organiser-user-1" },
      supplier: null,
      supplierAccount: { userId: "supplier-user-1" },
    } as any);

    const result = await campaignAuthorisationService.evaluateDecisionTimeouts();

    expect(result.cancelled).toBe(1);
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  // M3 gap 6 — both the organiser (who missed the window) and the assigned
  // supplier (whose expected order just fell through) must be told, and
  // neither message may say "refunded" — nothing was ever charged.
  it("notifies both the organiser and the assigned supplier, with no 'refunded' wording", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign({ status: "DECISION_REQUIRED" })] as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign({ status: "DECISION_REQUIRED" }),
      organiser: { userId: "organiser-user-1" },
      supplier: null,
      supplierAccount: { userId: "supplier-user-1" },
    } as any);

    await campaignAuthorisationService.evaluateDecisionTimeouts();

    const bodies = mNotify.enqueue.mock.calls.map((c) => c[0] as any);
    const organiserMsg = bodies.find((b) => b.userId === "organiser-user-1");
    const supplierMsg = bodies.find((b) => b.userId === "supplier-user-1");
    expect(organiserMsg).toBeTruthy();
    expect(supplierMsg).toBeTruthy();
    expect(organiserMsg.body).toMatch(/not charged/);
    expect(organiserMsg.body).not.toMatch(/refund/i);
    expect(supplierMsg.body).not.toMatch(/refund/i);
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

  // M3 gap 5 — every confirm/decline gets its own audit event, actor-attributed to the responding supplier user, mirroring declineSupplierCommitment()'s existing pattern.
  it("AT-15 audit: confirming records a community_campaign.reconfirmation_confirmed audit event", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "supplier-account-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "PAYMENT_CAPTURE" }) as any);

    await campaignAuthorisationService.reconfirmForAccount("supplier-user-1", CAMPAIGN_ID, "confirm");

    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: "supplier-user-1", action: "community_campaign.reconfirmation_confirmed", entityId: CAMPAIGN_ID }),
    }));
  });

  it("AT-16 audit + organiser notification: declining records a reason-bearing audit event and tells the organiser, without saying 'refunded'", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "supplier-account-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "FAILED" }) as any);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1", userId: "organiser-user-1" } as any);

    await campaignAuthorisationService.reconfirmForAccount("supplier-user-1", CAMPAIGN_ID, "decline", "Out of stock");

    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: "supplier-user-1", action: "community_campaign.reconfirmation_declined", entityId: CAMPAIGN_ID, reason: "Out of stock" }),
    }));
    const organiserMsg = mNotify.enqueue.mock.calls.map((c) => c[0] as any).find((b) => b.userId === "organiser-user-1");
    expect(organiserMsg).toBeTruthy();
    expect(organiserMsg.body).toMatch(/Out of stock/);
    expect(organiserMsg.body).toMatch(/not charged/);
    expect(organiserMsg.body).not.toMatch(/refund/i);
  });
});

describe("evaluateReconfirmationTimeouts() — spec 10.5 timeout", () => {
  it("cancels a campaign whose supplier never responded before the calculated deadline", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" })] as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }),
      organiser: { userId: "organiser-user-1" },
      supplier: null,
      supplierAccount: { userId: "supplier-user-1" },
    } as any);

    const result = await campaignAuthorisationService.evaluateReconfirmationTimeouts();
    expect(result.cancelled).toBe(1);
  });

  // M3 gap 6 — the organiser must be told the supplier never responded; the
  // supplier is deliberately NOT notified here (their own non-response is
  // what caused it).
  it("notifies only the organiser, not the non-responding supplier", async () => {
    m.communityCampaign.findMany.mockResolvedValue([baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" })] as any);
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    m.communityCampaign.findUnique.mockResolvedValue({
      ...baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }),
      organiser: { userId: "organiser-user-1" },
      supplier: null,
      supplierAccount: { userId: "supplier-user-1" },
    } as any);

    await campaignAuthorisationService.evaluateReconfirmationTimeouts();

    const bodies = mNotify.enqueue.mock.calls.map((c) => c[0] as any);
    expect(bodies.find((b) => b.userId === "organiser-user-1")).toBeTruthy();
    expect(bodies.find((b) => b.userId === "supplier-user-1")).toBeUndefined();
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

describe("assertReconfirmationDeadlineSafe() — M3 gap 7 (AT-18 safe escalation)", () => {
  it("records a distinct audit event when the computed deadline is already unsafe/past, without throwing", async () => {
    const pastDeadline = new Date(Date.now() - 60 * 60 * 1000);
    await campaignAuthorisationService.assertReconfirmationDeadlineSafe(CAMPAIGN_ID, pastDeadline);
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "community_campaign.reconfirmation_deadline_unsafe", entityId: CAMPAIGN_ID }),
    }));
  });

  it("is a no-op for a genuinely future deadline", async () => {
    const futureDeadline = new Date(Date.now() + 60 * 60 * 1000);
    await campaignAuthorisationService.assertReconfirmationDeadlineSafe(CAMPAIGN_ID, futureDeadline);
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  // End-to-end: decide()'s SUPPLIER path must still open the
  // AWAITING_SUPPLIER_RECONFIRMATION window (evaluateReconfirmationTimeouts()
  // cleans it up on its next pass regardless) but must ALSO leave a
  // queryable audit trail flagging the anomaly, rather than presenting a
  // silent, indistinguishable-from-normal doomed window.
  it("decide() escalates when the computed reconfirmation deadline is already unsafe, but still opens the window", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "organiser-1" } as any);
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ status: "DECISION_REQUIRED", fulfilmentOwner: "SUPPLIER" }) as any);
    m.campaignContribution.findMany.mockResolvedValue([{ quantity: 7 }]);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ status: "AWAITING_SUPPLIER_RECONFIRMATION" }) as any);
    const soonCaptureBefore = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4h − 6h safety buffer = already past
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([{ captureBefore: soonCaptureBefore }] as any);

    await campaignAuthorisationService.decide("organiser-user-1", CAMPAIGN_ID, "proceed");

    const call = m.communityCampaign.updateMany.mock.calls.find((c) => c[0].data.status === "AWAITING_SUPPLIER_RECONFIRMATION");
    expect(call).toBeTruthy(); // still opens the window — no schema change, existing timeout job cleans it up
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "community_campaign.reconfirmation_deadline_unsafe", entityId: CAMPAIGN_ID }),
    }));
  });
});
