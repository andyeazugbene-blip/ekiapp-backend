/**
 * User-generated content: block + report (Apple App Review Guideline 1.2
 * "User-Generated Content" — apps with messaging must include a real
 * mechanism to report content and the ability to block abusive users).
 * These prove block is enforced SERVER-SIDE, in both directions, not just
 * hidden in the UI — a blocked party genuinely cannot open a new
 * conversation with the blocker, or vice versa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    conversation: { findUnique: vi.fn(), create: vi.fn() },
    userBlock: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    contentReport: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    order: { findUnique: vi.fn() },
  },
}));

vi.mock("../lib/push-notifications", () => ({
  pushNotifications: { newMessage: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { messagesService } from "../modules/messages/messages.service";
import * as reportsService from "../modules/reports/reports.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("Block enforcement is real and bidirectional (server-side, not UI-only)", () => {
  const buyer = { id: "buyer-1", name: "Buyer One", role: "BUYER" as const, vendor: null };
  const vendorUser = { id: "vendor-user-1", name: "Vendor One", role: "VENDOR" as const, vendor: { id: "vendor-1", storeName: "Test Store" } };

  it("a buyer who blocked the vendor cannot start a new conversation with them", async () => {
    m.user.findUnique.mockResolvedValueOnce(buyer as never).mockResolvedValueOnce(vendorUser as never);
    // buyer-1 has blocked vendor-user-1
    m.userBlock.findUnique.mockImplementation(({ where }: any) => {
      const { blockerId, blockedId } = where.blockerId_blockedId;
      return Promise.resolve(blockerId === "buyer-1" && blockedId === "vendor-user-1" ? { blockerId, blockedId } : null);
    });

    await expect(
      messagesService.createConversation("buyer-1", { participantId: "vendor-user-1" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.conversation.create).not.toHaveBeenCalled();
  });

  it("a vendor who was blocked by the buyer cannot start a new conversation with that buyer either", async () => {
    m.user.findUnique.mockResolvedValueOnce(vendorUser as never).mockResolvedValueOnce(buyer as never);
    // buyer-1 has blocked vendor-user-1 — vendor-user-1 initiating instead must be blocked too.
    m.userBlock.findUnique.mockImplementation(({ where }: any) => {
      const { blockerId, blockedId } = where.blockerId_blockedId;
      return Promise.resolve(blockerId === "buyer-1" && blockedId === "vendor-user-1" ? { blockerId, blockedId } : null);
    });

    await expect(
      messagesService.createConversation("vendor-user-1", { participantId: "buyer-1" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.conversation.create).not.toHaveBeenCalled();
  });

  it("with no block in either direction, the block checks never reject and creation is actually attempted", async () => {
    m.user.findUnique.mockResolvedValueOnce(buyer as never).mockResolvedValueOnce(vendorUser as never);
    m.userBlock.findUnique.mockResolvedValue(null);
    m.conversation.findUnique.mockResolvedValueOnce(null); // no existing conversation
    m.conversation.create.mockResolvedValue({ id: "conv-1", participantA: "buyer-1", participantB: "vendor-user-1" } as never);

    // The service goes on to re-fetch/serialize the new conversation, which
    // needs more mocking than this test cares about — the real assertion
    // here is that block enforcement didn't reject the request at all.
    await messagesService.createConversation("buyer-1", { participantId: "vendor-user-1" }).catch(() => {});

    expect(m.conversation.create).toHaveBeenCalled();
  });
});

describe("reportsService.blockUser / isBlocked", () => {
  it("cannot block yourself", async () => {
    await expect(reportsService.blockUser("user-1", "user-1")).rejects.toThrow(/cannot block yourself/i);
  });

  it("isBlocked reflects the real UserBlock row, not a guess", async () => {
    m.userBlock.findUnique.mockResolvedValueOnce({ blockerId: "a", blockedId: "b" } as never);
    expect(await reportsService.isBlocked("a", "b")).toBe(true);

    m.userBlock.findUnique.mockResolvedValueOnce(null);
    expect(await reportsService.isBlocked("b", "a")).toBe(false);
  });
});

describe("reportsService.createReport — real dedup, no spam duplicate reports", () => {
  it("returns the existing pending report instead of creating a duplicate for the same reporter+target", async () => {
    m.contentReport.findFirst.mockResolvedValue({ id: "report-1", status: "PENDING" } as never);
    const result = await reportsService.createReport({ reporterId: "u1", targetType: "message", targetId: "msg-1", reason: "harassment" });
    expect(result).toEqual({ id: "report-1", status: "PENDING" });
    expect(m.contentReport.create).not.toHaveBeenCalled();
  });

  it("creates a real report when none exists yet", async () => {
    m.contentReport.findFirst.mockResolvedValue(null);
    m.contentReport.create.mockResolvedValue({ id: "report-2" } as never);
    await reportsService.createReport({ reporterId: "u1", targetType: "message", targetId: "msg-2", reason: "spam" });
    expect(m.contentReport.create).toHaveBeenCalledWith({ data: expect.objectContaining({ reporterId: "u1", targetType: "message" }) });
  });
});

describe("reportsService.listReports — real moderation queue, enriched with the reporter's identity", () => {
  it("attaches the real reporter name/email so a moderator isn't looking at bare user ids", async () => {
    m.contentReport.findMany.mockResolvedValue([
      { id: "report-1", reporterId: "u1", targetType: "message", targetId: "msg-1", reason: "harassment", status: "PENDING" },
    ] as never);
    m.user.findMany.mockResolvedValue([{ id: "u1", name: "Real Reporter", email: "reporter@example.com" }] as never);

    const result = await reportsService.listReports();

    expect(result[0]).toEqual(
      expect.objectContaining({ reporter: { id: "u1", name: "Real Reporter", email: "reporter@example.com" } }),
    );
  });

  it("never fabricates a reporter — null when the user record genuinely can't be found", async () => {
    m.contentReport.findMany.mockResolvedValue([
      { id: "report-1", reporterId: "deleted-user", targetType: "message", targetId: "msg-1", reason: "spam", status: "PENDING" },
    ] as never);
    m.user.findMany.mockResolvedValue([] as never);

    const result = await reportsService.listReports();

    expect(result[0].reporter).toBeNull();
  });
});
