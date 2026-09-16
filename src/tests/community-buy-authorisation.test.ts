/**
 * M2 — AUTHORISE_THEN_CAPTURE payment flow. Mapped directly to the
 * acceptance tests named in the M2 plan: AT-04, AT-05, AT-06, AT-07,
 * AT-08, AT-09, AT-19, AT-20, AT-21, AT-22, AT-23, AT-24.
 *
 * Mocking convention matches community-buy.test.ts exactly: a hand-rolled
 * flat vi.mock("../lib/prisma") object, vi.mock("../lib/stripe") scoped to
 * only the methods this flow touches, $transaction mocked as vi.fn() with
 * a per-test mockImplementationOnce(async (cb) => cb({...})) supplying the
 * transactional client. PLEDGE_THEN_CHARGE's own tests are untouched by
 * this file — nothing here imports or exercises campaign-contributions.
 * service.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    campaignParticipant: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    campaignContribution: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    communityBuyPaymentAuthorisation: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    communityBuyPayout: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    campaignFulfilment: { upsert: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    vendor: { findUnique: vi.fn() },
    marketConfiguration: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: {
    setupIntents: { create: vi.fn(), retrieve: vi.fn() },
    paymentIntents: { create: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { notificationsService } from "../modules/notifications/notifications.service";
import { campaignAuthorisationService } from "../modules/community-buy/campaign-authorisation.service";

const m = vi.mocked(prisma, true);
const s = vi.mocked(stripe, true);

const CAMPAIGN_ID = "camp-authorise-1";
const SUPPLIER_ACCOUNT_ID = "supplier-account-1";
const CONNECTED_ACCOUNT_ID = "acct_connected_1";

function baseCampaign(overrides: Partial<any> = {}) {
  return {
    id: CAMPAIGN_ID,
    status: "LIVE",
    paymentMode: "AUTHORISE_THEN_CAPTURE",
    country: "GB",
    currency: "GBP",
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
    pricePerShareMinor: 1000,
    maximumShares: 10,
    minimumShares: 5,
    confirmedShares: 0,
    fulfilmentOwner: "SUPPLIER",
    supplierAccountId: SUPPLIER_ACCOUNT_ID,
    supplierId: null,
    termsLockedAt: null,
    ...overrides,
  };
}

function baseAuthorisation(overrides: Partial<any> = {}) {
  return {
    id: "auth-1",
    contributionId: "contrib-1",
    campaignId: CAMPAIGN_ID,
    supplierConnectedAccountId: CONNECTED_ACCOUNT_ID,
    setupIntentId: "seti_1",
    paymentMethodReference: "pm_1",
    paymentIntentId: null,
    consentedChargeAmount: 2000,
    consentCurrency: "GBP",
    authorisedAmount: null,
    holdStatus: "NOT_REQUESTED",
    captureStatus: "NOT_CAPTURED",
    retryCount: 0,
    idempotencyKey: "hold:contrib-1:0",
    ...overrides,
  };
}

/** Minimal stateful fake for tests that need a call's return value to reflect a PRECEDING call's write (e.g. captureHold()'s final re-fetch after its own updateMany). */
function makeAuthorisationStore(initial: Record<string, any>) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const row = store.get(where.id);
      if (!row) throw new Error(`not found: ${where.id}`);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = store.get(where.id) ?? {};
      const updated = { ...row, ...data };
      store.set(where.id, updated);
      return { ...updated };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = store.get(where.id);
      if (!row) return { count: 0 };
      const guardOk = Object.entries(where).every(([key, expected]) => {
        if (key === "id") return true;
        if (expected && typeof expected === "object" && "in" in (expected as any)) return (expected as any).in.includes((row as any)[key]);
        return (row as any)[key] === expected;
      });
      if (!guardOk) return { count: 0 };
      store.set(where.id, { ...row, ...data });
      return { count: 1 };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.marketConfiguration.count.mockResolvedValue(1);
  m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true, communityBuyPaymentsEnabled: true, communityBuyPaymentMode: "AUTHORISE_THEN_CAPTURE", communityBuyFeeBps: 500 } as any);
  // upsertParticipantWithAttribution() defaults — a fresh, non-organiser, non-reorder join.
  m.campaignParticipant.findUnique.mockResolvedValue(null as any);
  m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as any);
  m.campaignParticipant.findFirst.mockResolvedValue(null as any);
  m.campaignParticipant.create.mockResolvedValue({ id: "participant-1" } as any);
});

