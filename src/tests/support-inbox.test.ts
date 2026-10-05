/**
 * Admin shared support inbox (handbook 6.1 / 14.2): lifecycle transitions,
 * filters, vendor counterparty role, broadcast-reply visibility, internal
 * notes, retention sweep. Prisma is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    message: { findMany: vi.fn(), groupBy: vi.fn().mockResolvedValue([]), create: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    contentReport: { findMany: vi.fn().mockResolvedValue([]) },
    adminPlatformSetting: { findMany: vi.fn().mockResolvedValue([]) },
    adminRoleAssignment: { findMany: vi.fn().mockResolvedValue([{ role: { permissions: ["admin.*"] } }]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    notification: { create: vi.fn().mockResolvedValue({}) },
    userBlock: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  },
}));
vi.mock("../lib/push-notifications", () => ({ pushNotifications: { newMessage: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { supportInboxService } from "../modules/messages/support-inbox.service";
import { supportRetentionService } from "../modules/messages/support-retention.service";
import { validateAdminSupportListQuery, validateSupportLifecycleInput, validateSendMessageInput } from "../modules/messages/messages.validation";

const m = prisma as any;
const ADMIN = { id: "admin-1", name: "Admin", email: "a@x.com", avatar: null, role: "ADMIN", vendor: null };
const BUYER = { id: "buyer-1", name: "Bea Buyer", email: "b@x.com", avatar: null, role: "BUYER", vendor: null };
const VENDOR = { id: "vendor-user-1", name: "Vic Vendor", email: "v@x.com", avatar: null, role: "VENDOR", vendor: { id: "vendor-1", storeName: "Vic Store" } };

const baseConv = (over: Record<string, unknown> = {}) => ({
  id: "c1", type: "SUPPORT", status: "OPEN", participantA: "admin-1", participantB: "buyer-1", orderId: "",
  lastMessageAt: new Date("2026-10-01T10:00:00Z"), createdAt: new Date(), updatedAt: new Date(),
  closedAt: null, closedById: null, escalatedAt: null, escalatedById: null, escalationNote: null,
  messages: [{ text: "hello", senderId: "buyer-1", createdAt: new Date() }], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.user.findMany.mockImplementation(({ where }: any) => {
    if (where?.role === "ADMIN") return Promise.resolve([{ id: ADMIN.id }]);
    if (where?.id?.in) return Promise.resolve([ADMIN, BUYER, VENDOR].filter((u) => where.id.in.includes(u.id)));
    return Promise.resolve([]);
  });
  m.conversation.count.mockResolvedValue(0);
  m.message.groupBy.mockResolvedValue([]);
  m.contentReport.findMany.mockResolvedValue([]);
  m.adminPlatformSetting.findMany.mockResolvedValue([]);
  m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["admin.*"] } }]);
});

describe("validation", () => {
  it("lifecycle input requires a reason of >= 5 chars", () => {
    expect(() => validateSupportLifecycleInput({})).toThrow();
    expect(() => validateSupportLifecycleInput({ reason: "abc" })).toThrow();
    expect(validateSupportLifecycleInput({ reason: "  resolved ok " }).reason).toBe("resolved ok");
  });
  it("list query parses filters and rejects bad status/role", () => {
    const q = validateAdminSupportListQuery({ status: "open", unread: "true", escalated: "true", orderLinked: "1", role: "vendor", q: " x " });
    expect(q).toMatchObject({ status: "open", unread: true, escalated: true, orderLinked: true, role: "vendor", q: "x" });
    expect(() => validateAdminSupportListQuery({ status: "nope" })).toThrow();
    expect(() => validateAdminSupportListQuery({ role: "admin" })).toThrow();
  });
  it("participant message attachments drop non-http(s) schemes", () => {
    const out = validateSendMessageInput({ text: "hi", attachments: ["javascript:alert(1)", "https://cdn/x.png", "data:text/html,x"] });
    expect(out.attachments).toEqual(["https://cdn/x.png"]);
  });
});

describe("list filters", () => {
  beforeEach(() => m.conversation.findMany.mockResolvedValue([baseConv()]));

  it("builds status/unread/escalated/order-linked clauses and reports counts", async () => {
    m.conversation.count.mockResolvedValue(3);
    const res = await supportInboxService.list({ limit: 20, status: "open", unread: true, escalated: true, orderLinked: true });
    const json = JSON.stringify(m.conversation.findMany.mock.calls[0][0].where);
    expect(json).toContain('"status":"OPEN"');
    expect(json).toContain('"isInternal":false');
    expect(json).toContain('"escalatedAt":{"not":null}');
    expect(json).toContain('"orderId":{"not":""}');
    expect(res.total).toBe(3);
    expect(res.counts).toMatchObject({ open: 3, closed: 3, unread: 3, escalated: 3 });
  });

  it("includes SUPPORT plus any thread with an ADMIN participant (broadcast replies)", async () => {
    await supportInboxService.list({ limit: 20, status: "all" });
    const json = JSON.stringify(m.conversation.findMany.mock.calls[0][0].where);
    expect(json).toContain('"type":"SUPPORT"');
    expect(json).toContain('"participantA":{"in":["admin-1"]}');
    expect(json).toContain('"participantB":{"in":["admin-1"]}');
  });

  it("reported filter restricts to conversations of pending-reported messages", async () => {
    m.contentReport.findMany.mockResolvedValue([{ targetId: "msg-9" }]);
    m.message.findMany.mockResolvedValue([{ conversationId: "c-rep" }]);
    await supportInboxService.list({ limit: 20, status: "all", reported: true });
    expect(JSON.stringify(m.conversation.findMany.mock.calls[0][0].where)).toContain('"id":{"in":["c-rep"]}');
  });

  it("role filter uses counterparty role via raw join", async () => {
    m.$queryRaw.mockResolvedValue([{ id: "c1" }]);
    await supportInboxService.list({ limit: 20, status: "all", role: "vendor" });
    expect(m.$queryRaw).toHaveBeenCalled();
    expect(JSON.stringify(m.conversation.findMany.mock.calls[0][0].where)).toContain('"id":{"in":["c1"]}');
  });

  it("search matches participants, order numbers and message text", async () => {
    m.user.findMany.mockImplementation(({ where }: any) => {
      if (where?.role === "ADMIN") return Promise.resolve([{ id: ADMIN.id }]);
      if (where?.OR) return Promise.resolve([{ id: BUYER.id }]);
      if (where?.id?.in) return Promise.resolve([ADMIN, BUYER].filter((u) => where.id.in.includes(u.id)));
      return Promise.resolve([]);
    });
    await supportInboxService.list({ limit: 20, status: "all", q: "bea" });
    const json = JSON.stringify(m.conversation.findMany.mock.calls[0][0].where);
    expect(json).toContain('"participantA":{"in":["buyer-1"]}');
    expect(json).toContain('"text":{"contains":"bea"');
  });

  it("paginates by cursor and returns nextCursor", async () => {
    m.conversation.findMany.mockResolvedValue([baseConv({ id: "c1" }), baseConv({ id: "c2" })]);
    const res = await supportInboxService.list({ limit: 1, status: "all", cursor: "c0" });
    expect(m.conversation.findMany.mock.calls[0][0]).toMatchObject({ take: 2, cursor: { id: "c0" }, skip: 1 });
    expect(res.items).toHaveLength(1);
    expect(res.nextCursor).toBe("c2");
  });

  it("labels a vendor thread with role VENDOR and the store name, and serialises orderId", async () => {
    m.conversation.findMany.mockResolvedValue([baseConv({ type: "ADMIN_VENDOR", participantB: VENDOR.id, orderId: "ord-1" })]);
    m.order.findMany.mockResolvedValue([{ id: "ord-1", orderNumber: "EKI-77" }]);
    const res = await supportInboxService.list({ limit: 20, status: "all" });
    expect(res.items[0].counterparty).toMatchObject({ role: "VENDOR", storeName: "Vic Store", name: "Vic Store", vendorId: "vendor-1" });
    expect(res.items[0].orderId).toBe("ord-1");
    expect(res.items[0].orderNumber).toBe("EKI-77");
  });
});

describe("lifecycle", () => {
  const stub = (over: Record<string, unknown> = {}) => {
    m.conversation.findUnique.mockResolvedValue(baseConv(over));
    m.conversation.update.mockResolvedValue(baseConv(over));
  };

  it("close sets CLOSED/closedAt/closedById and audits with reason + before/after", async () => {
    stub();
    await supportInboxService.transition("close", "admin-1", "c1", "Issue resolved", { usedPermission: "support.mutate", ip: "1.1.1.1" } as any);
    expect(m.conversation.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: expect.objectContaining({ status: "CLOSED", closedById: "admin-1", closedAt: expect.any(Date) }) });
    const audit = m.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: "support.conversation.close", entityType: "Conversation", entityId: "c1", reason: "Issue resolved", permissionUsed: "support.mutate" });
    expect(audit.beforeState).toMatchObject({ status: "OPEN" });
  });

  it("closing an already closed thread is a 409", async () => {
    stub({ status: "CLOSED" });
    await expect(supportInboxService.transition("close", "admin-1", "c1", "again please")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reopen clears closed fields", async () => {
    stub({ status: "CLOSED", closedAt: new Date() });
    await supportInboxService.transition("reopen", "admin-1", "c1", "customer wrote");
    expect(m.conversation.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { status: "OPEN", closedAt: null, closedById: null } });
  });

  it("escalate stores the reason as the note; deescalate clears; both guard repeats", async () => {
    stub();
    await supportInboxService.transition("escalate", "admin-1", "c1", "Needs finance");
    expect(m.conversation.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: expect.objectContaining({ escalatedById: "admin-1", escalationNote: "Needs finance" }) });
    stub({ escalatedAt: new Date() });
    await expect(supportInboxService.transition("escalate", "admin-1", "c1", "twice please")).rejects.toMatchObject({ statusCode: 409 });
    await supportInboxService.transition("deescalate", "admin-1", "c1", "handled by finance");
    expect(m.conversation.update).toHaveBeenLastCalledWith({ where: { id: "c1" }, data: { escalatedAt: null, escalatedById: null, escalationNote: null } });
    stub();
    await expect(supportInboxService.transition("deescalate", "admin-1", "c1", "not escalated")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("404s for an ordinary buyer<->vendor conversation (not in the inbox)", async () => {
    m.conversation.findUnique.mockResolvedValue(baseConv({ type: "BUYER_VENDOR", participantA: BUYER.id, participantB: VENDOR.id }));
    m.user.findFirst.mockResolvedValue(null);
    await expect(supportInboxService.transition("close", "admin-1", "c1", "should not work")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.conversation.update).not.toHaveBeenCalled();
  });
});

describe("admin thread + reply", () => {
  it("admin listMessages includes internal notes (no isInternal filter)", async () => {
    m.conversation.findUnique.mockResolvedValue(baseConv());
    m.message.findMany.mockResolvedValue([{ id: "m1", senderId: "buyer-1", text: "hi", isInternal: false, attachments: [], readAt: null, createdAt: new Date() }]);
    await supportInboxService.listMessages("c1", { limit: 30 });
    expect(m.message.findMany.mock.calls[0][0].where).toEqual({ conversationId: "c1" });
  });

  it("internal note is audited as support.internal_note and not notified", async () => {
    m.conversation.findUnique.mockResolvedValue(baseConv());
    m.message.create.mockResolvedValue({ id: "n1", senderId: "admin-1", text: "note", isInternal: true });
    m.message.findUnique.mockResolvedValue({ id: "n1", senderId: "admin-1", text: "note", isInternal: true });
    m.user.findUnique.mockResolvedValue(ADMIN);
    await supportInboxService.sendReply("admin-1", "c1", { text: "note", attachments: [], isInternal: true });
    expect(m.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "support.internal_note" });
    expect(m.notification.create).not.toHaveBeenCalled();
  });
});

describe("retention sweep", () => {
  it("is a dry run by default: counts eligible, deletes nothing", async () => {
    m.conversation.findMany.mockResolvedValue([{ id: "old1" }, { id: "old2" }]);
    const now = new Date("2026-10-01T00:00:00Z");
    const res = await supportRetentionService.sweep(now);
    expect(res).toMatchObject({ dryRun: true, retentionDays: 730, eligible: 2, purged: 0 });
    expect(m.conversation.deleteMany).not.toHaveBeenCalled();
    const where = m.conversation.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ type: "SUPPORT", status: "CLOSED", escalatedAt: null });
    expect(where.closedAt.lt.getTime()).toBe(now.getTime() - 730 * 86400000);
  });

  it("purges only when enabled via the setting, with a floor of 90 days", async () => {
    m.adminPlatformSetting.findMany.mockResolvedValue([{ key: "SUPPORT_RETENTION_ENABLED", value: 1 }, { key: "SUPPORT_RETENTION_DAYS", value: 5 }]);
    m.conversation.findMany.mockResolvedValue([{ id: "old1" }]);
    m.conversation.deleteMany.mockResolvedValue({ count: 1 });
    const res = await supportRetentionService.sweep();
    expect(res).toMatchObject({ dryRun: false, retentionDays: 90, purged: 1 });
    expect(m.conversation.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old1"] } } });
  });

  it("skips conversations with pending reports", async () => {
    m.contentReport.findMany.mockResolvedValue([{ targetId: "mr" }]);
    m.message.findMany.mockResolvedValue([{ conversationId: "protected" }]);
    m.conversation.findMany.mockResolvedValue([]);
    await supportRetentionService.sweep();
    expect(m.conversation.findMany.mock.calls[0][0].where.id).toEqual({ notIn: ["protected"] });
  });
});
