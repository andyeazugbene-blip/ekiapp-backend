/**
 * Organiser draft delete — communityCampaignsService.deleteDraft().
 *
 * Deliberately narrow: only the owning organiser, only DRAFT /
 * CHANGES_REQUIRED, and the delete itself is status-guarded in the WHERE
 * clause so a concurrent transition can't race it into deleting a campaign
 * that has since left draft. Mirrors the Prisma-mocked unit-test convention
 * used by the other community-buy service tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn(), deleteMany: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { trigger: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";

const m = vi.mocked(prisma, true) as any;

const draft = { id: "camp-1", organiserId: "org-1", title: "Rice Bulk Buy", status: "DRAFT" };

beforeEach(() => {
  vi.clearAllMocks();
  m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: false });
  m.communityCampaign.findUnique.mockResolvedValue(draft);
  m.communityCampaign.deleteMany.mockResolvedValue({ count: 1 });
});

describe("deleteDraft()", () => {
  it("deletes the organiser's own DRAFT, status-guarded, and records an audit entry", async () => {
    const result = await communityCampaignsService.deleteDraft("u1", "camp-1");

    expect(result).toEqual({ deleted: true, id: "camp-1" });
    expect(m.communityCampaign.deleteMany).toHaveBeenCalledWith({
      where: { id: "camp-1", status: { in: ["DRAFT", "CHANGES_REQUIRED"] } },
    });
    expect(m.auditLog.create).toHaveBeenCalledTimes(1);
    expect(m.auditLog.create.mock.calls[0][0].data).toMatchObject({
      actorId: "u1",
      action: "community_campaign.draft_deleted",
      entityType: "CommunityCampaign",
      entityId: "camp-1",
    });
  });

  it("also deletes a CHANGES_REQUIRED draft (sent back by admin, still a draft)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...draft, status: "CHANGES_REQUIRED" });
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).resolves.toMatchObject({ deleted: true });
  });

  it.each(["UNDER_REVIEW", "APPROVED", "REJECTED", "LIVE", "PAUSED", "RESCUE_WINDOW", "FULFILLING", "CANCELLED", "FAILED"])(
    "refuses to delete a %s campaign — never touches the database",
    async (status) => {
      m.communityCampaign.findUnique.mockResolvedValue({ ...draft, status });
      await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
      expect(m.communityCampaign.deleteMany).not.toHaveBeenCalled();
      expect(m.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("404s for a draft owned by a different organiser (no existence leak)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...draft, organiserId: "someone-else" });
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.communityCampaign.deleteMany).not.toHaveBeenCalled();
  });

  it("404s when the caller has no organiser profile at all", async () => {
    m.organiserProfile.findUnique.mockResolvedValue(null);
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.communityCampaign.deleteMany).not.toHaveBeenCalled();
  });

  it("404s on a repeat request once the draft is already gone (duplicate delete is harmless)", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(null);
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.communityCampaign.deleteMany).not.toHaveBeenCalled();
  });

  it("blocks a restricted organiser, same as every other campaign write", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1", isRestricted: true });
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.communityCampaign.deleteMany).not.toHaveBeenCalled();
  });

  it("409s when the status changed between the read and the guarded delete (deleteMany matched nothing)", async () => {
    m.communityCampaign.deleteMany.mockResolvedValue({ count: 0 });
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  it("409s (not 500) when a Restrict foreign key still references the draft", async () => {
    m.communityCampaign.deleteMany.mockRejectedValue(Object.assign(new Error("FK violation"), { code: "P2003" }));
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not swallow an unexpected database error", async () => {
    m.communityCampaign.deleteMany.mockRejectedValue(new Error("connection reset"));
    await expect(communityCampaignsService.deleteDraft("u1", "camp-1")).rejects.toThrow("connection reset");
  });
});
