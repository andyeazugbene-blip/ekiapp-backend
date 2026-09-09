/**
 * adminDashboardService.listAuditLogs — Phase 9 added an entityId filter
 * so admin-web can scope the activity log to a single campaign (or any
 * other entity) instead of only filtering by entityType. This covers the
 * filter-building logic directly; the endpoint itself already goes through
 * requireAdminPermission("audit.read") like every other admin route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminDashboardService } from "../modules/admin/admin-dashboard.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  m.auditLog.findMany.mockResolvedValue([]);
  m.user.findMany.mockResolvedValue([]);
});

describe("adminDashboardService.listAuditLogs", () => {
  it("filters by entityId when provided", async () => {
    await adminDashboardService.listAuditLogs({ entityType: "CommunityCampaign", entityId: "camp-1", limit: 50 });
    expect(m.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ entityType: "CommunityCampaign", entityId: "camp-1" }) }),
    );
  });

  it("omits entityId from the where-clause when not provided", async () => {
    await adminDashboardService.listAuditLogs({ entityType: "CommunityCampaign", limit: 50 });
    const call = m.auditLog.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty("entityId");
  });

  it("combines actorId, action, entityType and entityId together", async () => {
    await adminDashboardService.listAuditLogs({ actorId: "admin-1", action: "community_campaign.cancel", entityType: "CommunityCampaign", entityId: "camp-1", limit: 50 });
    expect(m.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actorId: "admin-1", action: "community_campaign.cancel", entityType: "CommunityCampaign", entityId: "camp-1" },
      }),
    );
  });
});
