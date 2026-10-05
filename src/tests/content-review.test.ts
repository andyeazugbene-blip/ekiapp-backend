/**
 * Content Review moderation: transitions, required reason, ContentDecision +
 * audit on every action, owner notification on reject/remove, identity
 * documents kept out of general moderation and read-url gating/audit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => {
  const prisma: any = {
    uploadAsset: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]), count: vi.fn() },
    contentDecision: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    contentReport: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn() },
    user: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    vendor: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    product: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
  };
  return { prisma };
});
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/storage", () => ({ generatePresignedRead: vi.fn().mockResolvedValue("https://signed.example/doc") }));
vi.mock("../shared/utils/audit", () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/admin/admin-roles.service", () => ({ adminRolesService: { assertPermission: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { recordAudit } from "../shared/utils/audit";
import { notificationsService } from "../modules/notifications/notifications.service";
import { adminRolesService } from "../modules/admin/admin-roles.service";
import { allowedActions, contentReviewService, nextModerationStatus } from "../modules/uploads/content-review.service";

const m = prisma as any;

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1", ownerId: "u1", category: "product", key: "product/u1/x.jpg", publicUrl: "https://cdn/x.jpg",
    contentType: "image/jpeg", sizeBytes: 100, status: "COMPLETED", moderationStatus: "PENDING_REVIEW",
    entityType: "product", entityId: "p1", createdAt: new Date(), completedAt: new Date(), ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.uploadAsset.updateMany.mockResolvedValue({ count: 1 });
  m.uploadAsset.findUnique.mockResolvedValue(asset());
  m.product.findMany.mockResolvedValue([]);
});

describe("moderation state machine", () => {
  it("maps each action to its moderation status; contact_owner leaves it unchanged", () => {
    expect(nextModerationStatus("PENDING_REVIEW", "approve")).toBe("APPROVED");
    expect(nextModerationStatus("PENDING_REVIEW", "reject")).toBe("REJECTED");
    expect(nextModerationStatus("APPROVED", "flag")).toBe("PENDING_REVIEW");
    expect(nextModerationStatus("NOT_REVIEWED", "remove")).toBe("REMOVED");
    expect(nextModerationStatus("APPROVED", "contact_owner")).toBe("APPROVED");
  });

  it("REMOVED is terminal (only contact-owner), already-flagged cannot be re-flagged", () => {
    expect(() => nextModerationStatus("REMOVED", "approve")).toThrow(/cannot approve/i);
    expect(() => nextModerationStatus("PENDING_REVIEW", "flag")).toThrow();
    expect(allowedActions("REMOVED", "COMPLETED", "product")).toEqual(["contact_owner"]);
  });

  it("a transfer that never completed cannot be approved/rejected, and identity docs have no actions", () => {
    expect(allowedActions("NOT_REVIEWED", "FAILED", "product")).toEqual(["remove", "flag", "contact_owner"]);
    expect(allowedActions("NOT_REVIEWED", "COMPLETED", "verification")).toEqual([]);
  });
});

describe("decide", () => {
  it("requires a reason of at least 5 characters", async () => {
    await expect(contentReviewService.decide("a1", "approve", "admin-1", "no")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.uploadAsset.updateMany).not.toHaveBeenCalled();
  });

  it("refuses identity documents (they belong to Verification)", async () => {
    m.uploadAsset.findUnique.mockResolvedValue(asset({ category: "verification" }));
    await expect(contentReviewService.decide("a1", "approve", "admin-1", "looks fine")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an invalid transition with 409", async () => {
    m.uploadAsset.findUnique.mockResolvedValue(asset({ moderationStatus: "REMOVED" }));
    await expect(contentReviewService.decide("a1", "approve", "admin-1", "restore it")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("guards against a concurrent reviewer (status changed underneath)", async () => {
    m.uploadAsset.updateMany.mockResolvedValue({ count: 0 });
    await expect(contentReviewService.decide("a1", "approve", "admin-1", "looks fine")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.contentDecision.create).not.toHaveBeenCalled();
  });

  it("reject writes the status, a ContentDecision, an audit entry and notifies the owner", async () => {
    await contentReviewService.decide("a1", "reject", "admin-1", "Blurry and off-topic");
    expect(m.uploadAsset.updateMany).toHaveBeenCalledWith({ where: { id: "a1", moderationStatus: "PENDING_REVIEW" }, data: { moderationStatus: "REJECTED" } });
    expect(m.contentDecision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ assetId: "a1", reviewerId: "admin-1", decision: "REJECTED", action: "reject", reason: "Blurry and off-topic" }) });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "content.reject", entityId: "a1", reason: "Blurry and off-topic" }));
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", data: expect.objectContaining({ action: "reject", assetId: "a1" }) }));
  });

  it("remove detaches the content from the product and notifies the owner", async () => {
    m.product.findMany.mockResolvedValue([{ id: "p1", images: ["https://cdn/x.jpg", "https://cdn/y.jpg"] }]);
    await contentReviewService.decide("a1", "remove", "admin-1", "Policy violation");
    expect(m.product.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { images: ["https://cdn/y.jpg"] } });
    expect(notificationsService.enqueue).toHaveBeenCalled();
  });

  it("approve does not notify the owner; contact_owner notifies without changing state", async () => {
    await contentReviewService.decide("a1", "approve", "admin-1", "Verified fine");
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
    vi.clearAllMocks();
    m.uploadAsset.findUnique.mockResolvedValue(asset());
    await contentReviewService.decide("a1", "contact_owner", "admin-1", "Please upload a clearer photo");
    expect(m.uploadAsset.updateMany).not.toHaveBeenCalled();
    expect(m.contentDecision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "contact_owner", decision: "PENDING_REVIEW" }) });
    expect(notificationsService.enqueue).toHaveBeenCalled();
  });
});

describe("readUrl — audited, identity documents gated", () => {
  it("audits a public asset read and does not require verification.read", async () => {
    m.uploadAsset.findUnique.mockResolvedValue(asset());
    const r = await contentReviewService.readUrl("a1", "admin-1");
    expect(r.readUrl).toBe("https://cdn/x.jpg");
    expect(adminRolesService.assertPermission).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "content.read_url", entityId: "a1" }));
  });

  it("requires verification.read and signs a short-lived URL for an identity document", async () => {
    m.uploadAsset.findUnique.mockResolvedValue(asset({ category: "verification", publicUrl: null }));
    const r = await contentReviewService.readUrl("a1", "admin-1");
    expect(adminRolesService.assertPermission).toHaveBeenCalledWith("admin-1", "verification.read");
    expect(r.readUrl).toBe("https://signed.example/doc");
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "identity_document.read_url" }));
  });

  it("never opens removed content or a transfer that never completed", async () => {
    m.uploadAsset.findUnique.mockResolvedValue(asset({ moderationStatus: "REMOVED" }));
    await expect(contentReviewService.readUrl("a1", "admin-1")).rejects.toMatchObject({ statusCode: 410 });
    m.uploadAsset.findUnique.mockResolvedValue(asset({ status: "FAILED" }));
    await expect(contentReviewService.readUrl("a1", "admin-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("queue — exception based, identity docs excluded", () => {
  it("never includes verification-category assets in the general queue", async () => {
    await contentReviewService.queue({ tab: "flagged" });
    expect(m.uploadAsset.findMany.mock.calls[0][0].where.category).toEqual({ not: "verification" });
    await contentReviewService.queue({ tab: "flagged", category: "verification" });
    expect(m.uploadAsset.findMany.mock.calls[1][0].where.category).toEqual({ not: "verification" });
  });
});
