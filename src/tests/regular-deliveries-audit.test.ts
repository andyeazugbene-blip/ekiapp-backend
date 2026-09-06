import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    buyerSubscription: { findMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    renewal: {
      create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(),
    },
    renewalItem: { findMany: vi.fn(), update: vi.fn() },
    priceChangeRequest: { create: vi.fn(), update: vi.fn() },
    subscriptionPaymentAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    subscriptionOffer: { findUnique: vi.fn() },
    vendor: { findUnique: vi.fn() },
    deliveryZone: { findFirst: vi.fn() },
    order: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() } } }));
vi.mock("../config/env", () => ({ env: { priceApprovalTimeoutHours: 48 as number | null } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { scheduleAutomation: vi.fn() } }));

const mockRecordAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("../shared/utils/audit", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { prisma } from "../lib/prisma";
import { renewalsService } from "../modules/regular-deliveries/renewals.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

/**
 * Regression coverage: Regular Deliveries previously had zero AuditLog
 * coverage for anything beyond buyer-initiated actions (those go to the
 * separate SubscriptionActionHistory table). These are the real,
 * business/dispute-relevant system transitions this session added
 * recordAudit() calls for.
 */
describe("renewalsService — real audit trail for material transitions", () => {
  it("handlePaymentFailure records a real audit entry with the failure reason", async () => {
    m.renewal.update.mockResolvedValue({} as never);
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "buyer-1" } as never);

    await renewalsService.handlePaymentFailure("sub-1", "renewal-1", "card_declined");

    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "system:cron",
      action: "renewal.payment_failed",
      entityType: "Renewal",
      entityId: "renewal-1",
      metadata: expect.objectContaining({ subscriptionId: "sub-1", reason: "card_declined" }),
    }));
  });

  it("cancelAfterRetriesExhausted records a real audit entry", async () => {
    m.renewal.update.mockResolvedValueOnce({ id: "renewal-2", subscriptionId: "sub-2" } as never);
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "buyer-2" } as never);

    await renewalsService.cancelAfterRetriesExhausted("renewal-2");

    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "system:cron",
      action: "renewal.cancelled_retries_exhausted",
      entityType: "Renewal",
      entityId: "renewal-2",
      metadata: expect.objectContaining({ subscriptionId: "sub-2" }),
    }));
  });

  it("expirePriceApprovalTimeouts records one real audit entry per expired renewal", async () => {
    m.renewal.findMany.mockResolvedValue([
      { id: "renewal-3", subscriptionId: "sub-3", cycleDate: new Date(), subscription: { frequency: "WEEKLY", buyerId: "buyer-3" } },
    ] as never);
    m.renewal.updateMany.mockResolvedValue({ count: 1 } as never);
    m.buyerSubscription.update.mockResolvedValue({} as never);

    const result = await renewalsService.expirePriceApprovalTimeouts();

    expect(result.expired).toBe(1);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "system:cron",
      action: "renewal.price_approval_expired",
      entityType: "Renewal",
      entityId: "renewal-3",
    }));
  });

  it("a renewal that loses the atomic expiry claim to a concurrent sweep is never double-audited", async () => {
    m.renewal.findMany.mockResolvedValue([
      { id: "renewal-4", subscriptionId: "sub-4", cycleDate: new Date(), subscription: { frequency: "WEEKLY", buyerId: "buyer-4" } },
    ] as never);
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never); // lost the race

    await renewalsService.expirePriceApprovalTimeouts();

    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("buyerDecidePriceChange records the buyer's own real decision, attributed to the buyer", async () => {
    m.renewal.findUnique.mockResolvedValue({
      id: "renewal-5",
      subscriptionId: "sub-5",
      status: "AWAITING_PRICE_APPROVAL",
      priceChangeRequestId: "pcr-1",
      subscription: { buyerId: "buyer-5", frequency: "WEEKLY", offer: { vendorId: "vendor-5" } },
      cycleDate: new Date(),
    } as never);
    m.priceChangeRequest.update.mockResolvedValue({} as never);
    m.renewal.update.mockResolvedValue({} as never);

    await renewalsService.buyerDecidePriceChange("buyer-5", "renewal-5", "accepted");

    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "buyer-5",
      action: "renewal.price_decision",
      entityType: "Renewal",
      entityId: "renewal-5",
      metadata: { decision: "accepted" },
    }));
  });
});