describe("commit() — spec §11.2 commitment phase (AT-04, AT-05)", () => {
  it("AT-04/AT-05: creates the SetupIntent IN the connected-account context, persists references, never populates authorisedAmount, never writes a ledger entry", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign() as any);
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: CONNECTED_ACCOUNT_ID } as any);
    m.campaignParticipant.upsert.mockResolvedValue({ id: "participant-1" } as any);
    m.$transaction.mockImplementationOnce(async (cb: any) =>
      cb({
        communityCampaign: { findUniqueOrThrow: vi.fn().mockResolvedValue(baseCampaign()), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() },
        campaignContribution: { create: vi.fn().mockResolvedValue({ id: "contrib-1" }) },
      }),
    );
    s.setupIntents.create.mockResolvedValue({ id: "seti_1", client_secret: "seti_1_secret_x" } as any);
    m.communityBuyPaymentAuthorisation.create.mockResolvedValue(baseAuthorisation() as any);

    const result = await campaignAuthorisationService.commit("user-1", CAMPAIGN_ID, 2);

    expect(result.status).toBe("PLEDGED");
    expect(result.setupIntentClientSecret).toBe("seti_1_secret_x");

    // The connected-account context is what makes this a Direct Charge —
    // not a platform-account SetupIntent the way BuyerPaymentMethod uses.
    expect(s.setupIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ usage: "off_session" }),
      expect.objectContaining({ stripeAccount: CONNECTED_ACCOUNT_ID }),
    );

    const createCall = m.communityBuyPaymentAuthorisation.create.mock.calls[0][0];
    expect(createCall.data.authorisedAmount).toBeUndefined();
    expect(createCall.data.holdStatus).toBe("NOT_REQUESTED");
    expect(createCall.data.supplierConnectedAccountId).toBe(CONNECTED_ACCOUNT_ID);

    expect(m.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects when the campaign's supplier has no connected account yet (Direct Charges cannot proceed)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign() as any);
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: null } as any);
    await expect(campaignAuthorisationService.commit("user-1", CAMPAIGN_ID, 1)).rejects.toMatchObject({ code: "SUPPLIER_NOT_PAYOUT_READY" });
    expect(s.setupIntents.create).not.toHaveBeenCalled();
  });

  it("rejects a commit() call against a PLEDGE_THEN_CHARGE campaign — the two flows never cross", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign({ paymentMode: "PLEDGE_THEN_CHARGE" }) as any);
    await expect(campaignAuthorisationService.commit("user-1", CAMPAIGN_ID, 1)).rejects.toThrow(/authorise-then-capture/);
  });

  it("AT-06 twin: a concurrent commit() losing the capacity race gets CAPACITY_UNAVAILABLE — no double-decrement", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign() as any);
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: CONNECTED_ACCOUNT_ID } as any);
    m.campaignParticipant.upsert.mockResolvedValue({ id: "participant-1" } as any);
    m.$transaction.mockImplementationOnce(async (cb: any) =>
      cb({
        communityCampaign: { findUniqueOrThrow: vi.fn().mockResolvedValue(baseCampaign()), updateMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn() },
        campaignContribution: { create: vi.fn() },
      }),
    );
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign({ confirmedShares: 10 }) as any);

    await expect(campaignAuthorisationService.commit("user-1", CAMPAIGN_ID, 2)).rejects.toMatchObject({ code: "CAPACITY_UNAVAILABLE" });
    expect(s.setupIntents.create).not.toHaveBeenCalled();
  });
});

