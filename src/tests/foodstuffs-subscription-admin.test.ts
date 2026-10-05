import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    buyerSubscription: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    renewal: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    renewalItem: { findMany: vi.fn() },
    subscriptionPaymentAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn() },
    subscriptionActionHistory: { create: vi.fn() },
    adminPlatformSetting: { findUnique: vi.fn() },
    notification: { findUnique: vi.fn() },
    auditLog: { findMany: vi.fn() },
    refund: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() } } }));
vi.mock("../modules/admin/admin-platform-settings.service", () => ({
  adminPlatformSettingsService: { getValue: vi.fn().mockResolvedValue(null) },
}));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { scheduleAutomation: vi.fn() } }));
const mockRecordAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("../shared/utils/audit", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { notificationsService } from "../modules/notifications/notifications.service";
import { renewalsService, nextRetryDate, PAYMENT_RETRY_DELAY_DAYS } from "../modules/regular-deliveries/renewals.service";
import { subscriptionAdminService, requireReason } from "../modules/regular-deliveries/subscription-admin.service";
import { buyerSubscriptionsService, subscriptionLifecycle } from "../modules/regular-deliveries/buyer-subscriptions.service";

const m = vi.mocked(prisma, true);
const DAY = 24 * 60 * 60 * 1000;
const enqueue = vi.mocked(notificationsService.enqueue);

beforeEach(() => {
  vi.clearAllMocks();
  m.subscriptionActionHistory.create.mockResolvedValue({} as never);
});

describe("payment recovery schedule (B23)", () => {
  it("retries at +1d, +3d and closes the grace window at +5d (cumulative)", () => {
    const t0 = new Date("2026-10-01T00:00:00Z");
    const d1 = nextRetryDate(1, t0).getTime() - t0.getTime();
    expect(d1).toBe(1 * DAY);
    expect(d1 + PAYMENT_RETRY_DELAY_DAYS[1] * DAY).toBe(3 * DAY);
    expect(d1 + (PAYMENT_RETRY_DELAY_DAYS[1] + PAYMENT_RETRY_DELAY_DAYS[2]) * DAY).toBe(5 * DAY);
    // out-of-range attempts clamp instead of producing an invalid date
    expect(nextRetryDate(0, t0).getTime() - t0.getTime()).toBe(1 * DAY);
    expect(nextRetryDate(9, t0).getTime() - t0.getTime()).toBe(2 * DAY);
  });

  it("handlePaymentFailure stores nextRetryAt and tells the buyer when we retry", async () => {
    m.subscriptionPaymentAttempt.count.mockResolvedValue(1);
    m.renewal.update.mockResolvedValue({} as never);
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "b1", offer: { vendorId: "v1" } } as never);
    m.renewal.findUnique.mockResolvedValue({ id: "r1" } as never);

    await renewalsService.handlePaymentFailure("s1", "r1", "card_declined");

    const data = (m.renewal.update.mock.calls[0][0] as any).data;
    expect(data.status).toBe("PAYMENT_FAILED");
    expect(data.nextRetryAt.getTime() - Date.now()).toBeGreaterThan(DAY - 5000);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "b1", data: expect.objectContaining({ event: "payment_failed", cta: "update_payment_method" }) }));
  });

  it("the 3rd failed attempt sends the 'last chance' copy", async () => {
    m.subscriptionPaymentAttempt.count.mockResolvedValue(3);
    m.renewal.update.mockResolvedValue({} as never);
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "b1", offer: { vendorId: "v1" } } as never);
    m.renewal.findUnique.mockResolvedValue({ id: "r1" } as never);
    await renewalsService.handlePaymentFailure("s1", "r1", "card_declined");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ title: "Last chance: update your payment method" }));
  });

  it("sweep retries due PAYMENT_FAILED renewals with attempts left through attemptPayment (never a second charge path)", async () => {
    m.renewal.findMany.mockResolvedValue([{ id: "r1" }] as never);
    m.subscriptionPaymentAttempt.count.mockResolvedValue(1);
    const attempt = vi.spyOn(renewalsService, "attemptPayment").mockResolvedValue({} as never);

    const result = await renewalsService.retryDueFailedPayments();

    expect(result).toEqual({ retried: 1, finalised: 0 });
    expect(attempt).toHaveBeenCalledWith("r1");
    const where = (m.renewal.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toBe("PAYMENT_FAILED");
    expect(where.nextRetryAt.lte).toBeInstanceOf(Date);
    // paused / cancelled subscriptions are never retried
    expect(where.subscription.status.in).toEqual(["ACTIVE", "PAYMENT_ATTENTION"]);
    attempt.mockRestore();
  });

  it("sweep finalises (renewal CANCELLED + subscription PAUSED payment_failed) once attempts are exhausted instead of charging again", async () => {
    m.renewal.findMany.mockResolvedValue([{ id: "r1" }] as never);
    m.subscriptionPaymentAttempt.count.mockResolvedValue(3);
    m.renewal.updateMany.mockResolvedValue({ count: 1 } as never);
    m.renewal.findUniqueOrThrow.mockResolvedValue({ id: "r1", subscriptionId: "s1", failureReason: "declined" } as never);
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "b1" } as never);
    const attempt = vi.spyOn(renewalsService, "attemptPayment");

    const result = await renewalsService.retryDueFailedPayments();

    expect(result).toEqual({ retried: 0, finalised: 1 });
    expect(attempt).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.paymentIntents.create)).not.toHaveBeenCalled();
    expect(m.buyerSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAUSED", pausedReason: "payment_failed" }) }),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ event: "renewal_cancelled", cta: "update_payment_method" }) }));
    attempt.mockRestore();
  });

  it("finalisation is idempotent: a loser of the claim does not pause, audit or notify twice", async () => {
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never);
    expect(await renewalsService.cancelAfterRetriesExhausted("r1")).toBeNull();
    expect(m.buyerSubscription.update).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("idempotency still holds: a retry that loses the atomic payment claim never reaches Stripe", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue({
      id: "r1", status: "PAYMENT_FAILED", subscriptionId: "s1", currency: "GBP", items: [{ currentUnitPrice: 100, quantity: 1, product: { weightGrams: 0 } }],
      subscription: { status: "PAYMENT_ATTENTION", paymentMethod: { stripeCustomerId: "c", stripePaymentMethodId: "p" }, offer: { fulfilmentMethod: "COLLECTION" }, deliveryAddress: { country: "GB" } },
    } as never);
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never);
    m.renewal.findUnique.mockResolvedValue({ id: "r1" } as never);
    await renewalsService.attemptPayment("r1");
    expect(vi.mocked(stripe.paymentIntents.create)).not.toHaveBeenCalled();
    expect(m.subscriptionPaymentAttempt.create).not.toHaveBeenCalled();
  });

  it("a PAYMENT_ATTENTION subscription can be retried (previously died with a 409)", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue({
      id: "r1", status: "PAYMENT_FAILED", subscriptionId: "s1", currency: "GBP", items: [{ currentUnitPrice: 100, quantity: 1, product: { weightGrams: 0 } }],
      subscription: { status: "PAYMENT_ATTENTION", paymentMethod: null, offer: { fulfilmentMethod: "COLLECTION" }, deliveryAddress: { country: "GB" } },
    } as never);
    // reaches the payment-method check (past the status guard)
    await expect(renewalsService.attemptPayment("r1")).rejects.toMatchObject({ message: "No saved payment method on this subscription" });
  });
});

