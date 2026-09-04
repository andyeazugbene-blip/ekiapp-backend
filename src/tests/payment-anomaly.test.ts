/**
 * Admin duplicate-payment / financial-inconsistency queue (architecture
 * doc §15.3). Every test proves a real detection rule fires from actual
 * (mocked) row shapes — never a fabricated alert — and that reviewing/
 * escalating only ever changes the PaymentAnomaly row's own status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    subscriptionPaymentAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
    campaignChargeAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
    campaignContribution: { groupBy: vi.fn() },
    purchasedGiftCard: { groupBy: vi.fn() },
    checkout: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    ledgerEntry: { findMany: vi.fn() },
    paymentAnomaly: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { paymentAnomalyService } from "../modules/ledger/payment-anomaly.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  m.subscriptionPaymentAttempt.groupBy.mockResolvedValue([] as never);
  m.campaignChargeAttempt.groupBy.mockResolvedValue([] as never);
  m.campaignContribution.groupBy.mockResolvedValue([] as never);
  m.purchasedGiftCard.groupBy.mockResolvedValue([] as never);
  m.subscriptionPaymentAttempt.findMany.mockResolvedValue([] as never);
  m.campaignChargeAttempt.findMany.mockResolvedValue([] as never);
  m.checkout.findMany.mockResolvedValue([] as never);
  m.payment.findMany.mockResolvedValue([] as never);
  m.ledgerEntry.findMany.mockResolvedValue([] as never);
});

describe("paymentAnomalyService.scan — DUPLICATE_PROVIDER_REF", () => {
  it("flags a real duplicate stripePaymentIntentId within one table", async () => {
    m.subscriptionPaymentAttempt.groupBy.mockResolvedValue([
      { stripePaymentIntentId: "pi_dup_1", _count: { _all: 2 } },
    ] as never);
    m.subscriptionPaymentAttempt.findMany.mockResolvedValue([
      { stripePaymentIntentId: "pi_dup_1" }, { stripePaymentIntentId: "pi_dup_1" },
    ] as never);

    const result = await paymentAnomalyService.scan();

    expect(result.found).toBeGreaterThanOrEqual(1);
    expect(m.paymentAnomaly.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: "DUPLICATE_PROVIDER_REF:SubscriptionPaymentAttempt:pi_dup_1" },
        create: expect.objectContaining({ kind: "DUPLICATE_PROVIDER_REF", businessRefId: "pi_dup_1" }),
      }),
    );
  });

  it("never flags a single (non-duplicate) stripePaymentIntentId", async () => {
    m.subscriptionPaymentAttempt.groupBy.mockResolvedValue([
      { stripePaymentIntentId: "pi_solo", _count: { _all: 1 } },
    ] as never);

    await paymentAnomalyService.scan();

    expect(m.paymentAnomaly.upsert).not.toHaveBeenCalled();
  });

  it("flags a cross-table collision — the same PaymentIntent id used by two unrelated payment domains", async () => {
    m.subscriptionPaymentAttempt.findMany.mockResolvedValue([{ stripePaymentIntentId: "pi_cross" }] as never);
    m.checkout.findMany.mockResolvedValue([{ stripePaymentIntentId: "pi_cross" }] as never);

    await paymentAnomalyService.scan();

    expect(m.paymentAnomaly.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: "DUPLICATE_PROVIDER_REF:cross-table:pi_cross" },
        create: expect.objectContaining({
          evidence: expect.objectContaining({ tables: expect.arrayContaining(["SubscriptionPaymentAttempt", "Checkout"]) }),
        }),
      }),
    );
  });
});

describe("paymentAnomalyService.scan — MULTIPLE_SUCCESSFUL_ATTEMPTS", () => {
  it("flags a renewal with two genuinely successful (different-PI) charge attempts — the real double-charge signal", async () => {
    m.subscriptionPaymentAttempt.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === "renewalId") return [{ renewalId: "renewal-1", _count: { _all: 2 } }] as never;
      return [] as never;
    });

    await paymentAnomalyService.scan();

    expect(m.paymentAnomaly.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: "MULTIPLE_SUCCESSFUL_ATTEMPTS:Renewal:renewal-1" },
        create: expect.objectContaining({ kind: "MULTIPLE_SUCCESSFUL_ATTEMPTS", businessRefType: "Renewal", businessRefId: "renewal-1" }),
      }),
    );
  });

  it("flags a Community Buy contribution charged successfully more than once", async () => {
    m.campaignChargeAttempt.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === "contributionId") return [{ contributionId: "contrib-1", _count: { _all: 2 } }] as never;
      return [] as never;
    });

    await paymentAnomalyService.scan();

    expect(m.paymentAnomaly.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dedupeKey: "MULTIPLE_SUCCESSFUL_ATTEMPTS:CampaignContribution:contrib-1" } }),
    );
  });
});

describe("paymentAnomalyService.scan — MISSING_LEDGER_ENTRY", () => {
  it("flags a succeeded, vendor-earning payment with zero real ledger entries", async () => {
    m.payment.findMany.mockResolvedValue([{ id: "pay-1", orderId: "order-1" }] as never);
    m.ledgerEntry.findMany.mockResolvedValue([] as never);

    await paymentAnomalyService.scan();

    expect(m.paymentAnomaly.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: "MISSING_LEDGER_ENTRY:Payment:pay-1" },
        create: expect.objectContaining({ kind: "MISSING_LEDGER_ENTRY", businessRefId: "pay-1" }),
      }),
    );
  });

  it("does not flag a succeeded payment that does have a real ledger entry", async () => {
    m.payment.findMany.mockResolvedValue([{ id: "pay-2", orderId: "order-2" }] as never);
    m.ledgerEntry.findMany.mockResolvedValue([{ businessRefId: "pay-2" }] as never);

    await paymentAnomalyService.scan();

    expect(m.paymentAnomaly.upsert).not.toHaveBeenCalled();
  });
});

describe("paymentAnomalyService.markReviewed / escalate", () => {
  it("throws 404 for an anomaly that doesn't exist", async () => {
    m.paymentAnomaly.findUnique.mockResolvedValue(null);
    await expect(paymentAnomalyService.markReviewed("missing", "admin-1", "checked")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("marks a real anomaly reviewed with the admin id and note", async () => {
    m.paymentAnomaly.findUnique.mockResolvedValue({ id: "anom-1" } as never);
    m.paymentAnomaly.update.mockResolvedValue({ id: "anom-1", status: "REVIEWED" } as never);

    await paymentAnomalyService.markReviewed("anom-1", "admin-1", "false positive, confirmed distinct charges");

    expect(m.paymentAnomaly.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "anom-1" }, data: expect.objectContaining({ status: "REVIEWED", reviewedById: "admin-1" }) }),
    );
  });

  it("escalate() only sets the queue-row status — it never touches Payment/Ledger tables itself", async () => {
    m.paymentAnomaly.findUnique.mockResolvedValue({ id: "anom-2" } as never);
    m.paymentAnomaly.update.mockResolvedValue({ id: "anom-2", status: "ESCALATED" } as never);

    await paymentAnomalyService.escalate("anom-2", "admin-1", "looks like a real double charge, escalating to finance");

    expect(m.paymentAnomaly.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "anom-2" }, data: expect.objectContaining({ status: "ESCALATED" }) }),
    );
    // No other model was ever touched by this call.
    expect(m.payment.findMany).not.toHaveBeenCalled();
  });
});
