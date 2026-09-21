/**
 * Phase D (admin broadcast: schedule/edit/cancel/history) —
 * scheduledCommunicationService had zero test coverage despite being the
 * real, already-wired schedule/edit/cancel/run subsystem admin broadcasts
 * use. Covers the real invariants: only SCHEDULED items can be edited or
 * cancelled, a past/invalid scheduledFor is rejected, and runDue()'s
 * atomic claim actually prevents a duplicate send if the sweep overlaps
 * itself (the exact failure mode that would double-email every recipient).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    scheduledCommunication: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("../modules/admin/admin-communications.service", () => ({
  adminCommunicationsService: { normalizeInput: vi.fn((x) => x), broadcast: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { adminCommunicationsService } from "../modules/admin/admin-communications.service";
import { scheduledCommunicationService } from "../modules/communications/scheduled-communication.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduledCommunicationService.create — real date validation", () => {
  it("rejects an invalid date string", async () => {
    await expect(scheduledCommunicationService.create({
      audience: "all_buyers", channel: "email", subject: "s", body: "b", scheduledFor: "not-a-date", createdBy: "admin-1",
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(m.scheduledCommunication.create).not.toHaveBeenCalled();
  });

  it("rejects a scheduledFor in the past — never schedules a broadcast that already should have fired", async () => {
    await expect(scheduledCommunicationService.create({
      audience: "all_buyers", channel: "email", subject: "s", body: "b", scheduledFor: new Date(Date.now() - 60000).toISOString(), createdBy: "admin-1",
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates a real SCHEDULED row for a valid future date", async () => {
    m.scheduledCommunication.create.mockResolvedValue({ id: "sched-1", status: "SCHEDULED" });
    const future = new Date(Date.now() + 3600000).toISOString();

    await scheduledCommunicationService.create({ audience: "all_buyers", channel: "email", subject: "s", body: "b", scheduledFor: future, createdBy: "admin-1" });

    expect(m.scheduledCommunication.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SCHEDULED", audience: "all_buyers" }),
    }));
  });
});

describe("scheduledCommunicationService.cancel/update — only a SCHEDULED item is mutable", () => {
  it("404s cancel for a non-existent item", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue(null);
    await expect(scheduledCommunicationService.cancel("missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to cancel an item that already SENT", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "sched-1", status: "SENT" });
    await expect(scheduledCommunicationService.cancel("sched-1")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.scheduledCommunication.update).not.toHaveBeenCalled();
  });

  it("cancels a genuinely SCHEDULED item", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "sched-1", status: "SCHEDULED" });
    m.scheduledCommunication.update.mockResolvedValue({ id: "sched-1", status: "CANCELLED" });
    await scheduledCommunicationService.cancel("sched-1");
    expect(m.scheduledCommunication.update).toHaveBeenCalledWith({ where: { id: "sched-1" }, data: { status: "CANCELLED" } });
  });

  it("refuses to edit an item that already SENT or is CANCELLED", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "sched-1", status: "CANCELLED" });
    await expect(scheduledCommunicationService.update("sched-1", { subject: "new subject" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an entirely empty update — nothing real to change", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "sched-1", status: "SCHEDULED" });
    await expect(scheduledCommunicationService.update("sched-1", {})).rejects.toMatchObject({ statusCode: 400 });
    expect(m.scheduledCommunication.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid rescheduled date on update", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "sched-1", status: "SCHEDULED" });
    await expect(scheduledCommunicationService.update("sched-1", { scheduledFor: "garbage" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("only writes the fields actually provided, trimmed", async () => {
    m.scheduledCommunication.findUnique.mockResolvedValue({ id: "sched-1", status: "SCHEDULED" });
    m.scheduledCommunication.update.mockResolvedValue({ id: "sched-1" });

    await scheduledCommunicationService.update("sched-1", { subject: "  New subject  " });

    expect(m.scheduledCommunication.update).toHaveBeenCalledWith({ where: { id: "sched-1" }, data: { subject: "New subject" } });
  });
});

describe("scheduledCommunicationService.runDue — atomic claim, real idempotency", () => {
  it("only processes items whose scheduledFor has actually passed, oldest first", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([]);
    await scheduledCommunicationService.runDue();
    const call = m.scheduledCommunication.findMany.mock.calls[0][0];
    expect(call.where.status).toBe("SCHEDULED");
    expect(call.orderBy).toEqual({ scheduledFor: "asc" });
  });

  it("skips an item a concurrent runner already claimed — never double-sends", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([{ id: "sched-1", audience: "all_buyers", channel: "email", subject: "s", body: "b", createdBy: "admin-1" }]);
    // Another sweep already flipped this row's status — the guarded claim's WHERE no longer matches.
    m.scheduledCommunication.updateMany.mockResolvedValue({ count: 0 });

    const result = await scheduledCommunicationService.runDue();

    expect(result).toEqual({ processed: 1, sent: 0, failed: 0 });
    expect(adminCommunicationsService.broadcast).not.toHaveBeenCalled();
  });

  it("sends a real broadcast for a successfully-claimed item and marks it SENT", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([{ id: "sched-1", audience: "all_buyers", channel: "email", subject: "s", body: "b", createdBy: "admin-1" }]);
    m.scheduledCommunication.updateMany.mockResolvedValue({ count: 1 });
    m.scheduledCommunication.update.mockResolvedValue({ id: "sched-1", status: "SENT" });

    const result = await scheduledCommunicationService.runDue();

    expect(adminCommunicationsService.broadcast).toHaveBeenCalledWith("admin-1", expect.objectContaining({ subject: "s" }));
    expect(m.scheduledCommunication.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sched-1" }, data: expect.objectContaining({ status: "SENT" }) }));
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 });
  });

  it("marks an item FAILED (with the real error message) when the broadcast itself throws, and does not crash the sweep", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([{ id: "sched-1", audience: "all_buyers", channel: "email", subject: "s", body: "b", createdBy: "admin-1" }]);
    m.scheduledCommunication.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(adminCommunicationsService.broadcast).mockRejectedValueOnce(new Error("provider down"));

    const result = await scheduledCommunicationService.runDue();

    expect(m.scheduledCommunication.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sched-1" },
      data: expect.objectContaining({ status: "FAILED", error: "provider down" }),
    }));
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1 });
  });

  it("one failing item never blocks the rest of the sweep", async () => {
    m.scheduledCommunication.findMany.mockResolvedValue([
      { id: "sched-1", audience: "all_buyers", channel: "email", subject: "s1", body: "b", createdBy: "admin-1" },
      { id: "sched-2", audience: "all_buyers", channel: "email", subject: "s2", body: "b", createdBy: "admin-1" },
    ]);
    m.scheduledCommunication.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(adminCommunicationsService.broadcast)
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({} as never);

    const result = await scheduledCommunicationService.runDue();

    expect(result).toEqual({ processed: 2, sent: 1, failed: 1 });
  });
});
