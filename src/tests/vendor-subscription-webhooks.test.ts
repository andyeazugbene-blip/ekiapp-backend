/**
 * Acceptance audit fix (Defect D) — VendorSubscription.status was only ever
 * set once, on checkout.session.completed ("kind: vendor_subscription"). No
 * handler existed for invoice.payment_failed / customer.subscription.updated
 * / customer.subscription.deleted, so a vendor whose card started failing
 * (or whose Stripe subscription was cancelled directly in Stripe) stayed
 * ACTIVE in our DB forever. These tests prove the three new webhook
 * handlers keep VendorSubscription.status in sync with Stripe's own state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendorSubscription: { findUnique: vi.fn(), update: vi.fn() },
    vendor: { findUnique: vi.fn() },
    webhookEvent: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { webhooks: { constructEvent: vi.fn() } },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ message: String(e) })),
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { stripeWebhookService } from "../modules/stripe/stripe.service";
import { notificationsService } from "../modules/notifications/notifications.service";

const m = vi.mocked(prisma, true) as any;
const constructEvent = stripe.webhooks.constructEvent as unknown as ReturnType<typeof vi.fn>;
const enqueue = notificationsService.enqueue as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

/** Drives $transaction exactly the way claimWebhookEventOrSkip() uses it:
 * calls the callback with a tx whose webhookEvent.create succeeds (or, for
 * the duplicate test, rejects with a P2002). */
function mockClaimSucceeds() {
  m.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      webhookEvent: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    }),
  );
}

function mockClaimIsDuplicate() {
  m.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      webhookEvent: {
        create: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.0.0" }),
        ),
      },
    }),
  );
}

describe("invoice.payment_failed — vendor subscription", () => {
  it("sets status to PAST_DUE and notifies the vendor", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_inv_failed_1",
      type: "invoice.payment_failed",
      data: { object: { parent: { subscription_details: { subscription: "sub_1" } } } },
    });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1" });
    m.vendor.findUnique.mockResolvedValue({ userId: "user-1" });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(result.duplicate).toBeUndefined();
    expect(m.vendorSubscription.update).toHaveBeenCalledWith({ where: { id: "vs-1" }, data: { status: "PAST_DUE" } });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", type: "SUBSCRIPTION_UPDATE" }),
    );
  });

  it("is a no-op (never writes) when the invoice's subscription isn't a known vendor subscription", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_inv_failed_2",
      type: "invoice.payment_failed",
      data: { object: { parent: { subscription_details: { subscription: "sub_unknown" } } } },
    });
    m.vendorSubscription.findUnique.mockResolvedValue(null);

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(result.ignored).toBe(true);
    expect(m.vendorSubscription.update).not.toHaveBeenCalled();
  });

  it("returns duplicate on a repeated event and never writes twice", async () => {
    mockClaimIsDuplicate();
    constructEvent.mockReturnValue({
      id: "evt_inv_failed_dup",
      type: "invoice.payment_failed",
      data: { object: { parent: { subscription_details: { subscription: "sub_1" } } } },
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.duplicate).toBe(true);
    expect(m.vendorSubscription.update).not.toHaveBeenCalled();
  });
});

describe("customer.subscription.updated — vendor subscription", () => {
  it("maps Stripe status 'past_due' to PAST_DUE and syncs the billing period", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_sub_updated_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "past_due",
          items: { data: [{ current_period_start: 1700000000, current_period_end: 1702600000 }] },
        },
      },
    });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1", status: "ACTIVE" });
    m.vendor.findUnique.mockResolvedValue({ userId: "user-1" });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(m.vendorSubscription.update).toHaveBeenCalledWith({
      where: { id: "vs-1" },
      data: {
        status: "PAST_DUE",
        currentPeriodStart: new Date(1700000000 * 1000),
        currentPeriodEnd: new Date(1702600000 * 1000),
      },
    });
    expect(enqueue).toHaveBeenCalled();
  });

  it("maps Stripe status 'canceled' to CANCELLED and stamps cancelledAt", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_sub_updated_2",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "canceled", items: { data: [{}] } } },
    });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1", status: "ACTIVE" });
    m.vendor.findUnique.mockResolvedValue({ userId: "user-1" });

    await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(m.vendorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "vs-1" },
        data: expect.objectContaining({ status: "CANCELLED", cancelledAt: expect.any(Date) }),
      }),
    );
  });

  it("does NOT write and does NOT notify for an unmapped Stripe status ('incomplete') — never guesses a terminal state", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_sub_updated_3",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "incomplete", items: { data: [{}] } } },
    });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1", status: "ACTIVE" });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(m.vendorSubscription.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not notify when the mapped status is unchanged from the stored status", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_sub_updated_4",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "active", items: { data: [{}] } } },
    });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1", status: "ACTIVE" });

    await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(m.vendorSubscription.update).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("customer.subscription.deleted — vendor subscription", () => {
  it("sets status to CANCELLED and notifies the vendor", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_sub_deleted_1",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1" } },
    });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1", status: "ACTIVE" });
    m.vendor.findUnique.mockResolvedValue({ userId: "user-1" });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(m.vendorSubscription.update).toHaveBeenCalledWith({
      where: { id: "vs-1" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
    });
    expect(enqueue).toHaveBeenCalled();
  });

  it("is idempotent — already-CANCELLED subscriptions are not written or notified again", async () => {
    mockClaimSucceeds();
    constructEvent.mockReturnValue({
      id: "evt_sub_deleted_2",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1" } },
    });
    m.vendorSubscription.findUnique.mockResolvedValue({ id: "vs-1", vendorId: "vendor-1", status: "CANCELLED" });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.received).toBe(true);
    expect(m.vendorSubscription.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns duplicate on a repeated event and never writes twice", async () => {
    mockClaimIsDuplicate();
    constructEvent.mockReturnValue({
      id: "evt_sub_deleted_dup",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1" } },
    });

    const result = await stripeWebhookService.handleWebhook({ signature: "valid-sig", rawBody: Buffer.from("body") });

    expect(result.duplicate).toBe(true);
    expect(m.vendorSubscription.update).not.toHaveBeenCalled();
  });
});
