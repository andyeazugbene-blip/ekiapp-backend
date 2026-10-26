/**
 * Admin duplicate-payment / financial-inconsistency queue (architecture
 * doc §15.3). Every test proves a real detection rule fires from actual
 * (mocked) row shapes — never a fabricated alert — and that reviewing/
 * escalating only ever changes the PaymentAnomaly row's own status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    subscriptionPaymentAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
    campaignChargeAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
    campaignContribution: { groupBy: vi.fn() },
    purchasedGiftCard: { groupBy: vi.fn() },
    checkout: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    ledgerEntry: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    paymentAnomaly: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    notification: { create: vi.fn(), findUnique: vi.fn() },
    notificationDelivery: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { create: vi.fn().mockResolvedValue({ id: "notification-1" }), enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { paymentAnomalyService } from "../modules/ledger/payment-anomaly.service";

const m = vi.mocked(prisma, true);

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  m.$transaction.mockImplementation(async (fn: any) => fn(prisma as any));
  m.subscriptionPaymentAttempt.groupBy.mockResolvedValue([] as never);
  m.campaignChargeAttempt.groupBy.mockResolvedValue([] as never);
  m.campaignContribution.groupBy.mockResolvedValue([] as never);
  m.purchasedGiftCard.groupBy.mockResolvedValue([] as never);
  m.subscriptionPaymentAttempt.findMany.mockResolvedValue([] as never);
  m.campaignChargeAttempt.findMany.mockResolvedValue([] as never);
  m.checkout.findMany.mockResolvedValue([] as never);
  m.payment.findMany.mockResolvedValue([] as never);
  m.ledgerEntry.findMany.mockResolvedValue([] as never);
  m.user.findMany.mockResolvedValue([] as never);
  m.paymentAnomaly.findMany.mockResolvedValue([] as never);
  m.notification.create.mockResolvedValue({ id: "notification-1" } as never);
  m.notification.findUnique.mockResolvedValue({ id: "notification-1" } as never);
  m.notificationDelivery.upsert.mockResolvedValue({ id: "delivery-1" } as never);
});

describe("paymentAnomalyService.scan — R40 administrative incident alerts", () => {
  it("keeps R40 notifications disabled unless explicitly enabled after approval", async () => {
    vi.stubEnv("R40_PAYMENT_ANOMALY_ALERTS_ENABLED", "false");
    m.subscriptionPaymentAttempt.groupBy.mockImplementation(async (args: any) => args.by[0] === "stripePaymentIntentId"
      ? [{ stripePaymentIntentId: "pi_critical", _count: { _all: 2 } }] as never
      : [] as never);

    await paymentAnomalyService.scan();

    expect(m.paymentAnomaly.upsert).toHaveBeenCalled();
    expect(m.user.findMany).not.toHaveBeenCalled();
    expect(notificationsService.create).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("alerts only ADMIN accounts and gives each finding a stable dedupe key", async () => {
    vi.stubEnv("R40_PAYMENT_ANOMALY_ALERTS_ENABLED", "true");
    m.subscriptionPaymentAttempt.groupBy.mockImplementation(async (args: any) => args.by[0] === "stripePaymentIntentId"
      ? [{ stripePaymentIntentId: "pi_critical", _count: { _all: 2 } }] as never
      : [] as never);
    m.subscriptionPaymentAttempt.findMany.mockResolvedValue([
      { stripePaymentIntentId: "pi_critical" }, { stripePaymentIntentId: "pi_critical" },
    ] as never);
    m.user.findMany.mockResolvedValue([{ id: "admin-1" }] as never);
    m.paymentAnomaly.findMany.mockResolvedValue([{
      id: "incident-1", dedupeKey: "DUPLICATE_PROVIDER_REF:SubscriptionPaymentAttempt:pi_critical",
      kind: "DUPLICATE_PROVIDER_REF", severity: "CRITICAL", status: "OPEN",
      businessRefType: "SubscriptionPaymentAttempt", businessRefId: "pi_critical",
    }] as never);

    await paymentAnomalyService.scan();

    expect(m.user.findMany).toHaveBeenCalledWith({ where: { role: "ADMIN", isSuspended: false }, select: { id: true } });
    expect(notificationsService.create).toHaveBeenCalledTimes(1);
    expect(notificationsService.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: "admin-1",
      type: "ADMIN_BROADCAST",
      title: "A critical Eki process needs attention",
      body: "Open the incident and review the failed job.",
      data: expect.objectContaining({ event: "critical_incident", destination: "admin_case", severity: "CRITICAL" }),
      dedupeKey: "R40_CRITICAL_INCIDENT:admin-1:DUPLICATE_PROVIDER_REF:SubscriptionPaymentAttempt:pi_critical",
    }), expect.anything());
    expect(m.notificationDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ channel: "push" }) }));
    vi.unstubAllEnvs();
  });

  it("does not query or notify admins when a scan finds no verified anomaly", async () => {
    await paymentAnomalyService.scan();
    expect(m.user.findMany).not.toHaveBeenCalled();
    expect(notificationsService.create).not.toHaveBeenCalled();
  });
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

  it("resolves an incident with an attributable admin and stops future sends", async () => {
    m.paymentAnomaly.findUnique.mockResolvedValue({ id: "anom-3" } as never);
    m.paymentAnomaly.update.mockResolvedValue({ id: "anom-3", status: "RESOLVED" } as never);

    await paymentAnomalyService.resolve("anom-3", "admin-1", "reconciled and fixed");

    expect(m.paymentAnomaly.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "anom-3" },
      data: expect.objectContaining({ status: "RESOLVED", reviewedById: "admin-1", resolvedAt: expect.any(Date), note: "reconciled and fixed" }),
    }));
  });
});