describe("AWAITING_STOCK timeout, auto-resume, price notice", () => {
  it("auto-skips a stale AWAITING_STOCK cycle after the default 72h and tells buyer (nothing charged/substituted) and vendor", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue(null);
    m.renewal.findMany.mockResolvedValue([
      {
        id: "r1", subscriptionId: "s1", cycleDate: new Date("2026-10-01"),
        subscription: { buyerId: "b1", frequency: "WEEKLY", offer: { title: "Box", vendor: { userId: "vu1", storeName: "Alpha Foods" } } },
      },
    ] as never);
    m.renewal.updateMany.mockResolvedValue({ count: 1 } as never);
    m.buyerSubscription.updateMany.mockResolvedValue({ count: 1 } as never);

    const before = Date.now();
    const result = await renewalsService.expireStockTimeouts();

    expect(result).toEqual({ configuredHours: 72, skipped: 1 });
    const cutoff: Date = (m.renewal.findMany.mock.calls[0][0] as any).where.OR[0].awaitingStockSince.lte;
    expect(Math.round((before - cutoff.getTime()) / 3_600_000)).toBe(72);
    const buyerCall = enqueue.mock.calls.find((c) => c[0].userId === "b1")![0];
    expect(buyerCall.body).toMatch(/not been charged and nothing was substituted/);
    expect(enqueue.mock.calls.some((c) => c[0].userId === "vu1")).toBe(true);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "renewal.stock_timeout_skipped" }));
  });

  it("honours the admin-configured AWAITING_STOCK_TIMEOUT_HOURS and does nothing when it loses the claim", async () => {
    m.adminPlatformSetting.findUnique.mockResolvedValue({ key: "AWAITING_STOCK_TIMEOUT_HOURS", value: 24 } as never);
    m.renewal.findMany.mockResolvedValue([{ id: "r1", subscriptionId: "s1", cycleDate: new Date(), subscription: { buyerId: "b1", frequency: "WEEKLY", offer: { title: "x", vendor: { userId: "v", storeName: "S" } } } }] as never);
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never);
    const result = await renewalsService.expireStockTimeouts();
    expect(result).toEqual({ configuredHours: 24, skipped: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("auto-resumes subscriptions whose pausedUntil passed, but never payment_failed pauses", async () => {
    m.buyerSubscription.findMany.mockResolvedValue([{ id: "s1", buyerId: "b1", nextRenewalAt: null }] as never);
    m.buyerSubscription.updateMany.mockResolvedValue({ count: 1 } as never);
    expect(await renewalsService.resumePausedDue()).toBe(1);
    const where = (m.buyerSubscription.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toBe("PAUSED");
    expect(where.OR).toEqual([{ pausedReason: null }, { pausedReason: { not: "payment_failed" } }]);
    expect(m.subscriptionActionHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "auto_resumed" }) }));
  });

  it("sends an advance price notice only for increases, once per cycle (dedupe key)", async () => {
    m.buyerSubscription.findMany.mockResolvedValue([
      {
        id: "s1", buyerId: "b1", nextRenewalAt: new Date(Date.now() + 20 * 3600 * 1000), priceChangeApprovalLimitBps: 500,
        items: [{ productId: "p1", quantity: 1, product: { title: "Rice", priceInCents: 1200, currency: "GBP" } }],
        offer: { discountPercent: null, title: "Box", vendor: { storeName: "Alpha" } },
      },
    ] as never);
    m.renewalItem.findMany.mockResolvedValue([{ productId: "p1", currentUnitPrice: 1000 }] as never);
    m.notification.findUnique.mockResolvedValue(null);

    expect(await renewalsService.sendPriceChangeNotices()).toBe(1);
    const call = enqueue.mock.calls[0][0];
    expect(call.dedupeKey).toMatch(/^PRICE_NOTICE:s1:/);
    expect(call.body).toMatch(/asked to approve/); // +20% > 5% limit

    enqueue.mockClear();
    m.notification.findUnique.mockResolvedValue({ id: "n" } as never); // already sent
    expect(await renewalsService.sendPriceChangeNotices()).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("admin actions require a reason, write an audit row and notify the buyer", () => {
  const activeSub = { id: "s1", buyerId: "b1", status: "ACTIVE", frequency: "WEEKLY", nextRenewalAt: new Date(Date.now() + 3 * DAY), pausedUntil: null, pausedReason: null, paymentMethodId: "pm1" };

  it("requireReason rejects short/missing reasons", () => {
    expect(() => requireReason(undefined)).toThrow(/at least 5/);
    expect(() => requireReason("no")).toThrow(/at least 5/);
    expect(requireReason("  buyer asked us  ")).toBe("buyer asked us");
  });

  for (const [name, call] of [
    ["pause", (r: unknown) => subscriptionAdminService.pause("admin1", "s1", r, undefined)],
    ["resume", (r: unknown) => subscriptionAdminService.resume("admin1", "s1", r)],
    ["skipNext", (r: unknown) => subscriptionAdminService.skipNext("admin1", "s1", r)],
    ["setNextDate", (r: unknown) => subscriptionAdminService.setNextDate("admin1", "s1", new Date(Date.now() + 5 * DAY).toISOString(), r)],
    ["changeFrequency", (r: unknown) => subscriptionAdminService.changeFrequency("admin1", "s1", "MONTHLY", r)],
    ["retryPayment", (r: unknown) => subscriptionAdminService.retryPayment("admin1", "s1", r)],
  ] as const) {
    it(`${name} refuses to run without a reason and changes nothing`, async () => {
      await expect(call("")).rejects.toMatchObject({ statusCode: 400 });
      expect(m.buyerSubscription.update).not.toHaveBeenCalled();
      expect(mockRecordAudit).not.toHaveBeenCalled();
    });
  }

  it("pause cancels not-yet-charged renewals (incl. READY_FOR_PAYMENT), audits with reason and notifies the buyer", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(activeSub as never);
    m.renewal.updateMany.mockResolvedValue({ count: 1 } as never);
    m.buyerSubscription.update.mockResolvedValue({ ...activeSub, status: "PAUSED", pausedReason: "admin" } as never);

    await subscriptionAdminService.pause("admin1", "s1", "buyer is travelling", undefined);

    const cancelled = (m.renewal.updateMany.mock.calls[0][0] as any).where.status.in;
    expect(cancelled).toContain("READY_FOR_PAYMENT");
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "admin1", action: "subscription.admin_pause", entityId: "s1", reason: "buyer is travelling",
      beforeState: expect.objectContaining({ status: "ACTIVE" }), afterState: expect.objectContaining({ status: "PAUSED" }),
    }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "b1", title: "Your Foodstuffs Subscription was paused" }));
  });

  it("resume after a payment-failure pause starts a fresh cycle right away and needs a saved card", async () => {
    const paused = { ...activeSub, status: "PAUSED", pausedReason: "payment_failed" };
    m.buyerSubscription.update.mockResolvedValue({ ...paused, status: "ACTIVE" } as never);
    await subscriptionLifecycle.resume(paused as never, "admin1", { by: "admin", reason: "card updated" });
    const data = (m.buyerSubscription.update.mock.calls[0][0] as any).data;
    expect(data).toMatchObject({ status: "ACTIVE", pausedReason: null, pausedUntil: null });
    expect(data.nextRenewalAt.getTime()).toBeLessThanOrEqual(Date.now());
    await expect(subscriptionLifecycle.resume({ ...paused, paymentMethodId: null } as never, "admin1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("set-next-date validates the date and records the change in the subscription history", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(activeSub as never);
    await expect(subscriptionAdminService.setNextDate("admin1", "s1", "not-a-date", "support request")).rejects.toMatchObject({ statusCode: 400 });
    await expect(subscriptionAdminService.setNextDate("admin1", "s1", new Date(Date.now() - DAY).toISOString(), "support request")).rejects.toMatchObject({ statusCode: 400 });

    const target = new Date(Date.now() + 6 * DAY);
    m.renewal.findFirst.mockResolvedValue(null);
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never);
    m.buyerSubscription.update.mockResolvedValue({ ...activeSub, nextRenewalAt: target } as never);
    await subscriptionAdminService.setNextDate("admin1", "s1", target.toISOString(), "support request");
    expect(m.subscriptionActionHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "admin_rescheduled" }) }));
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "subscription.admin_set_next_date", reason: "support request" }));
  });

  it("set-next-date refuses when the delivery is already being paid for", async () => {
    m.renewal.findFirst.mockResolvedValue({ id: "r1" } as never);
    await expect(subscriptionLifecycle.reschedule(activeSub as never, new Date(Date.now() + 5 * DAY), "b1", { by: "buyer" })).rejects.toMatchObject({ statusCode: 409 });
    expect(m.buyerSubscription.update).not.toHaveBeenCalled();
  });

  it("buyer cancel stores the optional cancel reason; buyer reschedule is audited in history", async () => {
    m.buyerSubscription.findUnique.mockResolvedValue(activeSub as never);
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never);
    m.buyerSubscription.update.mockResolvedValue({} as never);
    await buyerSubscriptionsService.cancel("b1", "s1", "  Too expensive  ");
    expect((m.buyerSubscription.update.mock.calls[0][0] as any).data.cancelReason).toBe("Too expensive");
    expect(m.subscriptionActionHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "cancelled", metadata: { reason: "Too expensive" } }) }));

    vi.clearAllMocks();
    m.buyerSubscription.findUnique.mockResolvedValue(activeSub as never);
    m.renewal.findFirst.mockResolvedValue(null);
    m.renewal.updateMany.mockResolvedValue({ count: 0 } as never);
    m.buyerSubscription.update.mockResolvedValue({} as never);
    await buyerSubscriptionsService.rescheduleNext("b1", "s1", new Date(Date.now() + 4 * DAY).toISOString());
    expect(m.subscriptionActionHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "rescheduled", actorUserId: "b1" }) }));
  });
});

