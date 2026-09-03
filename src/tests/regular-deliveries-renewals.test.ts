import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    buyerSubscription: { findMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    renewal: {
      create: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(),
    },
    renewalItem: { findMany: vi.fn(), update: vi.fn() },
    priceChangeRequest: { create: vi.fn(), update: vi.fn() },
    subscriptionPaymentAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn() },
    vendor: { findUnique: vi.fn() },
    deliveryZone: { findFirst: vi.fn() },
    order: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { paymentIntents: { create: vi.fn() } },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

vi.mock("../modules/automation/automation.service", () => ({
  automationService: { scheduleAutomation: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { automationService } from "../modules/automation/automation.service";
import { notificationsService } from "../modules/notifications/notifications.service";
import { renewalsService } from "../modules/regular-deliveries/renewals.service";

const m = vi.mocked(prisma, true);
const mCreateIntent = vi.mocked(stripe.paymentIntents.create);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renewalsService.createRenewalForCycle — offer discount (spec §22)", () => {
  it("applies the offer's discount percentage to the renewal's charged price", async () => {
    m.buyerSubscription.findUniqueOrThrow.mockResolvedValue({
      id: "sub-3",
      offer: { discountPercent: 10, products: [] },
      items: [{ productId: "p1", quantity: 2, product: { currency: "GBP", priceInCents: 1000, isActive: true, stock: 5 } }],
    } as never);
    m.renewalItem.findMany.mockResolvedValue([] as never);
    m.renewal.create.mockImplementation(async (args: any) => ({ id: "renewal-discounted", ...args.data, items: args.data.items.create }));
    m.renewal.update.mockResolvedValue({} as never);

    const renewal = await renewalsService.createRenewalForCycle("sub-3", new Date("2026-07-01T00:00:00.000Z"));

    // 1000 * (1 - 10/100) = 900
    expect(renewal.items[0].currentUnitPrice).toBe(900);
    expect(renewal.items[0].previousUnitPrice).toBe(900); // first renewal — no prior cycle, so previous == current
  });

  it("charges the plain product price when the offer has no discount", async () => {
    m.buyerSubscription.findUniqueOrThrow.mockResolvedValue({
      id: "sub-4",
      offer: { discountPercent: null, products: [] },
      items: [{ productId: "p1", quantity: 1, product: { currency: "GBP", priceInCents: 750, isActive: true, stock: 5 } }],
    } as never);
    m.renewalItem.findMany.mockResolvedValue([] as never);
    m.renewal.create.mockImplementation(async (args: any) => ({ id: "renewal-plain", ...args.data, items: args.data.items.create }));
    m.renewal.update.mockResolvedValue({} as never);

    const renewal = await renewalsService.createRenewalForCycle("sub-4", new Date("2026-07-01T00:00:00.000Z"));

    expect(renewal.items[0].currentUnitPrice).toBe(750);
  });

  it("applies the same discount consistently across cycles so it never triggers the price-approval gate on its own", async () => {
    m.buyerSubscription.findUniqueOrThrow.mockResolvedValue({
      id: "sub-5",
      offer: { discountPercent: 20, products: [] },
      items: [{ productId: "p1", quantity: 1, product: { currency: "GBP", priceInCents: 1000, isActive: true, stock: 5 } }],
    } as never);
    // A prior renewal already charged the discounted price (800) — the
    // product's own list price hasn't changed since.
    m.renewalItem.findMany.mockResolvedValue([{ productId: "p1", currentUnitPrice: 800, createdAt: new Date() }] as never);
    m.renewal.create.mockImplementation(async (args: any) => ({ id: "renewal-stable", ...args.data, items: args.data.items.create }));
    m.renewal.update.mockResolvedValue({} as never);

    const renewal = await renewalsService.createRenewalForCycle("sub-5", new Date("2026-08-01T00:00:00.000Z"));

    expect(renewal.items[0].previousUnitPrice).toBe(800);
    expect(renewal.items[0].currentUnitPrice).toBe(800); // 1000 * 0.8 — unchanged from last cycle
  });
});

describe("renewalsService.createRenewalForCycle — per-product pause (spec §31)", () => {
  it("drops a vendor-paused product from the renewal but keeps the subscriber's other items", async () => {
    m.buyerSubscription.findUniqueOrThrow.mockResolvedValue({
      id: "sub-6",
      frequency: "WEEKLY",
      offer: {
        discountPercent: null,
        products: [{ productId: "p1", pausedAt: new Date("2026-06-01") }, { productId: "p2", pausedAt: null }],
      },
      items: [
        { productId: "p1", quantity: 1, product: { currency: "GBP", priceInCents: 500, isActive: true, stock: 5 } },
        { productId: "p2", quantity: 1, product: { currency: "GBP", priceInCents: 300, isActive: true, stock: 5 } },
      ],
    } as never);
    m.renewalItem.findMany.mockResolvedValue([] as never);
    m.renewal.create.mockImplementation(async (args: any) => ({ id: "renewal-partial", ...args.data, items: args.data.items.create }));
    m.renewal.update.mockResolvedValue({} as never);

    const renewal = await renewalsService.createRenewalForCycle("sub-6", new Date("2026-07-01T00:00:00.000Z"));

    expect(renewal!.items).toHaveLength(1);
    expect(renewal!.items[0].productId).toBe("p2");
  });

  it("creates no renewal and advances nextRenewalAt when every item is vendor-paused", async () => {
    m.buyerSubscription.findUniqueOrThrow.mockResolvedValue({
      id: "sub-7",
      frequency: "WEEKLY",
      offer: { discountPercent: null, products: [{ productId: "p1", pausedAt: new Date("2026-06-01") }] },
      items: [{ productId: "p1", quantity: 1, product: { currency: "GBP", priceInCents: 500, isActive: true, stock: 5 } }],
    } as never);
    m.buyerSubscription.update.mockResolvedValue({} as never);

    const renewal = await renewalsService.createRenewalForCycle("sub-7", new Date("2026-07-01T00:00:00.000Z"));

    expect(renewal).toBeNull();
    expect(m.renewal.create).not.toHaveBeenCalled();
    expect(m.buyerSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sub-7" }, data: expect.objectContaining({ nextRenewalAt: expect.any(Date) }) }),
    );
  });
});

describe("renewalsService.evaluatePriceChange", () => {
  it("auto-approves a price change within the buyer's limit", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue({
      id: "renewal-1",
      subscription: { priceChangeApprovalLimitBps: 500, buyerId: "buyer-1" },
      items: [{ id: "i1", previousUnitPrice: 1000, currentUnitPrice: 1020 }], // +2%
    } as never);

    await renewalsService.evaluatePriceChange("renewal-1");

    expect(m.priceChangeRequest.create).not.toHaveBeenCalled();
    expect(m.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "renewal-1" }, data: { status: "READY_FOR_PAYMENT" } }),
    );
  });

  it("requires approval for a material price increase above the limit", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue({
      id: "renewal-2",
      subscription: { priceChangeApprovalLimitBps: 500, buyerId: "buyer-1" },
      items: [{ id: "i1", previousUnitPrice: 1000, currentUnitPrice: 1200 }], // +20%
    } as never);
    m.priceChangeRequest.create.mockResolvedValue({ id: "pcr-1" } as never);

    await renewalsService.evaluatePriceChange("renewal-2");

    expect(m.priceChangeRequest.create).toHaveBeenCalled();
    expect(m.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "renewal-2" },
        data: expect.objectContaining({ status: "AWAITING_PRICE_APPROVAL", priceChangeRequestId: "pcr-1" }),
      }),
    );
    expect(automationService.scheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PRICE_APPROVAL_REMINDER" }),
    );
  });
});

