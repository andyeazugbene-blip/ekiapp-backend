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
import { notificationsService } from "../modules/notifications/notifications.service";
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
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "buyer-1", offer: { vendorId: "vendor-1" } } as never);

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

/**
 * Regular Delivery Admin Escalation — approved client requirement.
 * Route-level authorization ("unauthorized admin role → 403") is not
 * re-tested here: adminEscalateRenewal is gated by the identical
 * requireAdminPermission("orders.mutate") every other RD admin route uses,
 * and admin-roles-permissions.test.ts already proves assertPermission
 * rejects an unassigned admin for exactly this permission string with 403.
 * These tests cover what's new — the service logic itself.
 */
describe("renewalsService.adminEscalate — Regular Delivery Admin Escalation", () => {
  const escalatableRenewal = {
    id: "renewal-9",
    status: "PAYMENT_FAILED",
    escalated: false,
  };

  it("requires a non-empty reason", async () => {
    await expect(renewalsService.adminEscalate("admin-1", "renewal-9", "")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.renewal.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only reason", async () => {
    await expect(renewalsService.adminEscalate("admin-1", "renewal-9", "   ")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a non-existent renewal", async () => {
    m.renewal.findUnique.mockResolvedValue(null as never);
    await expect(renewalsService.adminEscalate("admin-1", "missing", "stuck for a week")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects escalation of a renewal not in an escalatable state (e.g. already PAID)", async () => {
    m.renewal.findUnique.mockResolvedValue({ ...escalatableRenewal, status: "PAID" } as never);
    await expect(renewalsService.adminEscalate("admin-1", "renewal-9", "reason")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.renewal.updateMany).not.toHaveBeenCalled();
  });

  it.each(["AWAITING_PRICE_APPROVAL", "PAYMENT_FAILED", "AWAITING_STOCK"])(
    "escalates a renewal in the %s exception state, sets actor/reason/timestamp, and records one audit entry",
    async (status) => {
      m.renewal.findUnique.mockResolvedValue({ ...escalatableRenewal, status } as never);
      m.renewal.updateMany.mockResolvedValue({ count: 1 } as never);
      m.renewal.findUniqueOrThrow.mockResolvedValue({ ...escalatableRenewal, status, escalated: true } as never);

      const result = await renewalsService.adminEscalate("admin-1", "renewal-9", "Buyer has called 3 times, needs supervisor review");

      expect(m.renewal.updateMany).toHaveBeenCalledWith({
        where: { id: "renewal-9", escalated: false },
        data: expect.objectContaining({
          escalated: true,
          escalatedById: "admin-1",
          escalatedReason: "Buyer has called 3 times, needs supervisor review",
        }),
      });
      expect((result as any).escalated).toBe(true);
      expect(mockRecordAudit).toHaveBeenCalledTimes(1);
      expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
        actorId: "admin-1",
        action: "renewal.admin_escalate",
        entityType: "Renewal",
        entityId: "renewal-9",
        beforeState: { status, escalated: false },
        afterState: expect.objectContaining({ escalated: true, reason: "Buyer has called 3 times, needs supervisor review" }),
      }));
    },
  );

  it("does not send any buyer notification — escalation is an internal admin action, distinct from the separate contact-buyer action", async () => {
    m.renewal.findUnique.mockResolvedValue(escalatableRenewal as never);
    m.renewal.updateMany.mockResolvedValue({ count: 1 } as never);
    m.renewal.findUniqueOrThrow.mockResolvedValue({ ...escalatableRenewal, escalated: true } as never);

    await renewalsService.adminEscalate("admin-1", "renewal-9", "reason");

    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });

  it("is idempotent — a reload/re-click on an already-escalated renewal returns the same state without a duplicate audit entry", async () => {
    m.renewal.findUnique.mockResolvedValue({ ...escalatableRenewal, escalated: true } as never);
    // Atomic claim loses the race because escalated is already true.
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never);
    m.renewal.findUniqueOrThrow.mockResolvedValue({ ...escalatableRenewal, escalated: true, escalatedById: "admin-1", escalatedReason: "original reason" } as never);

    const result = await renewalsService.adminEscalate("admin-2", "renewal-9", "a different admin trying again");

    expect((result as any).escalated).toBe(true);
    expect((result as any).escalatedReason).toBe("original reason");
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("concurrent escalation requests resolve to a single winner — only one audit entry is ever created", async () => {
    m.renewal.findUnique.mockResolvedValue(escalatableRenewal as never);
    // First caller wins the atomic claim, second loses.
    m.renewal.updateMany.mockResolvedValueOnce({ count: 1 } as never).mockResolvedValueOnce({ count: 0 } as never);
    m.renewal.findUniqueOrThrow.mockResolvedValue({ ...escalatableRenewal, escalated: true } as never);

    await Promise.all([
      renewalsService.adminEscalate("admin-1", "renewal-9", "first"),
      renewalsService.adminEscalate("admin-2", "renewal-9", "second"),
    ]);

    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });
});
