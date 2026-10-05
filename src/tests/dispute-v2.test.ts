import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    dispute: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    disputeEvidence: { findMany: vi.fn(), create: vi.fn() },
    disputeMessage: { findMany: vi.fn(), create: vi.fn() },
    vendor: { findUnique: vi.fn() },
    uploadAsset: { findUnique: vi.fn(), update: vi.fn() },
    order: { findUnique: vi.fn() },
    orderEvidence: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("../lib/storage", () => ({
  generatePresignedRead: vi.fn(async (key: string) => `https://signed.example/${key}?sig=1`),
}));
vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import {
  appealState,
  computeDeadlineState,
  defaultRespondByAt,
  disputeV2Service,
  parseDisputeType,
  partiesAllowedToAppeal,
} from "../modules/disputes/dispute-v2.service";
import { deliveryProofService } from "../modules/orders/delivery-proof.service";

const m = prisma as any;
const enqueue = vi.mocked(notificationsService.enqueue);

const BUYER = "user-buyer";
const VENDOR_USER = "user-vendor";
const STRANGER = "user-stranger";

function disputeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1", orderId: "o1", buyerId: BUYER, vendorId: "v1", status: "OPEN", appealStatus: "NONE",
    resolvedAt: null, respondByAt: new Date(Date.now() + 3 * 86400000), order: { orderNumber: "EKI-1" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.dispute.findUnique.mockResolvedValue(disputeRow());
  m.vendor.findUnique.mockResolvedValue({ userId: VENDOR_USER, id: "v1" });
});

describe("deadline logic", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  it("classifies ON_TIME / DUE_SOON / OVERDUE / CLOSED / NONE", () => {
    expect(computeDeadlineState({ status: "OPEN", respondByAt: new Date(now.getTime() + 3 * 86400000) }, now).state).toBe("ON_TIME");
    expect(computeDeadlineState({ status: "OPEN", respondByAt: new Date(now.getTime() + 3600000) }, now).state).toBe("DUE_SOON");
    expect(computeDeadlineState({ status: "OPEN", respondByAt: new Date(now.getTime() - 1000) }, now).state).toBe("OVERDUE");
    expect(computeDeadlineState({ status: "RESOLVED_BUYER", respondByAt: new Date(now.getTime() - 1000) }, now).state).toBe("CLOSED");
    expect(computeDeadlineState({ status: "OPEN", respondByAt: null }, now).state).toBe("NONE");
  });
  it("default response deadline is 5 days after opening", () => {
    const from = new Date("2026-10-05T00:00:00Z");
    expect(defaultRespondByAt(from).toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });
  it("validates dispute type, defaulting to OTHER", () => {
    expect(parseDisputeType(undefined)).toBe("OTHER");
    expect(parseDisputeType("damaged")).toBe("DAMAGED");
    expect(() => parseDisputeType("bogus")).toThrow();
  });
});

