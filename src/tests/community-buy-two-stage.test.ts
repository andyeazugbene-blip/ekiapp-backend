/**
 * Regression tests for the two-stage bugs found against real Stripe test mode.
 * Stripe is mocked here, so these pin the shape of the calls: a real run is
 * still needed to prove Stripe accepts them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  contribution: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  authorisation: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  transaction: vi.fn(),
  customersCreate: vi.fn(),
  setupCreate: vi.fn(),
  setupRetrieve: vi.fn(),
  intentCreate: vi.fn(),
  intentCancel: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: m.campaign,
    campaignContribution: m.contribution,
    communityBuyPaymentAuthorisation: m.authorisation,
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    $transaction: m.transaction,
  },
}));
vi.mock("../lib/stripe", () => ({
  stripe: {
    customers: { create: m.customersCreate },
    setupIntents: { create: m.setupCreate, retrieve: m.setupRetrieve },
    paymentIntents: { create: m.intentCreate, cancel: m.intentCancel, retrieve: vi.fn(), capture: vi.fn() },
  },
}));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/events/dispatch-notifications", () => ({ dispatchNotificationsAfterCommit: vi.fn().mockResolvedValue(undefined) }));

import { campaignAuthorisationService } from "../modules/community-buy/campaign-authorisation.service";
import { defaultAuthorisationSchedule } from "../modules/community-buy/community-buy-timing";

const AUTHORISATION = {
  id: "auth-1", contributionId: "contrib-1", campaignId: "camp-1", supplierConnectedAccountId: "acct_1", stripeCustomerId: "cus_1", setupIntentId: "seti_1",
  paymentMethodReference: "pm_1", paymentIntentId: null, consentedChargeAmount: 8920, consentCurrency: "GBP", holdStatus: "NOT_REQUESTED", captureStatus: "NOT_CAPTURED", retryCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.authorisation.findMany.mockResolvedValue([]);
  m.authorisation.findUniqueOrThrow.mockResolvedValue(AUTHORISATION);
  m.authorisation.updateMany.mockResolvedValue({ count: 1 });
  m.contribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", quantity: 2, participant: { userId: "buyer" } });
});

describe("a hold must use the buyer's Customer", () => {
  it("sends the Customer with the off-session hold, which Stripe refuses without", async () => {
    m.intentCreate.mockResolvedValue({ id: "pi_1", status: "requires_capture", amount_capturable: 8920 });

    await campaignAuthorisationService.createHold("auth-1");

    expect(m.intentCreate.mock.calls[0][0]).toMatchObject({ customer: "cus_1", payment_method: "pm_1", off_session: true, capture_method: "manual" });
  });
});

describe("a bank check is not a decline", () => {
  it("keeps the buyer's place and lets them finish it", async () => {
    m.intentCreate.mockRejectedValue(Object.assign(new Error("auth needed"), { type: "StripeCardError", code: "authentication_required", payment_intent: { id: "pi_sca" } }));
    m.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ communityBuyPaymentAuthorisation: m.authorisation, event: { upsert: vi.fn(), create: vi.fn() }, notificationOutbox: { create: vi.fn() } }),
    );

    await campaignAuthorisationService.createHold("auth-1").catch(() => undefined);

    expect(m.authorisation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ holdStatus: "REQUIRES_ACTION", paymentIntentId: "pi_sca", holdRecoveryDeadline: expect.any(Date) }) }),
    );
  });
});

describe("holds opening while joining is still open", () => {
  it("skips a buyer who is still saving their card", async () => {
    m.campaign.findMany.mockResolvedValue([{ id: "camp-1", status: "LIVE" }]);

    await campaignAuthorisationService.openHoldWindows();

    const pendingQuery = m.authorisation.findMany.mock.calls.at(-1)?.[0];
    expect(pendingQuery.where).toMatchObject({ campaignId: "camp-1", paymentMethodReference: { not: "" } });
  });

  it("after joining closes, a commitment with no card is dealt with", async () => {
    m.campaign.findMany.mockResolvedValue([{ id: "camp-1", status: "HOLD_WINDOW" }]);

    await campaignAuthorisationService.openHoldWindows();

    expect(m.authorisation.findMany.mock.calls.at(-1)?.[0].where.paymentMethodReference).toBeUndefined();
  });

  it("releasing a hold while joining is open gives the place back", async () => {
    m.authorisation.findUniqueOrThrow.mockResolvedValue({ ...AUTHORISATION, holdStatus: "HOLD_SUCCEEDED", paymentIntentId: "pi_1" });
    m.contribution.updateMany.mockResolvedValue({ count: 1 });

    await campaignAuthorisationService.cancelHold("auth-1", "payment_recovery_timeout");

    expect(m.campaign.updateMany).toHaveBeenCalledWith({ where: { id: "camp-1", status: "LIVE" }, data: { confirmedShares: { decrement: 2 } } });
  });
});

describe("abandoned checkouts", () => {
  it("returns only cards never saved, on live campaigns, after the time limit", async () => {
    m.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ campaignContribution: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, communityCampaign: m.campaign, communityBuyPaymentAuthorisation: m.authorisation }),
    );
    m.authorisation.findMany.mockResolvedValue([{ id: "auth-9", contributionId: "contrib-9", campaignId: "camp-1", contribution: { quantity: 3 } }]);

    const released = await campaignAuthorisationService.releaseAbandonedCommitments("camp-1");

    expect(released).toBe(1);
    expect(m.authorisation.findMany.mock.calls[0][0].where).toMatchObject({ holdStatus: "NOT_REQUESTED", paymentMethodReference: "", campaign: { status: "LIVE" }, createdAt: { lt: expect.any(Date) } });
    expect(m.campaign.update).toHaveBeenCalledWith({ where: { id: "camp-1" }, data: { confirmedShares: { decrement: 3 } } });
  });
});

describe("schedule", () => {
  it("holds 48 hours before the deadline, decides 24 hours after", () => {
    const deadline = new Date("2026-12-10T12:00:00.000Z");
    const schedule = defaultAuthorisationSchedule(deadline);
    expect(schedule.holdWindowStartsAt.toISOString()).toBe("2026-12-08T12:00:00.000Z");
    expect(schedule.decisionDeadline.toISOString()).toBe("2026-12-11T12:00:00.000Z");
  });
});
