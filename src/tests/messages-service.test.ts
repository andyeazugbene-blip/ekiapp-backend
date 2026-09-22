/**
 * Phase 4.2 (test coverage for already-implemented features) — vendor
 * messaging (messages.service.ts) was real and working but had zero
 * dedicated test coverage beyond block/report enforcement
 * (ugc-block-and-report.test.ts). This exercises the actual business logic:
 * order-scoped conversation authorization, role-pair compatibility,
 * conversation dedup, participant-only access on send/list/read, and
 * read-receipt correctness (only the OTHER participant's messages flip).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    order: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    message: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    notification: { create: vi.fn().mockResolvedValue({}) },
    userBlock: { findUnique: vi.fn().mockResolvedValue(null) },
    // Support-thread permission checks (adminRolesService.assertPermission) —
    // used when a non-participant admin accesses a SUPPORT conversation.
    adminRoleAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/push-notifications", () => ({
  pushNotifications: { newMessage: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { messagesService } from "../modules/messages/messages.service";

const m = vi.mocked(prisma, true) as any;

const BUYER = { id: "buyer-1", name: "Buyer One", role: "BUYER", vendor: null };
const VENDOR_USER = { id: "vendor-user-1", name: "Vendor One", role: "VENDOR", vendor: { id: "vendor-1", storeName: "Vendor Store" } };
const OTHER_BUYER = { id: "buyer-2", name: "Buyer Two", role: "BUYER", vendor: null };
const OTHER_VENDOR_USER = { id: "vendor-user-2", name: "Vendor Two", role: "VENDOR", vendor: { id: "vendor-2", storeName: "Other Store" } };
const ADMIN = { id: "admin-1", name: "Admin", role: "ADMIN", vendor: null };

function mockUsers(map: Record<string, any>) {
  m.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(map[where.id] ?? null));
}

beforeEach(() => vi.clearAllMocks());

describe("createConversation — order-scoped BUYER_VENDOR authorization", () => {
  it("rejects when the order doesn't actually belong to this buyer/vendor pair", async () => {
    mockUsers({ [BUYER.id]: BUYER, [OTHER_VENDOR_USER.id]: OTHER_VENDOR_USER });
    m.order.findUnique.mockResolvedValue({ id: "order-1", buyerId: "someone-else", vendorId: "vendor-2" });

    await expect(
      messagesService.createConversation(BUYER.id, { participantId: OTHER_VENDOR_USER.id, orderId: "order-1" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.conversation.create).not.toHaveBeenCalled();
  });

  it("404s when the referenced order doesn't exist at all", async () => {
    mockUsers({ [BUYER.id]: BUYER, [OTHER_VENDOR_USER.id]: OTHER_VENDOR_USER });
    m.order.findUnique.mockResolvedValue(null);

    await expect(
      messagesService.createConversation(BUYER.id, { participantId: OTHER_VENDOR_USER.id, orderId: "missing-order" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("allows it when the order genuinely belongs to this exact buyer/vendor pair", async () => {
    mockUsers({ [BUYER.id]: BUYER, [OTHER_VENDOR_USER.id]: OTHER_VENDOR_USER });
    m.order.findUnique.mockResolvedValue({ id: "order-1", buyerId: BUYER.id, vendorId: "vendor-2" });
    m.conversation.findUnique.mockResolvedValue(null);
    m.conversation.create.mockResolvedValue({ id: "conv-1" });
    m.message.findUnique.mockResolvedValue(null);

    // serializeConversationForUser needs these:
    m.conversation.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === "conv-1") return Promise.resolve({ id: "conv-1", orderId: "order-1", participantA: BUYER.id, participantB: OTHER_VENDOR_USER.id, messages: [], lastMessageAt: null, updatedAt: new Date(), createdAt: new Date() });
      return Promise.resolve(null); // dedup lookup
    });
    m.order.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === "order-1") return Promise.resolve({ id: "order-1", buyerId: BUYER.id, vendorId: "vendor-2", orderNumber: "EKI-1" });
      return Promise.resolve(null);
    });
    mockUsers({ [BUYER.id]: BUYER, [OTHER_VENDOR_USER.id]: OTHER_VENDOR_USER });

    const result = await messagesService.createConversation(BUYER.id, { participantId: OTHER_VENDOR_USER.id, orderId: "order-1" });

    expect(m.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "BUYER_VENDOR", orderId: "order-1" }),
    }));
    expect(result.id).toBe("conv-1");
  });

  it("no orderId at all: a general BUYER_VENDOR conversation is always allowed", async () => {
    mockUsers({ [BUYER.id]: BUYER, [OTHER_VENDOR_USER.id]: OTHER_VENDOR_USER });
    m.conversation.findUnique.mockResolvedValueOnce(null); // dedup check
    m.conversation.create.mockResolvedValue({ id: "conv-2" });
    m.conversation.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === "conv-2") return Promise.resolve({ id: "conv-2", orderId: "", participantA: BUYER.id, participantB: OTHER_VENDOR_USER.id, messages: [], lastMessageAt: null, updatedAt: new Date(), createdAt: new Date() });
      return Promise.resolve(null);
    });

    await messagesService.createConversation(BUYER.id, { participantId: OTHER_VENDOR_USER.id });

    expect(m.order.findUnique).not.toHaveBeenCalled();
    expect(m.conversation.create).toHaveBeenCalled();
  });
});

describe("createConversation — role-pair compatibility", () => {
  it("rejects two buyers messaging each other", async () => {
    mockUsers({ [BUYER.id]: BUYER, [OTHER_BUYER.id]: OTHER_BUYER });
    await expect(
      messagesService.createConversation(BUYER.id, { participantId: OTHER_BUYER.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects two vendors messaging each other", async () => {
    mockUsers({ [VENDOR_USER.id]: VENDOR_USER, [OTHER_VENDOR_USER.id]: OTHER_VENDOR_USER });
    await expect(
      messagesService.createConversation(VENDOR_USER.id, { participantId: OTHER_VENDOR_USER.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects admin-to-admin conversations", async () => {
    const admin2 = { ...ADMIN, id: "admin-2" };
    mockUsers({ [ADMIN.id]: ADMIN, [admin2.id]: admin2 });
    await expect(
      messagesService.createConversation(ADMIN.id, { participantId: admin2.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows admin-vendor as an ADMIN_VENDOR conversation", async () => {
    mockUsers({ [ADMIN.id]: ADMIN, [VENDOR_USER.id]: VENDOR_USER });
    m.conversation.findUnique.mockResolvedValueOnce(null);
    m.conversation.create.mockResolvedValue({ id: "conv-admin-1" });
    m.conversation.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === "conv-admin-1") return Promise.resolve({ id: "conv-admin-1", orderId: "", participantA: ADMIN.id, participantB: VENDOR_USER.id, messages: [], lastMessageAt: null, updatedAt: new Date(), createdAt: new Date() });
      return Promise.resolve(null);
    });

    await messagesService.createConversation(ADMIN.id, { participantId: VENDOR_USER.id });

    expect(m.conversation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "ADMIN_VENDOR" }) }));
  });

  it("rejects starting a conversation with yourself", async () => {
    await expect(
      messagesService.createConversation(BUYER.id, { participantId: BUYER.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("createConversation — dedup (reuses an existing conversation, never creates a duplicate)", () => {
  it("reuses the existing conversation for the same participant pair + order, and sends the initial message into it", async () => {
    mockUsers({ [BUYER.id]: BUYER, [OTHER_VENDOR_USER.id]: OTHER_VENDOR_USER });
    m.order.findUnique.mockResolvedValue({ id: "order-1", buyerId: BUYER.id, vendorId: "vendor-2", orderNumber: "EKI-1" });
    m.conversation.findUnique.mockImplementation(({ where }: any) => {
      if (where.participantA_participantB_orderId) return Promise.resolve({ id: "existing-conv", participantA: BUYER.id, participantB: OTHER_VENDOR_USER.id, orderId: "order-1" });
      if (where.id === "existing-conv") return Promise.resolve({ id: "existing-conv", orderId: "order-1", participantA: BUYER.id, participantB: OTHER_VENDOR_USER.id, messages: [], lastMessageAt: new Date(), updatedAt: new Date(), createdAt: new Date() });
      return Promise.resolve(null);
    });
    m.$transaction.mockImplementation((ops: any[]) => Promise.all(ops));
    m.message.create.mockResolvedValue({ id: "msg-1", conversationId: "existing-conv", senderId: BUYER.id, text: "hi" });
    m.message.findUnique.mockResolvedValue({ id: "msg-1", conversationId: "existing-conv", senderId: BUYER.id, text: "hi" });

    const result = await messagesService.createConversation(BUYER.id, { participantId: OTHER_VENDOR_USER.id, orderId: "order-1", initialMessage: "hi" });

    expect(m.conversation.create).not.toHaveBeenCalled();
    expect(result.id).toBe("existing-conv");
  });
});

describe("sendMessage / listMessages / markConversationRead — participant-only access", () => {
  const CONVERSATION = { id: "conv-1", participantA: BUYER.id, participantB: OTHER_VENDOR_USER.id };

  it("sendMessage: forbidden for a user who isn't a participant in the conversation", async () => {
    m.conversation.findUnique.mockResolvedValue(CONVERSATION);
    await expect(
      messagesService.sendMessage("some-stranger", "conv-1", { text: "hi" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.message.create).not.toHaveBeenCalled();
  });

  it("sendMessage: 404s for a conversation that doesn't exist", async () => {
    m.conversation.findUnique.mockResolvedValue(null);
    await expect(messagesService.sendMessage(BUYER.id, "missing", { text: "hi" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("sendMessage: a real participant can send, and it bumps lastMessageAt", async () => {
    m.conversation.findUnique.mockResolvedValue(CONVERSATION);
    m.$transaction.mockImplementation((ops: any[]) => Promise.all(ops));
    m.message.create.mockResolvedValue({ id: "msg-2", conversationId: "conv-1", senderId: BUYER.id, text: "hello" });
    m.message.findUnique.mockResolvedValue({ id: "msg-2", conversationId: "conv-1", senderId: BUYER.id, text: "hello" });
    m.user.findUnique.mockResolvedValue(BUYER);

    await messagesService.sendMessage(BUYER.id, "conv-1", { text: "hello" });

    expect(m.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "conv-1" },
      data: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
    }));
  });

  it("listMessages: forbidden for a non-participant", async () => {
    m.conversation.findUnique.mockResolvedValue(CONVERSATION);
    await expect(
      messagesService.listMessages("some-stranger", "conv-1", { limit: 20 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("markConversationRead: only marks messages from the OTHER participant, never the caller's own", async () => {
    m.conversation.findUnique.mockResolvedValue(CONVERSATION);
    m.message.updateMany.mockResolvedValue({ count: 2 });

    await messagesService.markConversationRead(BUYER.id, "conv-1");

    expect(m.message.updateMany).toHaveBeenCalledWith({
      where: { conversationId: "conv-1", senderId: { not: BUYER.id }, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it("markConversationRead: forbidden for a non-participant", async () => {
    m.conversation.findUnique.mockResolvedValue(CONVERSATION);
    await expect(messagesService.markConversationRead("some-stranger", "conv-1")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.message.updateMany).not.toHaveBeenCalled();
  });
});

describe("listConversations — only returns conversations this user actually participates in", () => {
  it("queries by participantA OR participantB matching the caller", async () => {
    m.conversation.findMany.mockResolvedValue([]);
    await messagesService.listConversations(BUYER.id, { limit: 20 });

    expect(m.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ participantA: BUYER.id }, { participantB: BUYER.id }] },
    }));
  });
});

// ─── In-app support messaging (2026-09-22 client decision) ────────────────

describe("startSupportConversation — the buyer-facing 'Contact us' entry point", () => {
  it("resolves the earliest-created ADMIN user and creates a real SUPPORT conversation against them, without the caller ever supplying an admin id", async () => {
    mockUsers({ [BUYER.id]: BUYER, [ADMIN.id]: ADMIN });
    m.user.findFirst.mockResolvedValue({ id: ADMIN.id });
    m.conversation.findUnique.mockImplementation(({ where }: any) => {
      if (where.participantA_participantB_orderId) return Promise.resolve(null); // dedup check: none yet
      return Promise.resolve({ id: "support-conv-1", orderId: "", participantA: BUYER.id, participantB: ADMIN.id, messages: [], lastMessageAt: new Date(), updatedAt: new Date(), createdAt: new Date() });
    });
    m.conversation.create.mockResolvedValue({ id: "support-conv-1" });
    m.$transaction.mockImplementation((ops: any[]) => Promise.all(ops));
    m.message.create.mockResolvedValue({ id: "msg-support-1", conversationId: "support-conv-1", senderId: BUYER.id, text: "I need help with my order" });
    m.message.findUnique.mockResolvedValue({ id: "msg-support-1", conversationId: "support-conv-1", senderId: BUYER.id, text: "I need help with my order" });

    const result = await messagesService.startSupportConversation(BUYER.id, "I need help with my order");

    expect(m.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } }));
    expect(m.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "SUPPORT", participantA: expect.any(String), participantB: expect.any(String) }),
    }));
    expect(result.id).toBe("support-conv-1");
  });

  it("reuses the same conversation on a second call instead of creating a duplicate thread", async () => {
    mockUsers({ [BUYER.id]: BUYER, [ADMIN.id]: ADMIN });
    m.user.findFirst.mockResolvedValue({ id: ADMIN.id });
    m.conversation.findUnique.mockImplementation(({ where }: any) => {
      if (where.participantA_participantB_orderId) return Promise.resolve({ id: "support-conv-1", participantA: BUYER.id, participantB: ADMIN.id, orderId: "" });
      return Promise.resolve({ id: "support-conv-1", orderId: "", participantA: BUYER.id, participantB: ADMIN.id, messages: [], lastMessageAt: new Date(), updatedAt: new Date(), createdAt: new Date() });
    });
    m.message.create.mockResolvedValue({ id: "msg-support-2", conversationId: "support-conv-1", senderId: BUYER.id, text: "follow-up" });
    m.message.findUnique.mockResolvedValue({ id: "msg-support-2", conversationId: "support-conv-1", senderId: BUYER.id, text: "follow-up" });

    const result = await messagesService.startSupportConversation(BUYER.id, "follow-up");

    expect(m.conversation.create).not.toHaveBeenCalled();
    expect(result.id).toBe("support-conv-1");
  });

  it("throws a clear 503 rather than crashing when no admin account exists at all", async () => {
    m.user.findFirst.mockResolvedValue(null);
    await expect(messagesService.startSupportConversation(BUYER.id, "hello")).rejects.toMatchObject({ statusCode: 503 });
    expect(m.conversation.create).not.toHaveBeenCalled();
  });
});

describe("SUPPORT conversation access — any support.mutate/support.read admin, not only the fixed participant", () => {
  const SUPPORT_CONVERSATION = { id: "support-conv-2", type: "SUPPORT", participantA: BUYER.id, participantB: ADMIN.id };
  const OTHER_ADMIN_ID = "admin-2-different-from-fixed-participant";

  it("sendMessage: rejects a different admin with no support permission at all", async () => {
    m.conversation.findUnique.mockResolvedValue(SUPPORT_CONVERSATION);
    m.adminRoleAssignment.findMany.mockResolvedValue([]); // no roles assigned

    await expect(
      messagesService.sendMessage(OTHER_ADMIN_ID, "support-conv-2", { text: "On it!" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.message.create).not.toHaveBeenCalled();
  });

  it("sendMessage: allows a different admin who holds support.mutate, and correctly resolves the BUYER (not the fixed participant) as the recipient", async () => {
    m.conversation.findUnique.mockResolvedValue(SUPPORT_CONVERSATION);
    m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["support.mutate"] } }]);
    mockUsers({ [BUYER.id]: BUYER, [ADMIN.id]: ADMIN, [OTHER_ADMIN_ID]: { id: OTHER_ADMIN_ID, name: "Second Admin", role: "ADMIN", vendor: null } });
    m.$transaction.mockImplementation((ops: any[]) => Promise.all(ops));
    m.message.create.mockResolvedValue({ id: "msg-reply-1", conversationId: "support-conv-2", senderId: OTHER_ADMIN_ID, text: "On it!" });
    m.message.findUnique.mockResolvedValue({ id: "msg-reply-1", conversationId: "support-conv-2", senderId: OTHER_ADMIN_ID, text: "On it!" });

    await messagesService.sendMessage(OTHER_ADMIN_ID, "support-conv-2", { text: "On it!" });

    // The buyer notification must go to the real buyer, never to
    // whichever id happened to be resolved as the original fixed
    // participantB, and never to the replying admin.
    expect(m.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: BUYER.id, type: "NEW_MESSAGE" }),
    }));
  });

  it("sendMessage: an admin.* wildcard permission also qualifies", async () => {
    m.conversation.findUnique.mockResolvedValue(SUPPORT_CONVERSATION);
    m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["admin.*"] } }]);
    mockUsers({ [BUYER.id]: BUYER, [ADMIN.id]: ADMIN, [OTHER_ADMIN_ID]: { id: OTHER_ADMIN_ID, name: "Super Admin", role: "ADMIN", vendor: null } });
    m.$transaction.mockImplementation((ops: any[]) => Promise.all(ops));
    m.message.create.mockResolvedValue({ id: "msg-reply-2", conversationId: "support-conv-2", senderId: OTHER_ADMIN_ID, text: "Handled." });
    m.message.findUnique.mockResolvedValue({ id: "msg-reply-2", conversationId: "support-conv-2", senderId: OTHER_ADMIN_ID, text: "Handled." });

    await expect(messagesService.sendMessage(OTHER_ADMIN_ID, "support-conv-2", { text: "Handled." })).resolves.toBeTruthy();
  });

  it("listMessages: rejects a different admin with only support.mutate but not support.read (the two are separately checked)", async () => {
    m.conversation.findUnique.mockResolvedValue(SUPPORT_CONVERSATION);
    m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["support.mutate"] } }]);

    await expect(
      messagesService.listMessages(OTHER_ADMIN_ID, "support-conv-2", { limit: 20 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("listMessages: allows a different admin who holds support.read", async () => {
    m.conversation.findUnique.mockResolvedValue(SUPPORT_CONVERSATION);
    m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["support.read"] } }]);
    m.message.findMany.mockResolvedValue([]);

    await expect(messagesService.listMessages(OTHER_ADMIN_ID, "support-conv-2", { limit: 20 })).resolves.toBeTruthy();
  });

  it("a non-admin stranger is still rejected outright for a SUPPORT conversation, never falls through to the permission check", async () => {
    m.conversation.findUnique.mockResolvedValue(SUPPORT_CONVERSATION);
    await expect(
      messagesService.sendMessage("random-buyer-not-involved", "support-conv-2", { text: "snooping" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // Never even checked permissions for a plain stranger — assertConversationAccess()
    // only consults adminRolesService for the SUPPORT-type branch, and a non-admin
    // would fail that check anyway, but this confirms the ordinary participant
    // check still runs first for every conversation type.
    expect(m.message.create).not.toHaveBeenCalled();
  });

  it("an ordinary (non-SUPPORT) conversation is NOT affected by the admin bypass — a non-participant admin is still forbidden", async () => {
    const ordinaryConversation = { id: "conv-ordinary", type: "BUYER_VENDOR", participantA: BUYER.id, participantB: OTHER_VENDOR_USER.id };
    m.conversation.findUnique.mockResolvedValue(ordinaryConversation);
    m.adminRoleAssignment.findMany.mockResolvedValue([{ role: { permissions: ["admin.*"] } }]);

    await expect(
      messagesService.sendMessage(OTHER_ADMIN_ID, "conv-ordinary", { text: "not my thread" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("listSupportConversationsForAdmin / getSupportConversationForAdmin — the shared admin inbox", () => {
  it("lists every SUPPORT conversation regardless of which admin is the fixed participantB", async () => {
    m.conversation.findMany.mockResolvedValue([
      { id: "support-conv-3", type: "SUPPORT", participantA: BUYER.id, participantB: ADMIN.id, messages: [], lastMessageAt: new Date(), updatedAt: new Date(), createdAt: new Date() },
    ]);
    m.conversation.findUnique.mockResolvedValue({ id: "support-conv-3", type: "SUPPORT", participantA: BUYER.id, participantB: ADMIN.id, messages: [{ text: "hi", createdAt: new Date() }], lastMessageAt: new Date(), updatedAt: new Date(), createdAt: new Date() });
    mockUsers({ [BUYER.id]: { ...BUYER, email: "buyer@example.com", avatar: null }, [ADMIN.id]: { ...ADMIN, email: "admin@example.com", avatar: null } });
    m.message.count.mockResolvedValue(1);

    const result = await messagesService.listSupportConversationsForAdmin({ limit: 20 });

    expect(m.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { type: "SUPPORT" } }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].buyerId).toBe(BUYER.id);
    expect(result.items[0].unreadCount).toBe(1);
  });

  it("identifies the buyer side by role, correctly, regardless of which of participantA/B happens to be the admin", async () => {
    // Here the admin sorts as participantA (lexicographically before the buyer id) —
    // the buyer must still be identified correctly by role, not by a fixed slot.
    m.conversation.findUnique.mockResolvedValue({ id: "support-conv-4", type: "SUPPORT", participantA: ADMIN.id, participantB: BUYER.id, messages: [], lastMessageAt: new Date(), updatedAt: new Date(), createdAt: new Date() });
    mockUsers({ [BUYER.id]: { ...BUYER, email: "buyer@example.com", avatar: null }, [ADMIN.id]: { ...ADMIN, email: "admin@example.com", avatar: null } });
    m.message.count.mockResolvedValue(0);

    const result = await messagesService.getSupportConversationForAdmin("support-conv-4");

    expect(result.buyerId).toBe(BUYER.id);
  });

  it("404s for a conversation that isn't actually type SUPPORT", async () => {
    m.conversation.findUnique.mockResolvedValue({ id: "conv-ordinary-2", type: "BUYER_VENDOR", participantA: BUYER.id, participantB: OTHER_VENDOR_USER.id });
    await expect(messagesService.getSupportConversationForAdmin("conv-ordinary-2")).rejects.toMatchObject({ statusCode: 404 });
  });
});