describe("createHold() — spec §11.3 hold creation (AT-07, AT-08, AT-09)", () => {
  it("AT-07: a requires_capture PaymentIntent marks HOLD_SUCCEEDED and sets authorisedAmount — never CAPTURED", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation() as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    s.paymentIntents.create.mockResolvedValue({ id: "pi_1", status: "requires_capture", amount_capturable: 2000 } as any);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);

    await campaignAuthorisationService.createHold("auth-1");

    expect(s.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ capture_method: "manual", off_session: true, confirm: true }),
      expect.objectContaining({ stripeAccount: CONNECTED_ACCOUNT_ID, idempotencyKey: "hold:contrib-1:1" }),
    );
    const succeededUpdate = m.communityBuyPaymentAuthorisation.updateMany.mock.calls.find((c) => c[0].data.holdStatus === "HOLD_SUCCEEDED");
    expect(succeededUpdate).toBeTruthy();
    expect(succeededUpdate![0].data.authorisedAmount).toBe(2000);
    expect(succeededUpdate![0].data.captureBefore).toBeUndefined();
  });

  it("AT-08: a requires_action outcome does not count toward authorised quantity until resolved", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation() as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    s.paymentIntents.create.mockResolvedValue({ id: "pi_1", status: "requires_action" } as any);

    await campaignAuthorisationService.createHold("auth-1");

    const holdStatusUpdate = m.communityBuyPaymentAuthorisation.update.mock.calls.find((c) => c[0].data.holdStatus === "REQUIRES_ACTION");
    expect(holdStatusUpdate).toBeTruthy();

    // getAuthorisedQuantity only counts HOLD_SUCCEEDED rows.
    m.campaignContribution.findMany.mockResolvedValue([]);
    const authorisedQuantity = await campaignAuthorisationService.getAuthorisedQuantity(CAMPAIGN_ID);
    expect(authorisedQuantity).toBe(0);
  });

  it("AT-09: a genuine decline marks HOLD_DECLINED with a recovery deadline, excluded from authorised quantity", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation() as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    s.paymentIntents.create.mockRejectedValue(Object.assign(new Error("card_declined"), { code: "card_declined" }));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);

    await campaignAuthorisationService.createHold("auth-1");

    const declineUpdate = m.communityBuyPaymentAuthorisation.update.mock.calls.find((c) => c[0].data.holdStatus === "HOLD_DECLINED");
    expect(declineUpdate).toBeTruthy();
    expect(declineUpdate![0].data.holdRecoveryDeadline).toBeInstanceOf(Date);
  });

  it("is idempotent — a hold already HOLD_SUCCEEDED is never re-attempted", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED" }) as any);
    const result = await campaignAuthorisationService.createHold("auth-1");
    expect(result.holdStatus).toBe("HOLD_SUCCEEDED");
    expect(s.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("a StripeConnectionError leaves the hold HOLD_PENDING — ambiguous, not declined (mirrors attemptCharge()'s identical reasoning)", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation() as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    s.paymentIntents.create.mockRejectedValue(Object.assign(new Error("timeout"), { type: "StripeConnectionError" }));

    await campaignAuthorisationService.createHold("auth-1");
    // Never transitioned to HOLD_DECLINED for an ambiguous provider error —
    // only the diagnostic providerErrorCode is recorded.
    const declineCall = m.communityBuyPaymentAuthorisation.update.mock.calls.find((c) => c[0].data.holdStatus === "HOLD_DECLINED");
    expect(declineCall).toBeUndefined();
    expect(m.communityBuyPaymentAuthorisation.update).toHaveBeenCalledWith({ where: { id: "auth-1" }, data: { providerErrorCode: null } });
  });
});