describe("renewalsService.buyerDecidePriceChange", () => {
  it("moves the renewal to READY_FOR_PAYMENT when the buyer accepts", async () => {
    m.renewal.findUnique.mockResolvedValueOnce({
      id: "renewal-3",
      status: "AWAITING_PRICE_APPROVAL",
      priceChangeRequestId: "pcr-2",
      subscription: { buyerId: "buyer-1" },
    } as never);
    m.renewal.findUnique.mockResolvedValueOnce({ id: "renewal-3", status: "READY_FOR_PAYMENT" } as never);

    const result = await renewalsService.buyerDecidePriceChange("buyer-1", "renewal-3", "accepted");

    expect(m.priceChangeRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pcr-2" }, data: expect.objectContaining({ buyerDecision: "accepted" }) }),
    );
    expect(m.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "renewal-3" }, data: { status: "READY_FOR_PAYMENT" } }),
    );
    expect(result?.status).toBe("READY_FOR_PAYMENT");
  });

  it("skips the renewal and advances the next cycle when the buyer declines", async () => {
    m.renewal.findUnique.mockResolvedValueOnce({
      id: "renewal-4",
      status: "AWAITING_PRICE_APPROVAL",
      priceChangeRequestId: "pcr-3",
      cycleDate: new Date("2026-06-01T00:00:00.000Z"),
      subscriptionId: "sub-1",
      subscription: { buyerId: "buyer-1", frequency: "WEEKLY" },
    } as never);
    m.renewal.findUnique.mockResolvedValueOnce({ id: "renewal-4", status: "SKIPPED" } as never);

    await renewalsService.buyerDecidePriceChange("buyer-1", "renewal-4", "declined");

    expect(m.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "renewal-4" }, data: { status: "SKIPPED" } }),
    );
    expect(m.buyerSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sub-1" } }),
    );
  });

  it("rejects a decision on a renewal that belongs to a different buyer", async () => {
    m.renewal.findUnique.mockResolvedValueOnce({
      id: "renewal-5",
      status: "AWAITING_PRICE_APPROVAL",
      subscription: { buyerId: "someone-else" },
    } as never);

    await expect(renewalsService.buyerDecidePriceChange("buyer-1", "renewal-5", "accepted")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("renewalsService.attemptPayment", () => {
  const baseRenewal = {
    id: "renewal-6",
    status: "READY_FOR_PAYMENT",
    subscriptionId: "sub-1",
    currency: "GBP",
    items: [{ currentUnitPrice: 1500, quantity: 2 }],
    subscription: {
      buyerId: "buyer-1",
      frequency: "WEEKLY",
      paymentMethod: { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" },
    },
  };

  it("charges off-session with an idempotency key derived from renewalId + attempt number, then hands off to order conversion", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue(baseRenewal as never);
    m.subscriptionPaymentAttempt.count.mockResolvedValue(0);
    m.subscriptionPaymentAttempt.create.mockResolvedValue({ id: "attempt-1" } as never);
    mCreateIntent.mockResolvedValue({ id: "pi_1", status: "succeeded" } as never);
    // Order conversion is a large, separate transaction covered by its own
    // tests — isolate attemptPayment's own responsibility (idempotent
    // charge + correct branching) by stubbing the handoff.
    const convertSpy = vi.spyOn(renewalsService, "convertPaidRenewalToOrder").mockResolvedValue({ id: "order-1" } as never);

    await renewalsService.attemptPayment("renewal-6");

    expect(m.subscriptionPaymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attemptNumber: 1, idempotencyKey: "renewal-6:1" }) }),
    );
    expect(mCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ off_session: true, confirm: true, customer: "cus_1", payment_method: "pm_1" }),
      { idempotencyKey: "renewal-6:1" },
    );
    expect(m.subscriptionPaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "attempt-1" }, data: expect.objectContaining({ status: "SUCCEEDED", stripePaymentIntentId: "pi_1" }) }),
    );
    expect(convertSpy).toHaveBeenCalledWith("renewal-6", "pi_1");
    convertSpy.mockRestore();
  });

  it("marks the attempt and renewal FAILED, and triggers payment recovery, when Stripe declines", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue(baseRenewal as never);
    m.subscriptionPaymentAttempt.count.mockResolvedValue(1); // this will be attempt #2
    m.subscriptionPaymentAttempt.create.mockResolvedValue({ id: "attempt-2" } as never);
    mCreateIntent.mockRejectedValue(Object.assign(new Error("Your card was declined"), { code: "card_declined" }));
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "buyer-1" } as never);
    m.renewal.findUnique.mockResolvedValue({ id: "renewal-6", status: "PAYMENT_FAILED" } as never);

    await renewalsService.attemptPayment("renewal-6");

    expect(m.subscriptionPaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "attempt-2" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
    expect(m.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "renewal-6" }, data: expect.objectContaining({ status: "PAYMENT_FAILED" }) }),
    );
    expect(m.buyerSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sub-1" }, data: { status: "PAYMENT_ATTENTION" } }),
    );
    expect(automationService.scheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PAYMENT_RECOVERY" }),
    );
  });

  it("cancels the renewal instead of charging once the retry limit is reached", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue({ ...baseRenewal, status: "PAYMENT_FAILED" } as never);
    m.subscriptionPaymentAttempt.count.mockResolvedValue(3); // MAX_PAYMENT_ATTEMPTS already used
    m.renewal.update.mockResolvedValue({ id: "renewal-6", subscriptionId: "sub-1" } as never);
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "buyer-1" } as never);

    await renewalsService.attemptPayment("renewal-6");

    expect(mCreateIntent).not.toHaveBeenCalled();
    expect(m.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "renewal-6" }, data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });

  it("fails the attempt instead of charging when the renewal currency isn't Stripe-supported, rather than silently charging EUR for the same numeric amount", async () => {
    // GHS is not in Stripe's supported currency list — resolveStripeCurrency()
    // would otherwise fall back to "eur" while keeping the same integer
    // amount. This runs unattended from the cron sweep, so it must fail the
    // same way a real card decline does, never submit a mismatched charge.
    m.renewal.findUniqueOrThrow.mockResolvedValue({ ...baseRenewal, currency: "GHS" } as never);
    m.subscriptionPaymentAttempt.count.mockResolvedValue(0);
    m.subscriptionPaymentAttempt.create.mockResolvedValue({ id: "attempt-ghs" } as never);
    m.buyerSubscription.update.mockResolvedValue({ buyerId: "buyer-1" } as never);
    m.renewal.findUnique.mockResolvedValue({ id: "renewal-6", status: "PAYMENT_FAILED" } as never);

    await renewalsService.attemptPayment("renewal-6");

    expect(mCreateIntent).not.toHaveBeenCalled();
    expect(m.subscriptionPaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "attempt-ghs" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
    expect(m.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "renewal-6" }, data: expect.objectContaining({ status: "PAYMENT_FAILED" }) }),
    );
  });

  it("rejects a payment attempt when the renewal has no saved payment method", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue({
      ...baseRenewal,
      subscription: { ...baseRenewal.subscription, paymentMethod: null },
    } as never);
    m.subscriptionPaymentAttempt.count.mockResolvedValue(0);

    await expect(renewalsService.attemptPayment("renewal-6")).rejects.toMatchObject({ statusCode: 409 });
    expect(mCreateIntent).not.toHaveBeenCalled();
  });
});

