/**
 * Scheduled broadcasts: only SCHEDULED items are mutable, a past/invalid time
 * is rejected, and runDue() has real claim semantics —
 *   SCHEDULED -> SENDING (atomic) -> SENT only AFTER delivery completed,
 * honours scheduledFor, never double-sends, and does nothing while the
 * emergency pause is on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => {
  const prisma: any = {
    scheduledCommunication: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    broadcast: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { prisma };
});
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("../lib/expo-push", () => ({ checkPushReceipts: vi.fn().mockResolvedValue({ checked: 0, invalidated: 0, errors: 0 }) }));
vi.mock("../modules/communications/comms-pause.service", () => ({
  commsPauseService: { isCommsPaused: vi.fn().mockResolvedValue(false) },
}));
vi.mock("../modules/admin/admin-communications.service", () => ({
  adminCommunicationsService: {
    normalizeInput: vi.fn((x) => ({ audience: "buyers", category: "marketing", wantsInApp: true, wantsPush: false, wantsEmail: false, subject: x.subject, body: x.body, channel: "in_app" })),
    executeBroadcast: vi.fn(),
    reconcileRecentBroadcasts: vi.fn().mockResolvedValue({ checked: 0, changed: 0 }),
  },
  audienceParamsOf: vi.fn(() => ({})),
  selectedChannels: vi.fn(() => ["in_app"]),
}));

import { prisma } from "../lib/prisma";
import { commsPauseService } from "../modules/communications/comms-pause.service";
import { adminCommunicationsService } from "../modules/admin/admin-communications.service";
import { scheduledCommunicationService } from "../modules/communications/scheduled-communication.service";

const m = prisma as any;
const execute = vi.mocked(adminCommunicationsService.executeBroadcast);
const paused = vi.mocked(commsPauseService.isCommsPaused);

const inputStub: any = { audience: "buyers", category: "marketing", wantsInApp: true, wantsPush: false, wantsEmail: false, subject: "s", body: "b", channel: "in_app" };
const future = () => new Date(Date.now() + 3600000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  paused.mockResolvedValue(false);
  m.$transaction.mockImplementation(async (cb: any) => cb(m));
  m.scheduledCommunication.updateMany.mockResolvedValue({ count: 1 });
  m.broadcast.updateMany.mockResolvedValue({ count: 1 });
});

describe("create — validation and paired Broadcast record", () => {
  it("rejects an invalid date, a past date and a missing reason", async () => {
    await expect(scheduledCommunicationService.create({ input: inputStub, reason: "Spring promo", scheduledFor: "nope", createdBy: "a" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(scheduledCommunicationService.create({ input: inputStub, reason: "Spring promo", scheduledFor: new Date(Date.now() - 60000).toISOString(), createdBy: "a" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(scheduledCommunicationService.create({ input: inputStub, reason: "x", scheduledFor: future(), createdBy: "a" })).rejects.toMatchObject({ statusCode: 400 });
    expect(m.broadcast.create).not.toHaveBeenCalled();
  });

  it("creates a SCHEDULED Broadcast and its schedule row together", async () => {
    m.broadcast.create.mockResolvedValue({ id: "b1" });
    m.scheduledCommunication.create.mockResolvedValue({ id: "s1", broadcastId: "b1" });
    await scheduledCommunicationService.create({ input: inputStub, reason: "Spring promo", scheduledFor: future(), createdBy: "admin-1" });
    expect(m.broadcast.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SCHEDULED" }) }));
    expect(m.scheduledCommunication.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SCHEDULED", broadcastId: "b1" }) }));
  });
});

describe("cancel / update — only SCHEDULED is mutable (atomic)", () => {
  it("404s cancel for a missing item", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue(null);
    await expect(scheduledCommunicationService.cancel("x")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to cancel an item a runner already claimed (updateMany matched nothing)", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "s1", status: "SENDING", broadcastId: "b1" });
    m.scheduledCommunication.updateMany.mockResolvedValue({ count: 0 });
    await expect(scheduledCommunicationService.cancel("s1")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("cancels the schedule and its Broadcast", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "s1", status: "SCHEDULED", broadcastId: "b1" });
    await scheduledCommunicationService.cancel("s1");
    expect(m.scheduledCommunication.updateMany).toHaveBeenCalledWith({ where: { id: "s1", status: "SCHEDULED" }, data: { status: "CANCELLED" } });
    expect(m.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "CANCELLED" } }));
  });

  it("update rejects a non-SCHEDULED item and a past time", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "s1", status: "SENT" });
    await expect(scheduledCommunicationService.update("s1", { subject: "n" })).rejects.toMatchObject({ statusCode: 400 });
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "s1", status: "SCHEDULED", broadcastId: "b1" });
    await expect(scheduledCommunicationService.update("s1", { scheduledFor: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("runDue — claim semantics", () => {
  const due = (over: Record<string, unknown> = {}) => ({ id: "s1", broadcastId: "b1", createdBy: "admin-1", scheduledFor: new Date(Date.now() - 1000), ...over });

  it("only selects items whose scheduledFor has passed", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([]);
    await scheduledCommunicationService.runDue();
    const where = m.scheduledCommunication.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("SCHEDULED");
    expect(where.scheduledFor.lte).toBeInstanceOf(Date);
  });

  it("does nothing at all while the emergency pause is on (nothing claimed, items stay SCHEDULED)", async () => {
    paused.mockResolvedValue(true);
    const r = await scheduledCommunicationService.runDue();
    expect(r).toMatchObject({ processed: 0, paused: true });
    expect(m.scheduledCommunication.findMany).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("skips an item another runner already claimed — never double-sends", async () => {
    m.scheduledCommunication.updateMany.mockResolvedValue({ count: 0 });
    m.scheduledCommunication.findMany.mockResolvedValue([due()]);
    const r = await scheduledCommunicationService.runDue();
    expect(execute).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
  });

  it("claims as SENDING first and marks SENT only AFTER delivery completes", async () => {
    const order: string[] = [];
    m.scheduledCommunication.findMany.mockResolvedValue([due()]);
    m.scheduledCommunication.updateMany.mockImplementation(async ({ data }: any) => {
      if (data.status === "SENDING") order.push("claim");
      return { count: 1 };
    });
    execute.mockImplementation(async () => { order.push("deliver"); return { status: "SENT" as any }; });
    m.scheduledCommunication.update.mockImplementation(async ({ data }: any) => { order.push(`final:${data.status}`); return {}; });

    const r = await scheduledCommunicationService.runDue();

    expect(order).toEqual(["claim", "deliver", "final:SENT"]);
    expect(r).toMatchObject({ processed: 1, sent: 1, failed: 0 });
  });

  it("marks FAILED with the real error when delivery throws, and the sweep continues", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([due({ id: "s1", broadcastId: "b1" }), due({ id: "s2", broadcastId: "b2" })]);
    execute.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ status: "SENT" as any });
    const r = await scheduledCommunicationService.runDue();
    expect(m.scheduledCommunication.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "FAILED", error: "boom" } });
    expect(r).toMatchObject({ processed: 2, sent: 1, failed: 1 });
  });

  it("a Broadcast that failed on every channel is FAILED, not SENT", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([due()]);
    execute.mockResolvedValue({ status: "FAILED" as any });
    m.broadcast.findUnique.mockResolvedValue({ error: "Email provider is not configured; nothing was sent." });
    const r = await scheduledCommunicationService.runDue();
    expect(m.scheduledCommunication.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "FAILED", error: "Email provider is not configured; nothing was sent." } });
    expect(r.failed).toBe(1);
  });

  it("reclaims a schedule stuck in SENDING as FAILED (never silently re-sent)", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([]);
    await scheduledCommunicationService.runDue();
    const first = m.scheduledCommunication.updateMany.mock.calls[0][0];
    expect(first.where.status).toBe("SENDING");
    expect(first.data.status).toBe("FAILED");
  });
});