describe("requeryAmbiguousHold() — reliability recovery", () => {
  it("replays the SAME stored idempotencyKey, never a new one", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_PENDING", idempotencyKey: "hold:contrib-1:1" }) as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    s.paymentIntents.create.mockResolvedValue({ id: "pi_1", status: "requires_capture", amount_capturable: 2000 } as any);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);

    const outcome = await campaignAuthorisationService.requeryAmbiguousHold("auth-1");
    expect(outcome.handled).toBe(true);
    expect(s.paymentIntents.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idempotencyKey: "hold:contrib-1:1" }));
  });

  it("is a no-op when there is nothing ambiguous to resolve", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED" }) as any);
    const outcome = await campaignAuthorisationService.requeryAmbiguousHold("auth-1");
    expect(outcome.handled).toBe(false);
    expect(s.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe("cancelHold() — spec §11.5 (never call it a refund)", () => {
  it("cancels the Stripe hold and marks the contribution CANCELLED, not REFUNDED", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED", paymentIntentId: "pi_1" }) as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);

    await campaignAuthorisationService.cancelHold("auth-1", "organiser_cancelled");

    expect(s.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", undefined, { stripeAccount: CONNECTED_ACCOUNT_ID });
    expect(m.campaignContribution.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "CANCELLED" } }));
  });

  it("is idempotent — an already-released hold is never cancelled twice at Stripe", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_RELEASED" }) as any);
    await campaignAuthorisationService.cancelHold("auth-1", "organiser_cancelled");
    expect(s.paymentIntents.cancel).not.toHaveBeenCalled();
  });
});