describe("renewalsService.convertPaidRenewalToOrder", () => {
  const paidRenewal = {
    id: "renewal-7",
    status: "PAYMENT_PROCESSING",
    orderId: null,
    currency: "GBP",
    cycleDate: new Date("2026-06-01T00:00:00.000Z"),
    subscriptionId: "sub-1",
    items: [
      { productId: "p1", quantity: 2, currentUnitPrice: 1000, currency: "GBP", product: { title: "Rice", weightGrams: 500 } },
    ],
    subscription: {
      buyerId: "buyer-1",
      frequency: "WEEKLY",
      deliveryAddress: { line1: "1 Road", city: "London", country: "United Kingdom" },
      offer: { vendorId: "vendor-1" },
    },
  };

  function fakeTx() {
    return {
      product: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      order: { create: vi.fn().mockResolvedValue({ id: "order-1", orderNumber: "EKI-100" }) },
      wallet: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "wallet-1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      renewal: { update: vi.fn().mockResolvedValue({}) },
      buyerSubscription: { update: vi.fn().mockResolvedValue({}) },
    };
  }

  it("creates a real Order + Payment and credits the vendor wallet, exactly once", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue(paidRenewal as never);
    m.deliveryZone.findFirst.mockResolvedValue({ id: "zone-1", baseFeeAmount: 500, feePerKgAmount: 100 } as never);
    m.vendor.findUnique.mockResolvedValue({ userId: "vendor-user-1" } as never);
    const tx = fakeTx();
    m.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const order = await renewalsService.convertPaidRenewalToOrder("renewal-7", "pi_paid");

    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(tx.order.create.mock.calls[0][0].data.payment.create.stripePaymentIntentId).toBe("pi_paid");
    expect(tx.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(tx.renewal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "renewal-7" }, data: { status: "ORDER_CREATED", orderId: "order-1" } }),
    );
    expect((order as any).id).toBe("order-1");
  });

  it("is idempotent — a renewal already converted is not converted again", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue({
      ...paidRenewal,
      status: "ORDER_CREATED",
      orderId: "order-1",
    } as never);
    m.order.findUnique.mockResolvedValue({ id: "order-1" } as never);

    const order = await renewalsService.convertPaidRenewalToOrder("renewal-7", "pi_paid");

    expect(m.$transaction).not.toHaveBeenCalled();
    expect((order as any).id).toBe("order-1");
  });
});