describe("admin list filters + queue counts", () => {
  beforeEach(() => {
    m.buyerSubscription.findMany.mockResolvedValue([] as never);
    m.buyerSubscription.count.mockResolvedValue(0 as never);
  });

  it("applies queue, vendor, buyer search and renewal-date filters server-side and returns a count per queue", async () => {
    const result = await subscriptionAdminService.list({ status: "payment-failed", vendorId: "v1", q: "Ada", renewalFrom: "2026-10-01", renewalTo: "2026-10-31", limit: 10 });
    const args = m.buyerSubscription.findMany.mock.calls[0][0] as any;
    expect(args.take).toBe(11);
    const and = args.where.AND;
    expect(and).toContainEqual({ offer: { vendorId: "v1" } });
    expect(JSON.stringify(and)).toContain("\"contains\":\"Ada\"");
    expect(and.some((c: any) => c.nextRenewalAt?.gte instanceof Date && c.nextRenewalAt?.lte instanceof Date)).toBe(true);
    expect(JSON.stringify(and)).toContain("payment_failed");
    expect(Object.keys(result.counts).sort()).toEqual(["active", "all", "cancelled", "paused", "payment-failed", "renewal-due", "skip-requested", "stock-exception"]);
    expect(m.buyerSubscription.count).toHaveBeenCalledTimes(8);
  });

  it("paginates with a cursor and reports the next cursor only when more rows exist", async () => {
    const row = (id: string) => ({ id, status: "ACTIVE", frequency: "WEEKLY", nextRenewalAt: null, buyer: {}, offer: { title: "t", vendor: {} }, items: [], renewals: [], createdAt: new Date() });
    m.buyerSubscription.findMany.mockResolvedValue([row("a"), row("b"), row("c")] as never);
    const res = await subscriptionAdminService.list({ cursor: "z", limit: 2 });
    expect((m.buyerSubscription.findMany.mock.calls[0][0] as any).cursor).toEqual({ id: "z" });
    expect(res.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(res.nextCursor).toBe("b");
  });
});