describe("captureHold()/captureWorker() — spec §11.4 (AT-19, AT-20, AT-21)", () => {
  it("AT-19: a successful capture posts the fee + supplier-payable ledger legs exactly once, application_fee_amount split in the SAME Stripe call (no separate transfer)", async () => {
    const authStore = makeAuthorisationStore({ "auth-1": baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_1", authorisedAmount: 2000 }) });
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockImplementation(authStore.findUniqueOrThrow as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockImplementation(authStore.updateMany as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign() as any);
    s.paymentIntents.capture.mockResolvedValue({ id: "pi_1", status: "succeeded" } as any);
    m.$transaction.mockImplementationOnce(async (cb: any) => cb(m));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: CONNECTED_ACCOUNT_ID } as any);
    m.communityBuyPayout.findUnique.mockResolvedValue(null);
    m.ledgerAccount.findUnique.mockResolvedValue(null);
    m.ledgerAccount.create.mockImplementation(async (args: any) => ({ id: `acct-${args.data.type}`, ...args.data }));

    const result = await campaignAuthorisationService.captureHold("auth-1");

    expect(result.captureStatus).toBe("CAPTURED");
    expect(s.paymentIntents.capture).toHaveBeenCalledWith(
      "pi_1",
      { application_fee_amount: 100 }, // 2000 * 500bps = 100
      expect.objectContaining({ stripeAccount: CONNECTED_ACCOUNT_ID, idempotencyKey: "capture:auth-1" }),
    );
    // Fee leg + supplier-payable leg = 4 ledger entries total (2 balanced pairs).
    expect(m.ledgerEntry.create).toHaveBeenCalledTimes(4);
    expect(m.campaignContribution.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) }));
  });

  // M3 gap 1 fix — a HOLD_EXPIRING hold is only a warning flag
  // (hold_expiry_monitor's admin alert), not terminal/declined; the
  // underlying Stripe authorisation is still live and must remain
  // capturable. Before this fix, captureHold()/captureWorker() excluded
  // HOLD_EXPIRING entirely, so a hold that happened to get warning-flagged
  // moments before capture was silently skipped and counted as failed for
  // no Stripe-side reason.
  it("M3 regression: a HOLD_EXPIRING hold (warning-flagged, not declined) still captures successfully via captureHold()", async () => {
    const authStore = makeAuthorisationStore({ "auth-1": baseAuthorisation({ holdStatus: "HOLD_EXPIRING", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_1", authorisedAmount: 2000 }) });
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockImplementation(authStore.findUniqueOrThrow as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockImplementation(authStore.updateMany as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign() as any);
    s.paymentIntents.capture.mockResolvedValue({ id: "pi_1", status: "succeeded" } as any);
    m.$transaction.mockImplementationOnce(async (cb: any) => cb(m));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: CONNECTED_ACCOUNT_ID } as any);
    m.communityBuyPayout.findUnique.mockResolvedValue(null);
    m.ledgerAccount.findUnique.mockResolvedValue(null);
    m.ledgerAccount.create.mockImplementation(async (args: any) => ({ id: `acct-${args.data.type}`, ...args.data }));

    const result = await campaignAuthorisationService.captureHold("auth-1");

    expect(result.captureStatus).toBe("CAPTURED");
    expect(s.paymentIntents.capture).toHaveBeenCalledWith("pi_1", { application_fee_amount: 100 }, expect.objectContaining({ idempotencyKey: "capture:auth-1" }));
  });

  it("M3 regression: captureWorker() includes HOLD_EXPIRING holds in its query, not just HOLD_SUCCEEDED", async () => {
    const authStore = makeAuthorisationStore({ "auth-1": baseAuthorisation({ holdStatus: "HOLD_EXPIRING", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_1", authorisedAmount: 2000 }) });
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([...authStore.store.values()] as any);
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockImplementation(authStore.findUniqueOrThrow as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockImplementation(authStore.updateMany as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign() as any);
    s.paymentIntents.capture.mockResolvedValue({ id: "pi_1", status: "succeeded" } as any);
    m.$transaction.mockImplementation(async (cb: any) => cb(m));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: CONNECTED_ACCOUNT_ID } as any);
    m.communityBuyPayout.findUnique.mockResolvedValue(null);
    m.ledgerAccount.findUnique.mockResolvedValue(null);
    m.ledgerAccount.create.mockImplementation(async (args: any) => ({ id: `acct-${args.data.type}`, ...args.data }));
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 } as any);

    const result = await campaignAuthorisationService.captureWorker(CAMPAIGN_ID);

    expect(result.total).toBe(1);
    expect(result.captured).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("AT-20: a capture failure leaves the contribution OUT of PAID/fulfilment — no successful payment entry", async () => {
    const authorisation = baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_1", authorisedAmount: 2000 });
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(authorisation as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign() as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    s.paymentIntents.capture.mockRejectedValue(new Error("card no longer valid"));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);

    const result = await campaignAuthorisationService.captureHold("auth-1");

    expect(m.communityBuyPaymentAuthorisation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ captureStatus: "CAPTURE_FAILED" }) }));
    expect(m.campaignContribution.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) }));
    expect(m.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it("blocks capture entirely when the market has no configured processing fee (same invariant as the old mode's releaseSupplierPayment)", async () => {
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED" }) as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign() as any);
    m.marketConfiguration.findUnique.mockResolvedValue({ countryCode: "GB", communityBuyFeeBps: null } as any);

    await expect(campaignAuthorisationService.captureHold("auth-1")).rejects.toMatchObject({ code: "FEE_NOT_CONFIGURED" });
    expect(s.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("AT-21/captureWorker: one failing and one succeeding hold in the same campaign are handled independently", async () => {
    const authStore = makeAuthorisationStore({
      "auth-ok": baseAuthorisation({ id: "auth-ok", contributionId: "contrib-ok", holdStatus: "HOLD_SUCCEEDED", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_ok", authorisedAmount: 1000 }),
      "auth-bad": baseAuthorisation({ id: "auth-bad", contributionId: "contrib-bad", holdStatus: "HOLD_SUCCEEDED", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_bad", authorisedAmount: 1000 }),
    });
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([...authStore.store.values()] as any);
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockImplementation(authStore.findUniqueOrThrow as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockImplementation(authStore.updateMany as any);
    m.communityBuyPaymentAuthorisation.update.mockImplementation(authStore.update as any);
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue(baseCampaign() as any);
    s.paymentIntents.capture.mockImplementation(async (id: string) => {
      if (id === "pi_ok") return { id: "pi_ok", status: "succeeded" } as any;
      throw new Error("declined");
    });
    m.$transaction.mockImplementation(async (cb: any) => cb(m));
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-ok", participant: { userId: "user-1" } } as any);
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: CONNECTED_ACCOUNT_ID } as any);
    m.communityBuyPayout.findUnique.mockResolvedValue(null);
    m.ledgerAccount.findUnique.mockResolvedValue(null);
    m.ledgerAccount.create.mockImplementation(async (args: any) => ({ id: `acct-${args.data.type}`, ...args.data }));
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 } as any);

    const result = await campaignAuthorisationService.captureWorker(CAMPAIGN_ID);
    expect(result.total).toBe(2);
    expect(result.captured).toBe(1);
    expect(result.failed).toBe(1);
    // Even with one failure, the campaign still leaves PAYMENT_CAPTURE once every hold has been attempted.
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FULFILLING" } }));
  });
});

describe("resolveHoldWebhook() — spec §17.1 (AT-22, AT-23)", () => {
  it("AT-22: a duplicate payment_intent.succeeded for an already-CAPTURED hold is a safe no-op — no second ledger post", async () => {
    m.communityBuyPaymentAuthorisation.findUnique.mockResolvedValue(baseAuthorisation({ captureStatus: "CAPTURED" }) as any);
    const outcome = await campaignAuthorisationService.resolveHoldWebhook("auth-1", "payment_intent.succeeded", { id: "pi_1" } as any);
    expect(outcome.handled).toBe(true);
    expect(m.communityBuyPaymentAuthorisation.updateMany).not.toHaveBeenCalled();
    expect(m.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it("AT-23: amount_capturable_updated arriving AFTER the synchronous path already applied HOLD_SUCCEEDED preserves valid final state (out-of-order tolerant)", async () => {
    m.communityBuyPaymentAuthorisation.findUnique.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED" }) as any);
    const outcome = await campaignAuthorisationService.resolveHoldWebhook("auth-1", "payment_intent.amount_capturable_updated", { id: "pi_1" } as any);
    expect(outcome.handled).toBe(true);
    expect(m.communityBuyPaymentAuthorisation.updateMany).not.toHaveBeenCalled();
  });

  it("an unexpected provider-side cancellation (issuer auto-expiry) that never went through cancelHold() still resolves to HOLD_RELEASED", async () => {
    m.communityBuyPaymentAuthorisation.findUnique.mockResolvedValue(baseAuthorisation({ holdStatus: "HOLD_SUCCEEDED" }) as any);
    m.campaignContribution.updateMany.mockResolvedValue({ count: 1 } as any);
    const outcome = await campaignAuthorisationService.resolveHoldWebhook("auth-1", "payment_intent.canceled", { id: "pi_1" } as any);
    expect(outcome.handled).toBe(true);
    expect(m.communityBuyPaymentAuthorisation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { holdStatus: "HOLD_RELEASED" } }));
  });

  it("returns handled:false for an unrelated event type", async () => {
    m.communityBuyPaymentAuthorisation.findUnique.mockResolvedValue(baseAuthorisation() as any);
    const outcome = await campaignAuthorisationService.resolveHoldWebhook("auth-1", "charge.dispute.created", {} as any);
    expect(outcome.handled).toBe(false);
  });
});

describe("payment_recovery_timeout — spec §17.2 (AT-24)", () => {
  it("AT-24: a declined hold past its recovery deadline is released safely, never captured", async () => {
    const expired = baseAuthorisation({ id: "auth-expired", holdStatus: "HOLD_DECLINED", holdRecoveryDeadline: new Date(Date.now() - 1000) });
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([expired] as any);
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue(expired as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "user-1" } } as any);

    const result = await campaignAuthorisationService.paymentRecoveryTimeout();
    expect(result.released).toBe(1);
    expect(s.paymentIntents.capture).not.toHaveBeenCalled();
  });
});

describe("onCaptureSucceeded() — CommunityBuyPayout creation, spec §H", () => {
  it("creates a HELD payout on the first capture, then increments it on subsequent captures for the same campaign", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: CONNECTED_ACCOUNT_ID } as any);
    m.communityBuyPayout.findUnique.mockResolvedValueOnce(null);
    await campaignAuthorisationService.onCaptureSucceeded(baseCampaign() as any, 1900, 100, 2000, "GBP");
    expect(m.communityBuyPayout.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "HELD", supplierPayableAmount: 1900, ekiFeeAmount: 100, capturedGrossAmount: 2000 }) }));

    m.communityBuyPayout.findUnique.mockResolvedValueOnce({ campaignId: CAMPAIGN_ID } as any);
    await campaignAuthorisationService.onCaptureSucceeded(baseCampaign() as any, 950, 50, 1000, "GBP");
    expect(m.communityBuyPayout.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supplierPayableAmount: { increment: 950 } }) }));
    expect(m.communityBuyPayout.create).toHaveBeenCalledTimes(1);
  });

  it("never creates a payout row for a SELF-fulfilled campaign", async () => {
    await campaignAuthorisationService.onCaptureSucceeded(baseCampaign({ fulfilmentOwner: "SELF", supplierAccountId: null }) as any, 1900, 100, 2000, "GBP");
    expect(m.communityBuyPayout.create).not.toHaveBeenCalled();
  });
});