describe("renewalsService.generateDueRenewals", () => {
  it("treats a unique-constraint violation as an already-created renewal, not an error", async () => {
    m.buyerSubscription.findMany.mockResolvedValue([
      { id: "sub-1", nextRenewalAt: new Date("2026-06-01T00:00:00.000Z"), offer: { renewalsPaused: false } },
    ] as never);
    m.buyerSubscription.findUniqueOrThrow.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));

    const result = await renewalsService.generateDueRenewals();

    expect(result).toEqual({ created: 0, skipped: 1 });
  });

  it("skips a subscription whose offer has paused renewals, without touching nextRenewalAt", async () => {
    m.buyerSubscription.findMany.mockResolvedValue([
      { id: "sub-paused", nextRenewalAt: new Date("2026-06-01T00:00:00.000Z"), offer: { renewalsPaused: true } },
    ] as never);

    const result = await renewalsService.generateDueRenewals();

    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(m.buyerSubscription.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(m.buyerSubscription.update).not.toHaveBeenCalled();
  });

  it("sendUpcomingRenewalReminders notifies buyers whose renewal is due within 3 days, with a per-cycle dedupe key", async () => {
    const nextRenewalAt = new Date("2026-06-16T00:00:00.000Z");
    m.buyerSubscription.findMany.mockResolvedValue([
      { id: "sub-r1", buyerId: "buyer-9", nextRenewalAt, offer: { title: "Weekly Box", vendor: { storeName: "Green Grocer" } } },
    ] as never);

    const count = await renewalsService.sendUpcomingRenewalReminders();

    expect(count).toBe(1);
    expect(notificationsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "buyer-9", type: "SUBSCRIPTION_UPDATE" }),
    );
    expect(automationService.scheduleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "RENEWAL_REMINDER",
        recipientUserId: "buyer-9",
        subjectKey: "sub-r1:2026-06-16",
        requiresMarketingConsent: false,
      }),
    );
  });

  it("sendUpcomingRenewalReminders returns 0 without notifying when no subscription is due soon", async () => {
    m.buyerSubscription.findMany.mockResolvedValue([] as never);

    const count = await renewalsService.sendUpcomingRenewalReminders();

    expect(count).toBe(0);
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
    expect(automationService.scheduleAutomation).not.toHaveBeenCalled();
  });

  it("processes a subscription normally when its offer's renewals are not paused", async () => {
    m.buyerSubscription.findMany.mockResolvedValue([
      { id: "sub-2", nextRenewalAt: new Date("2026-06-01T00:00:00.000Z"), offer: { renewalsPaused: false } },
    ] as never);
    m.buyerSubscription.findUniqueOrThrow.mockResolvedValue({
      id: "sub-2",
      offer: { discountPercent: null, products: [] },
      items: [{ productId: "p1", quantity: 1, product: { currency: "GBP", priceInCents: 500, isActive: true, stock: 10 } }],
    } as never);
    m.renewalItem.findMany.mockResolvedValue([] as never);
    m.renewal.create.mockResolvedValue({ id: "renewal-x", items: [] } as never);
    m.renewal.update.mockResolvedValue({} as never);

    const result = await renewalsService.generateDueRenewals();

    expect(result).toEqual({ created: 1, skipped: 0 });
  });
});
