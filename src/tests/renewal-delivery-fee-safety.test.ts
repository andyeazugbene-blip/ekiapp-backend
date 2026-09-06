import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    renewal: { findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    subscriptionPaymentAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn() },
    deliveryZone: { findFirst: vi.fn() },
  },
}));

vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() } } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { scheduleAutomation: vi.fn() } }));
vi.mock("../shared/utils/audit", () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { recordAudit } from "../shared/utils/audit";
import { renewalsService } from "../modules/regular-deliveries/renewals.service";

const m = vi.mocked(prisma, true);
const mCreateIntent = vi.mocked(stripe.paymentIntents.create);
const mRecordAudit = vi.mocked(recordAudit);

function baseRenewal(overrides: Partial<any> = {}) {
  return {
    id: "renewal-1",
    status: "READY_FOR_PAYMENT",
    subscriptionId: "sub-1",
    currency: "GBP",
    items: [{ currentUnitPrice: 1000, quantity: 2, product: { weightGrams: 500 } }], // subtotal 2000, 1kg total
    subscription: {
      status: "ACTIVE",
      buyerId: "buyer-1",
      paymentMethod: { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" },
      offer: { fulfilmentMethod: "DELIVERY" },
      deliveryAddress: { country: "United Kingdom" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.subscriptionPaymentAttempt.count.mockResolvedValue(0);
  m.subscriptionPaymentAttempt.create.mockResolvedValue({ id: "attempt-1" } as never);
  m.renewal.updateMany.mockResolvedValue({ count: 1 } as never);
  m.renewal.findUnique.mockResolvedValue({ id: "renewal-1", status: "PAYMENT_PROCESSING" } as never);
});

/**
 * Regression coverage for the renewal delivery-fee safety fix: previously
 * the delivery fee was computed for the FIRST time after payment succeeded
 * (in convertPaidRenewalToOrder), defaulting to £0 whenever no
 * DeliveryZone matched — even for a DELIVERY-fulfilment renewal — and even
 * when a zone DID exist, the buyer was only ever actually charged the item
 * subtotal (see the Stripe amount below) while the Order/Payment/vendor-
 * wallet-credit recorded subtotal+fee, permanently overstating vendor
 * earnings for a fee never collected. The fee is now resolved and included
 * in the real Stripe charge BEFORE payment, and stored on the Renewal so
 * conversion never re-derives (and can't diverge from) what was charged.
 */
describe("renewalsService.attemptPayment — delivery fee safety", () => {
  it("valid zone: charges subtotal + the real resolved delivery fee, and stores it on the renewal for order conversion", async () => {
    m.deliveryZone.findFirst.mockResolvedValue({ id: "zone-1", baseFeeAmount: 500, feePerKgAmount: 100 } as never);
    m.renewal.findUniqueOrThrow.mockResolvedValue(baseRenewal() as never);
    mCreateIntent.mockResolvedValue({ id: "pi_1", status: "succeeded" } as never);
    vi.spyOn(renewalsService, "convertPaidRenewalToOrder").mockResolvedValue({ id: "order-1" } as never);

    await renewalsService.attemptPayment("renewal-1");

    // subtotal 2000 + (base 500 + ceil(1000g/1000)*100) = 2000 + 600 = 2600
    expect(mCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2600 }),
      expect.anything(),
    );
    expect(m.renewal.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryFeeAmount: 600, deliveryZoneId: "zone-1" }),
    }));
  });

  it("missing zone on a DELIVERY-fulfilment offer: refuses to charge at all, marks PAYMENT_FAILED with a clear reason, never calls Stripe", async () => {
    m.deliveryZone.findFirst.mockResolvedValue(null);
    m.renewal.findUniqueOrThrow.mockResolvedValue(baseRenewal() as never);

    await renewalsService.attemptPayment("renewal-1");

    expect(mCreateIntent).not.toHaveBeenCalled();
    expect(m.subscriptionPaymentAttempt.create).not.toHaveBeenCalled(); // not a retryable payment failure
    expect(m.renewal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "renewal-1" },
      data: expect.objectContaining({ status: "PAYMENT_FAILED", failureReason: expect.stringContaining("United Kingdom") }),
    }));
    expect(mRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "renewal.payment_blocked_no_delivery_coverage" }));
  });

  it("COLLECTION fulfilment: never looks up a delivery zone, charges subtotal only, no fee stored", async () => {
    m.renewal.findUniqueOrThrow.mockResolvedValue(baseRenewal({
      subscription: { ...baseRenewal().subscription, offer: { fulfilmentMethod: "COLLECTION" } },
    }) as never);
    mCreateIntent.mockResolvedValue({ id: "pi_2", status: "succeeded" } as never);
    vi.spyOn(renewalsService, "convertPaidRenewalToOrder").mockResolvedValue({ id: "order-2" } as never);

    await renewalsService.attemptPayment("renewal-1");

    expect(m.deliveryZone.findFirst).not.toHaveBeenCalled();
    expect(mCreateIntent).toHaveBeenCalledWith(expect.objectContaining({ amount: 2000 }), expect.anything());
    expect(m.renewal.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryFeeAmount: 0, deliveryZoneId: null }),
    }));
  });

  it("requeryAmbiguousAttempt replays the SAME total (subtotal + stored fee), matching what attemptPayment originally sent under this idempotency key", async () => {
    m.subscriptionPaymentAttempt.count.mockResolvedValue(0);
    const findFirstAttempt = vi.fn().mockResolvedValue({ id: "attempt-1", attemptNumber: 1, idempotencyKey: "renewal-1:1", status: "PENDING", stripePaymentIntentId: null });
    (m.subscriptionPaymentAttempt as any).findFirst = findFirstAttempt;
    m.renewal.findUniqueOrThrow.mockResolvedValue({
      ...baseRenewal(),
      status: "PAYMENT_PROCESSING",
      subtotalAmount: 2000,
      deliveryFeeAmount: 600,
    } as never);
    mCreateIntent.mockResolvedValue({ id: "pi_3", status: "succeeded" } as never);
    (m.subscriptionPaymentAttempt as any).updateMany = vi.fn().mockResolvedValue({ count: 1 });
    vi.spyOn(renewalsService, "convertPaidRenewalToOrder").mockResolvedValue({ id: "order-3" } as never);

    await renewalsService.requeryAmbiguousAttempt("renewal-1");

    expect(mCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2600 }),
      { idempotencyKey: "renewal-1:1" },
    );
  });
});