describe("releaseAllHoldsForCampaign() — M9/AT-25 fix: never releases an already-captured hold", () => {
  it("skips a HOLD_SUCCEEDED hold whose captureStatus is CAPTURED — no cancelHold(), no false 'not charged' notification", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([] as any); // the captureStatus filter excludes it before this ever runs
    await campaignAuthorisationService.releaseAllHoldsForCampaign(CAMPAIGN_ID, "admin_cancelled");

    expect(m.communityBuyPaymentAuthorisation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ captureStatus: { in: ["NOT_CAPTURED", "CAPTURE_FAILED"] } }) }),
    );
    expect(s.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });

  it("still releases a genuinely uncaptured HOLD_SUCCEEDED hold", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "hold-uncaptured", holdStatus: "HOLD_SUCCEEDED", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_1", supplierConnectedAccountId: "acct_1", contributionId: "contrib-1" },
    ] as any);
    m.communityBuyPaymentAuthorisation.findUniqueOrThrow.mockResolvedValue({ id: "hold-uncaptured", holdStatus: "HOLD_SUCCEEDED", captureStatus: "NOT_CAPTURED", paymentIntentId: "pi_1", supplierConnectedAccountId: "acct_1", contributionId: "contrib-1" } as any);
    m.communityBuyPaymentAuthorisation.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignContribution.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignContribution.findUniqueOrThrow.mockResolvedValue({ id: "contrib-1", participant: { userId: "participant-1" } } as any);

    await campaignAuthorisationService.releaseAllHoldsForCampaign(CAMPAIGN_ID, "admin_cancelled");

    expect(s.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", undefined, { stripeAccount: "acct_1" });
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "participant-1" }));
  });
});

describe("listExpiringHolds() — M8 admin queue visibility (Appendix A 'capture expiry' screen)", () => {
  it("lists only HOLD_EXPIRING, uncaptured holds, soonest-expiring first", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([{ id: "hold-1", holdStatus: "HOLD_EXPIRING" }] as any);

    const result = await campaignAuthorisationService.listExpiringHolds();

    expect(result).toEqual([{ id: "hold-1", holdStatus: "HOLD_EXPIRING" }]);
    expect(m.communityBuyPaymentAuthorisation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { holdStatus: "HOLD_EXPIRING", captureStatus: "NOT_CAPTURED" } }),
    );
  });
});