describe("appeal transitions", () => {
  it("only the losing party may appeal", () => {
    expect(partiesAllowedToAppeal("RESOLVED_BUYER")).toEqual(["VENDOR"]);
    expect(partiesAllowedToAppeal("RESOLVED_VENDOR")).toEqual(["BUYER"]);
    expect(partiesAllowedToAppeal("RESOLVED_PARTIAL")).toEqual(["BUYER", "VENDOR"]);
    expect(partiesAllowedToAppeal("OPEN")).toEqual([]);
  });
  it("appeal window is 7 days after the decision", () => {
    const resolvedAt = new Date("2026-10-01T00:00:00Z");
    expect(appealState({ status: "RESOLVED_BUYER", appealStatus: "NONE", resolvedAt }, new Date("2026-10-07T00:00:00Z")).canAppeal).toBe(true);
    expect(appealState({ status: "RESOLVED_BUYER", appealStatus: "NONE", resolvedAt }, new Date("2026-10-09T00:00:00Z")).canAppeal).toBe(false);
    expect(appealState({ status: "RESOLVED_BUYER", appealStatus: "REQUESTED", resolvedAt }, new Date("2026-10-02T00:00:00Z")).canAppeal).toBe(false);
  });
  it("vendor appeals a buyer-favour decision: NONE -> REQUESTED and the buyer is notified", async () => {
    m.dispute.findUnique.mockResolvedValue(disputeRow({ status: "RESOLVED_BUYER", resolvedAt: new Date() }));
    m.dispute.updateMany.mockResolvedValue({ count: 1 });
    await expect(disputeV2Service.requestAppeal(VENDOR_USER, "d1", "The courier photo proves delivery.")).resolves.toEqual({ appealStatus: "REQUESTED" });
    expect(m.dispute.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1", appealStatus: "NONE" } }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: BUYER }));
  });
  it("the winning party cannot appeal (403)", async () => {
    m.dispute.findUnique.mockResolvedValue(disputeRow({ status: "RESOLVED_BUYER", resolvedAt: new Date() }));
    await expect(disputeV2Service.requestAppeal(BUYER, "d1", "I want more please ok")).rejects.toMatchObject({ statusCode: 403 });
  });
  it("rejects a second appeal and an expired window (409) and short reasons (400)", async () => {
    m.dispute.findUnique.mockResolvedValue(disputeRow({ status: "RESOLVED_BUYER", resolvedAt: new Date(), appealStatus: "REQUESTED" }));
    await expect(disputeV2Service.requestAppeal(VENDOR_USER, "d1", "long enough reason here")).rejects.toMatchObject({ statusCode: 409 });
    m.dispute.findUnique.mockResolvedValue(disputeRow({ status: "RESOLVED_BUYER", resolvedAt: new Date(Date.now() - 30 * 86400000) }));
    await expect(disputeV2Service.requestAppeal(VENDOR_USER, "d1", "long enough reason here")).rejects.toMatchObject({ statusCode: 409 });
    await expect(disputeV2Service.requestAppeal(VENDOR_USER, "d1", "short")).rejects.toMatchObject({ statusCode: 400 });
  });
  it("admin decision requires an open appeal, a valid decision and a reason", async () => {
    m.dispute.findUnique.mockResolvedValue(disputeRow({ appealStatus: "NONE" }));
    await expect(disputeV2Service.adminDecideAppeal("admin", "d1", { decision: "UPHELD", reason: "reason long enough" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(disputeV2Service.adminDecideAppeal("admin", "d1", { decision: "MAYBE", reason: "reason long enough" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(disputeV2Service.adminDecideAppeal("admin", "d1", { decision: "UPHELD", reason: "no" })).rejects.toMatchObject({ statusCode: 400 });
    m.dispute.findUnique.mockResolvedValue(disputeRow({ appealStatus: "REQUESTED" }));
    m.dispute.updateMany.mockResolvedValue({ count: 1 });
    const r = await disputeV2Service.adminDecideAppeal("admin", "d1", { decision: "OVERTURNED", reason: "New evidence is conclusive" });
    expect(r.after).toEqual({ appealStatus: "OVERTURNED" });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe("IDOR: a user who is not the buyer or the vendor of the order gets 404 on every party endpoint", () => {
  it("view / evidence / message / appeal", async () => {
    await expect(disputeV2Service.getForParty(STRANGER, "d1")).rejects.toMatchObject({ statusCode: 404 });
    await expect(disputeV2Service.addEvidence(STRANGER, "d1", { kind: "TEXT", text: "hello there" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(disputeV2Service.addMessage(STRANGER, "d1", "hello there")).rejects.toMatchObject({ statusCode: 404 });
    await expect(disputeV2Service.requestAppeal(STRANGER, "d1", "reason long enough")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.disputeEvidence.create).not.toHaveBeenCalled();
    expect(m.disputeMessage.create).not.toHaveBeenCalled();
  });
  it("a vendor of a different store is also a stranger", async () => {
    m.vendor.findUnique.mockResolvedValue({ userId: "someone-else" });
    await expect(disputeV2Service.addMessage(VENDOR_USER, "d1", "hello there")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("evidence and messages", () => {
  it("text evidence by the buyer notifies the vendor", async () => {
    m.disputeEvidence.create.mockResolvedValue({ id: "e1" });
    await disputeV2Service.addEvidence(BUYER, "d1", { kind: "TEXT", text: "Box arrived crushed" });
    expect(m.disputeEvidence.create).toHaveBeenCalledWith({ data: expect.objectContaining({ submitterRole: "BUYER", kind: "TEXT" }) });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: VENDOR_USER }));
  });
  it("file evidence requires an asset the submitter owns, of the dispute_evidence category, completed", async () => {
    m.uploadAsset.findUnique.mockResolvedValue({ id: "a1", ownerId: "other", category: "dispute_evidence", status: "COMPLETED", entityId: null });
    await expect(disputeV2Service.addEvidence(BUYER, "d1", { kind: "PHOTO", uploadAssetId: "a1" })).rejects.toMatchObject({ statusCode: 404 });
    m.uploadAsset.findUnique.mockResolvedValue({ id: "a1", ownerId: BUYER, category: "avatar", status: "COMPLETED", entityId: null });
    await expect(disputeV2Service.addEvidence(BUYER, "d1", { kind: "PHOTO", uploadAssetId: "a1" })).rejects.toMatchObject({ statusCode: 404 });
    m.uploadAsset.findUnique.mockResolvedValue({ id: "a1", ownerId: BUYER, category: "dispute_evidence", status: "REQUESTED", entityId: null });
    await expect(disputeV2Service.addEvidence(BUYER, "d1", { kind: "PHOTO", uploadAssetId: "a1" })).rejects.toMatchObject({ statusCode: 409 });
    m.uploadAsset.findUnique.mockResolvedValue({ id: "a1", ownerId: BUYER, category: "dispute_evidence", status: "COMPLETED", entityId: "another-dispute", entityType: "dispute" });
    await expect(disputeV2Service.addEvidence(BUYER, "d1", { kind: "PHOTO", uploadAssetId: "a1" })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("a valid photo is attached to the dispute", async () => {
    m.uploadAsset.findUnique.mockResolvedValue({ id: "a1", ownerId: BUYER, category: "dispute_evidence", status: "COMPLETED", entityId: null });
    m.disputeEvidence.create.mockResolvedValue({ id: "e1" });
    await disputeV2Service.addEvidence(BUYER, "d1", { kind: "PHOTO", uploadAssetId: "a1" });
    expect(m.uploadAsset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { entityType: "dispute", entityId: "d1" } });
  });
  it("a closed dispute rejects new evidence and messages", async () => {
    m.dispute.findUnique.mockResolvedValue(disputeRow({ status: "RESOLVED_VENDOR", resolvedAt: new Date() }));
    await expect(disputeV2Service.addMessage(BUYER, "d1", "one more thing")).rejects.toMatchObject({ statusCode: 409 });
    await expect(disputeV2Service.addEvidence(BUYER, "d1", { kind: "TEXT", text: "one more thing" })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("evidence visibility", () => {
  it("party view never queries or returns internal notes, and evidence files come back as signed URLs", async () => {
    m.dispute.findUnique
      .mockResolvedValueOnce(disputeRow())
      .mockResolvedValueOnce({ ...disputeRow(), reason: "r", type: "DAMAGED", claim: null, createdAt: new Date(), evidenceRequestedAt: null, evidenceRequestedFrom: null, appealDecidedAt: null, appealRequestedAt: null });
    m.disputeEvidence.findMany.mockResolvedValue([{ id: "e1", disputeId: "d1", submitterRole: "BUYER", kind: "PHOTO", createdAt: new Date(), uploadAssetId: "a1" }]);
    m.disputeMessage.findMany.mockResolvedValue([]);
    m.uploadAsset.findUnique.mockResolvedValue({ key: "dispute_evidence/u/x.jpg", contentType: "image/jpeg" });
    const view = await disputeV2Service.getForParty(BUYER, "d1");
    expect(m.disputeMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { disputeId: "d1", internal: false } }));
    expect(view.evidence[0].url).toContain("https://signed.example/dispute_evidence/");
    expect(view.timeline.some((t) => t.type === "INTERNAL_NOTE")).toBe(false);
  });
  it("admin view includes internal notes (no internal filter)", async () => {
    m.dispute.findUnique.mockResolvedValue({ ...disputeRow(), type: "OTHER", createdAt: new Date(), evidenceRequestedAt: null, evidenceRequestedFrom: null, appealDecidedAt: null, appealRequestedAt: null });
    m.disputeEvidence.findMany.mockResolvedValue([]);
    m.disputeMessage.findMany.mockResolvedValue([{ id: "m1", authorRole: "ADMIN", internal: true, createdAt: new Date(), body: "x" }]);
    const view = await disputeV2Service.getForAdmin("d1");
    expect(m.disputeMessage.findMany).toHaveBeenCalledWith({ where: { disputeId: "d1" }, orderBy: { createdAt: "asc" } });
    expect(view.timeline.some((t) => t.type === "INTERNAL_NOTE")).toBe(true);
  });
});

describe("admin actions", () => {
  it("internal note does not notify either party; a public message notifies both", async () => {
    m.dispute.findUnique.mockResolvedValue(disputeRow());
    m.disputeMessage.create.mockResolvedValue({ id: "m1" });
    await disputeV2Service.adminPostMessage("admin", "d1", "checking the courier log", true);
    expect(enqueue).not.toHaveBeenCalled();
    await disputeV2Service.adminPostMessage("admin", "d1", "Please upload the receipt", false);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
  it("request-evidence needs a party and a reason, sets a deadline and notifies the requested party only", async () => {
    await expect(disputeV2Service.adminRequestEvidence("admin", "d1", { from: "COURIER", reason: "need proof" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(disputeV2Service.adminRequestEvidence("admin", "d1", { from: "VENDOR", reason: "no" })).rejects.toMatchObject({ statusCode: 400 });
    m.disputeMessage.create.mockResolvedValue({ id: "m1" });
    const r = await disputeV2Service.adminRequestEvidence("admin", "d1", { from: "VENDOR", reason: "Please send the dispatch photo", dueInDays: 2 });
    expect(r.after.evidenceRequestedFrom).toBe("VENDOR");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: VENDOR_USER }));
  });
});

describe("delivery proof access control", () => {
  it("vendor cannot add proof to another vendor's order (404) or to an order that is not dispatched (409)", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "v1" });
    m.order.findUnique.mockResolvedValue({ id: "o1", vendorId: "v2", status: "DISPATCHED" });
    await expect(deliveryProofService.addAsVendor(VENDOR_USER, "o1", { kind: "NOTE", note: "left at door" })).rejects.toMatchObject({ statusCode: 404 });
    m.order.findUnique.mockResolvedValue({ id: "o1", vendorId: "v1", status: "PENDING" });
    await expect(deliveryProofService.addAsVendor(VENDOR_USER, "o1", { kind: "NOTE", note: "left at door" })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("a user without a vendor profile is refused", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(deliveryProofService.addAsVendor(STRANGER, "o1", { kind: "NOTE", note: "left at door" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(deliveryProofService.listForVendor(STRANGER, "o1")).rejects.toMatchObject({ statusCode: 404 });
  });
  it("vendor adds a photo proof on a dispatched order; photo needs an owned delivery_proof asset", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "v1" });
    m.order.findUnique.mockResolvedValue({ id: "o1", vendorId: "v1", status: "IN_TRANSIT" });
    await expect(deliveryProofService.addAsVendor(VENDOR_USER, "o1", { kind: "DELIVERY_PHOTO" })).rejects.toMatchObject({ statusCode: 400 });
    m.uploadAsset.findUnique.mockResolvedValue({ id: "a9", ownerId: VENDOR_USER, category: "delivery_proof", status: "COMPLETED", entityId: null });
    m.orderEvidence.create.mockResolvedValue({ id: "oe1" });
    await deliveryProofService.addAsVendor(VENDOR_USER, "o1", { kind: "DELIVERY_PHOTO", uploadAssetId: "a9" });
    expect(m.orderEvidence.create).toHaveBeenCalledWith({ data: expect.objectContaining({ orderId: "o1", submitterRole: "VENDOR", uploadAssetId: "a9" }) });
  });
  it("buyer reads only their own order's proof; vendor only their own", async () => {
    m.order.findUnique.mockResolvedValue({ buyerId: "someone-else", vendorId: "v2" });
    await expect(deliveryProofService.listForBuyer(BUYER, "o1")).rejects.toMatchObject({ statusCode: 404 });
    m.vendor.findUnique.mockResolvedValue({ id: "v1" });
    await expect(deliveryProofService.listForVendor(VENDOR_USER, "o1")).rejects.toMatchObject({ statusCode: 404 });
    m.order.findUnique.mockResolvedValue({ buyerId: BUYER, vendorId: "v1" });
    m.orderEvidence.findMany.mockResolvedValue([{ id: "oe1", uploadAssetId: "a9" }]);
    m.uploadAsset.findUnique.mockResolvedValue({ key: "delivery_proof/v/x.jpg", contentType: "image/jpeg" });
    const items = await deliveryProofService.listForBuyer(BUYER, "o1");
    expect(items[0].url).toContain("https://signed.example/delivery_proof/");
  });
});
