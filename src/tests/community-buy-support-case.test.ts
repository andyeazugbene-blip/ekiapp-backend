import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn() },
    campaignParticipant: { findUnique: vi.fn() },
    communityBuySupportCase: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { supportCaseService } from "../modules/community-buy/support-case.service";

const m = vi.mocked(prisma, true);
const mNotify = vi.mocked(notificationsService, true);

beforeEach(() => {
  vi.clearAllMocks();
});

function campaignWith(organiserUserId: string, supplierUserId: string) {
  return {
    id: "camp-1",
    organiser: { userId: organiserUserId },
    supplier: { vendor: { userId: supplierUserId } },
  } as never;
}

describe("supportCaseService.create — real relationship required", () => {
  it("throws 404 when the campaign doesn't exist", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(null);
    await expect(
      supportCaseService.create("user-1", "camp-x", { caseType: "OTHER", description: "help" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 400 when description is blank", async () => {
    await expect(
      supportCaseService.create("user-1", "camp-1", { caseType: "OTHER", description: "   " }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(m.communityCampaign.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a user with no relationship to the campaign (not organiser, supplier, or participant)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(campaignWith("organiser-user", "supplier-user"));
    m.campaignParticipant.findUnique.mockResolvedValue(null);
    await expect(
      supportCaseService.create("stranger-1", "camp-1", { caseType: "OTHER", description: "help" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.communityBuySupportCase.create).not.toHaveBeenCalled();
  });

  it("allows the campaign's organiser to open a case", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(campaignWith("organiser-user", "supplier-user"));
    m.communityBuySupportCase.create.mockResolvedValue({ id: "case-1", internalNotes: null, description: "help" } as never);
    const result = await supportCaseService.create("organiser-user", "camp-1", { caseType: "FULFILMENT_ISSUE", description: "help" });
    expect(m.communityBuySupportCase.create).toHaveBeenCalled();
    expect(result).not.toHaveProperty("internalNotes");
  });

  it("allows the campaign's supplier vendor user to open a case", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(campaignWith("organiser-user", "supplier-user"));
    m.communityBuySupportCase.create.mockResolvedValue({ id: "case-1", internalNotes: null } as never);
    await supportCaseService.create("supplier-user", "camp-1", { caseType: "OTHER", description: "help" });
    expect(m.communityBuySupportCase.create).toHaveBeenCalled();
  });

  it("allows a real participant (buyer who contributed) to open a case", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(campaignWith("organiser-user", "supplier-user"));
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "p-1" } as never);
    m.communityBuySupportCase.create.mockResolvedValue({ id: "case-1", internalNotes: null } as never);
    await supportCaseService.create("buyer-1", "camp-1", { caseType: "PAYMENT_ISSUE", description: "help" });
    expect(m.communityBuySupportCase.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ campaignId: "camp-1", participantId: "buyer-1", caseType: "PAYMENT_ISSUE" }) }),
    );
  });
});

describe("supportCaseService — customer-safe reads never expose internalNotes", () => {
  it("listMine strips internalNotes from every case", async () => {
    m.communityBuySupportCase.findMany.mockResolvedValue([
      { id: "case-1", internalNotes: "sensitive admin note", description: "help" },
    ] as never);
    const result = await supportCaseService.listMine("buyer-1");
    expect(result[0]).not.toHaveProperty("internalNotes");
    expect(result[0]).toHaveProperty("description", "help");
  });

  it("getMine throws 404 for a case belonging to a different user", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "someone-else", internalNotes: null } as never);
    await expect(supportCaseService.getMine("buyer-1", "case-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("getMine strips internalNotes for the owning user", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "buyer-1", internalNotes: "secret", description: "help" } as never);
    const result = await supportCaseService.getMine("buyer-1", "case-1");
    expect(result).not.toHaveProperty("internalNotes");
  });
});

