
/**
 * Canonical events that need their own small harness: unsubscribe (message_opted_out),
 * public store view beacon (store_viewed), the read-only event log used for auditability,
 * the delivery-proof controller audit row, and the Stripe refund webhook (refund_completed).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { updateMany: vi.fn() },
    vendor: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    event: { findMany: vi.fn(), groupBy: vi.fn(), create: vi.fn().mockResolvedValue({}) },
    refund: { updateMany: vi.fn() },
  },
}));
vi.mock("../lib/stripe", () => ({ stripe: { webhooks: { constructEvent: vi.fn() } } }));
vi.mock("../config/env", () => ({ env: { stripeWebhookSecret: "whsec", stripeIdentityWebhookSecret: "whsec_i", jwtSecret: "test-secret-key-for-testing-only" } }));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ message: String(e) })),
}));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/ledger/ledger.service", () => ({ ledgerService: {} }));
vi.mock("../modules/community-buy/campaign-payout.service", () => ({ campaignPayoutService: {} }));
vi.mock("../modules/community-buy/campaign-authorisation.service", () => ({ campaignAuthorisationService: {} }));
vi.mock("../modules/community-buy/organiser-stripe-connect.service", () => ({ organiserStripeConnectService: {} }));
vi.mock("../modules/vendors/stripe-connect.service", () => ({ stripeConnectService: {} }));
vi.mock("../shared/utils/audit", async () => {
  const actual = await vi.importActual<typeof import("../shared/utils/audit")>("../shared/utils/audit");
  return { ...actual, recordAudit: recordAuditMock };
});
vi.mock("../modules/orders/delivery-proof.service", () => ({
  deliveryProofService: {
    addAsVendor: vi.fn().mockResolvedValue({ id: "oe1", kind: "DELIVERY_PHOTO", uploadAssetId: "a1", note: null }),
  },
}));

import { prisma } from "../lib/prisma";
import { eventsService } from "../modules/events/events.service";
import { handleUnsubscribe } from "../modules/communications/unsubscribe.routes";
import { signUnsubscribeToken } from "../modules/communications/comms-utils";
import { publicStoresService } from "../modules/public-stores/public-stores.service";
import { listAdminEvents } from "../modules/automation/automation-admin.controller";
import { vendorAddDeliveryProof } from "../modules/orders/delivery-proof.controller";
import { stripeWebhookService } from "../modules/stripe/stripe.service";
import { disputeV2Service } from "../modules/disputes/dispute-v2.service";
import { adminDisputeDecideAppeal, adminDisputePostMessage, adminDisputeRequestEvidence } from "../modules/disputes/disputes.controller";

const m = vi.mocked(prisma, true) as any;
const emit = vi.spyOn(eventsService, "emit").mockImplementation(() => undefined);

function res() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.type = () => r;
  r.send = (b: unknown) => { r.body = b; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  emit.mockClear();
});

describe("message_opted_out", () => {
  it("emits once when the unsubscribe link actually withdraws marketing consent", async () => {
    m.user.updateMany.mockResolvedValue({ count: 1 });
    const r = res();
    await handleUnsubscribe({ query: { token: signUnsubscribeToken("user-9") }, body: {} } as any, r);
    expect(r.statusCode).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ name: "message_opted_out", entityType: "User", entityId: "user-9", actorId: "user-9", source: "unsubscribe_link" });
  });

  it("a repeat click (consent already cleared) and an invalid token emit nothing", async () => {
    m.user.updateMany.mockResolvedValue({ count: 0 });
    await handleUnsubscribe({ query: { token: signUnsubscribeToken("user-9") }, body: {} } as any, res());
    const bad = res();
    await handleUnsubscribe({ query: { token: "garbage" }, body: {} } as any, bad);
    expect(bad.statusCode).toBe(400);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("store_viewed", () => {
  const vendor = { id: "v1", storeName: "S", storeSlug: "s", city: "c", country: "GB", isSuspended: false };
  beforeEach(() => {
    m.vendor.findUnique.mockResolvedValue(vendor);
    vi.spyOn(publicStoresService, "getAnalyticsSummaryForVendor").mockResolvedValue({} as never);
  });

  it("the storefront open beacon emits store_viewed (client reported); other beacons do not", async () => {
    await publicStoresService.recordEvent("s", { event: "open", source: "qr" } as never, "viewer-1");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ name: "store_viewed", entityType: "Vendor", entityId: "v1", actorId: "viewer-1", payload: { clientReported: true, storeSlug: "s" } });
    emit.mockClear();
    await publicStoresService.recordEvent("s", { event: "add_to_cart", productId: "p1" } as never);
    expect(emit).not.toHaveBeenCalled();
    // anonymous viewer
    await publicStoresService.recordEvent("s", { event: "open" } as never);
    expect(emit.mock.calls[0][0]).toMatchObject({ actorType: "anonymous", actorId: null });
  });
});

describe("event log auditability (GET /api/admin/events)", () => {
  it("filters by name / entityType / entityId / date range and paginates with a cursor", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `ev${i}`, name: "dispute_opened" }));
    m.event.findMany.mockResolvedValue(rows);
    const r = res();
    await listAdminEvents({ query: { name: "dispute_opened", entityType: "Dispute", entityId: "d1", from: "2026-01-01", to: "2026-12-31", limit: "2", cursor: "ev-prev" } } as any, r);
    const args = m.event.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ name: "dispute_opened", entityType: "Dispute", entityId: "d1" });
    expect(args.where.occurredAt.gte).toBeInstanceOf(Date);
    expect(args.where.occurredAt.lte).toBeInstanceOf(Date);
    expect(args).toMatchObject({ take: 3, cursor: { id: "ev-prev" }, skip: 1 });
    expect(r.body.items).toHaveLength(2);
    expect(r.body.nextCursor).toBe("ev1");
  });

  it("ignores an unparseable date and caps the page size", async () => {
    m.event.findMany.mockResolvedValue([]);
    await listAdminEvents({ query: { from: "not-a-date", limit: "99999" } } as any, res());
    const args = m.event.findMany.mock.calls[0][0];
    expect(args.where.occurredAt).toBeUndefined();
    expect(args.take).toBe(201);
  });
});

describe("delivery proof submit is audited", () => {
  it("writes an audit row with actor, order, evidence id and kind (no file contents)", async () => {
    await vendorAddDeliveryProof({ user: { id: "vendor-user-1" }, params: { id: "o1" }, body: { kind: "DELIVERY_PHOTO", uploadAssetId: "a1" } } as any, res());
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "vendor-user-1", action: "order.delivery_proof_submitted", entityType: "Order", entityId: "o1",
      metadata: expect.objectContaining({ evidenceId: "oe1", kind: "DELIVERY_PHOTO", uploadAssetId: "a1" }),
    }));
  });
});

describe("refund_completed from the Stripe refund webhook", () => {
  const run = async (status: string, count: number) => {
    m.refund.updateMany.mockResolvedValue({ count });
    vi.spyOn(stripeWebhookService as any, "runIdempotentWebhook").mockImplementation(async (_e: unknown, work: () => Promise<unknown>) => { await work(); return { received: true }; });
    await (stripeWebhookService as any).handleRefundUpdated({ id: "evt_1", type: "charge.refund.updated", data: { object: { id: "re_9", status, amount: 1200, currency: "gbp" } } });
  };

  it("emits once with the same eventKey as the synchronous admin path and the stripeEventId for dedupe", async () => {
    await run("succeeded", 1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      name: "refund_completed", entityType: "Refund", entityId: "re_9", amountMinor: 1200, currency: "GBP",
      payload: { eventKey: "refund_completed:re_9", stripeEventId: "evt_1" },
    });
  });

  it("does not emit for pending/failed refunds or when no local refund row matched", async () => {
    await run("pending", 1);
    await run("failed", 1);
    await run("succeeded", 0);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("every admin dispute mutation leaves an audit row", () => {
  const req = (body: object) => ({ user: { id: "admin-1" }, params: { id: "d1" }, body } as any);

  it("public message, internal note, evidence request and appeal decision are each audited with actor + dispute id", async () => {
    vi.spyOn(disputeV2Service, "adminPostMessage").mockResolvedValue({ id: "msg1" } as never);
    vi.spyOn(disputeV2Service, "adminRequestEvidence").mockResolvedValue({ before: { respondByAt: null }, after: { evidenceRequestedFrom: "VENDOR" } } as never);
    vi.spyOn(disputeV2Service, "adminDecideAppeal").mockResolvedValue({ before: { appealStatus: "REQUESTED" }, after: { appealStatus: "UPHELD" } } as never);
    recordAuditMock.mockClear();

    await adminDisputePostMessage(req({ body: "Please send the receipt", internal: false }), res());
    await adminDisputePostMessage(req({ body: "Checked courier log", internal: true }), res());
    await adminDisputeRequestEvidence(req({ from: "VENDOR", reason: "Need dispatch photo" }), res());
    await adminDisputeDecideAppeal(req({ decision: "UPHELD", reason: "Original decision stands" }), res());

    const actions = recordAuditMock.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(["dispute.message", "dispute.internal_note", "dispute.evidence_requested", "dispute.appeal_decided"]);
    expect(recordAuditMock.mock.calls.every((c) => c[0].actorId === "admin-1" && c[0].entityType === "Dispute" && c[0].entityId === "d1")).toBe(true);
  });

  it("a failed mutation (service throws) writes no audit row", async () => {
    vi.spyOn(disputeV2Service, "adminRequestEvidence").mockRejectedValue(new Error("Dispute is already resolved"));
    recordAuditMock.mockClear();
    await expect(adminDisputeRequestEvidence(req({ from: "VENDOR", reason: "Need dispatch photo" }), res())).rejects.toThrow();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});