describe("supportCaseService.adminUpdate — every field independently settable, auditable via metadata at the controller layer", () => {
  it("throws 404 for a case that doesn't exist", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue(null);
    await expect(supportCaseService.adminUpdate("admin-1", "case-x", { status: "RESOLVED" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("sets resolvedById/resolvedAt when moving to RESOLVED", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1" } as never);
    m.communityBuySupportCase.update.mockResolvedValue({ status: "RESOLVED" } as never);
    await supportCaseService.adminUpdate("admin-1", "case-1", { status: "RESOLVED" });
    expect(m.communityBuySupportCase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RESOLVED", resolvedById: "admin-1" }) }),
    );
  });

  it("does not touch resolvedAt for a non-terminal status change", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1" } as never);
    m.communityBuySupportCase.update.mockResolvedValue({ status: "IN_PROGRESS" } as never);
    await supportCaseService.adminUpdate("admin-1", "case-1", { status: "IN_PROGRESS" });
    const call = m.communityBuySupportCase.update.mock.calls[0][0] as any;
    expect(call.data).not.toHaveProperty("resolvedAt");
  });

  it("sets escalatedAt when escalated is set to true", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1" } as never);
    m.communityBuySupportCase.update.mockResolvedValue({ escalated: true } as never);
    await supportCaseService.adminUpdate("admin-1", "case-1", { escalated: true });
    expect(m.communityBuySupportCase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ escalated: true, escalatedAt: expect.any(Date) }) }),
    );
  });

  it("can set internalNotes and customerVisibleResponse independently", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "buyer-1", campaignId: "camp-1", customerVisibleResponse: null } as never);
    m.communityBuySupportCase.update.mockResolvedValue({} as never);
    await supportCaseService.adminUpdate("admin-1", "case-1", { internalNotes: "checked with supplier", customerVisibleResponse: "We're looking into this." });
    expect(m.communityBuySupportCase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { internalNotes: "checked with supplier", customerVisibleResponse: "We're looking into this." } }),
    );
  });
});

/**
 * NOTIF-08 regression guard: a customer previously found out their support
 * case had a response only by manually reopening the app — no push, no
 * in-app row, no email was ever sent. Must fire exactly on a genuine
 * transition (new/changed response text), never on a no-op re-save, and
 * never for admin-only field changes (internalNotes, status, escalated)
 * that a customer has no visibility into anyway.
 */
describe("supportCaseService.adminUpdate — NOTIF-08: customer notified when a response is set", () => {
  it("notifies the reporter when customerVisibleResponse transitions from unset to set", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "buyer-1", campaignId: "camp-1", customerVisibleResponse: null } as never);
    m.communityBuySupportCase.update.mockResolvedValue({} as never);

    await supportCaseService.adminUpdate("admin-1", "case-1", { customerVisibleResponse: "We've issued your refund." });

    expect(mNotify.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "buyer-1",
        data: { type: "support_case_response", campaignId: "camp-1", caseId: "case-1" },
      }),
    );
  });

  it("notifies again when an already-answered case gets a CHANGED response", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "buyer-1", campaignId: "camp-1", customerVisibleResponse: "First answer." } as never);
    m.communityBuySupportCase.update.mockResolvedValue({} as never);

    await supportCaseService.adminUpdate("admin-1", "case-1", { customerVisibleResponse: "Updated answer." });

    expect(mNotify.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does NOT notify when customerVisibleResponse is re-saved with the identical text (no-op)", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "buyer-1", campaignId: "camp-1", customerVisibleResponse: "Same answer." } as never);
    m.communityBuySupportCase.update.mockResolvedValue({} as never);

    await supportCaseService.adminUpdate("admin-1", "case-1", { customerVisibleResponse: "Same answer." });

    expect(mNotify.enqueue).not.toHaveBeenCalled();
  });

  it("does NOT notify for admin-only field changes (status/internalNotes/escalated) with no customerVisibleResponse involved", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "buyer-1", campaignId: "camp-1", customerVisibleResponse: null } as never);
    m.communityBuySupportCase.update.mockResolvedValue({} as never);

    await supportCaseService.adminUpdate("admin-1", "case-1", { status: "IN_PROGRESS", internalNotes: "checking", escalated: true });

    expect(mNotify.enqueue).not.toHaveBeenCalled();
  });

  it("a notification failure does not roll back or fail the update", async () => {
    m.communityBuySupportCase.findUnique.mockResolvedValue({ id: "case-1", participantId: "buyer-1", campaignId: "camp-1", customerVisibleResponse: null } as never);
    m.communityBuySupportCase.update.mockResolvedValue({ id: "case-1" } as never);
    mNotify.enqueue.mockRejectedValueOnce(new Error("push provider down"));

    const result = await supportCaseService.adminUpdate("admin-1", "case-1", { customerVisibleResponse: "We're on it." });

    expect(result).toEqual({ id: "case-1" });
  });
});
