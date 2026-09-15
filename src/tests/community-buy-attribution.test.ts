/**
 * M7 — organiser acquisition attribution (spec §14.5/§15.2, AT-45/AT-46).
 * Covers upsertParticipantWithAttribution()'s three branches (self-join,
 * reorder-retained, fresh acquisition), idempotency/duplicate-attribution
 * prevention, and the admin attribution-review flow (flag/resolve), which
 * must never auto-divert a reward to a different organiser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    campaignParticipant: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { upsertParticipantWithAttribution, attributionReviewService } from "../modules/community-buy/campaign-participant-attribution.service";

const m = vi.mocked(prisma, true);
const CAMPAIGN = { id: "camp-1", organiserId: "org-1" };

beforeEach(() => vi.clearAllMocks());

describe("upsertParticipantWithAttribution()", () => {
  it("is idempotent — an existing participant's attribution is never recomputed or overwritten", async () => {
    const existing = { id: "part-existing", campaignId: "camp-1", userId: "buyer-1", attributionSource: "DIRECT_JOIN" };
    m.campaignParticipant.findUnique.mockResolvedValue(existing as any);

    const result = await upsertParticipantWithAttribution(CAMPAIGN, "buyer-1");

    expect(result).toBe(existing);
    expect(m.organiserProfile.findUnique).not.toHaveBeenCalled();
    expect(m.campaignParticipant.create).not.toHaveBeenCalled();
  });

  it("SELF — the joining user IS the campaign's own organiser: no acquisition credited", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue(null as any);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as any);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as any);

    await upsertParticipantWithAttribution(CAMPAIGN, "organiser-user-1");

    expect(m.campaignParticipant.findFirst).not.toHaveBeenCalled();
    expect(m.campaignParticipant.create).toHaveBeenCalledWith({
      data: { campaignId: "camp-1", userId: "organiser-user-1", attributionSource: "SELF" },
    });
  });

  it("DIRECT_JOIN — no prior unexpired acquisition from this organiser: a fresh 12-month window starting now", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue(null as any);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as any);
    m.campaignParticipant.findFirst.mockResolvedValue(null as any);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-1" } as any);

    const before = Date.now();
    await upsertParticipantWithAttribution(CAMPAIGN, "buyer-1");

    expect(m.campaignParticipant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "buyer-1", acquisitionOrganiserId: "org-1" }) }),
    );
    const createCall = m.campaignParticipant.create.mock.calls[0][0] as any;
    expect(createCall.data.acquisitionOrganiserId).toBe("org-1");
    expect(createCall.data.acquisitionCampaignId).toBe("camp-1");
    expect(createCall.data.attributionSource).toBe("DIRECT_JOIN");
    expect(createCall.data.repeatCampaignParentId).toBeUndefined();
    expect(createCall.data.acquiredAt.getTime()).toBeGreaterThanOrEqual(before);
    const expiresAt = createCall.data.organiserAttributionExpiresAt as Date;
    const twelveMonthsMs = 300 * 24 * 60 * 60 * 1000; // conservative lower bound
    expect(expiresAt.getTime() - createCall.data.acquiredAt.getTime()).toBeGreaterThan(twelveMonthsMs);
  });

  it("REORDER_RETAINED (AT-45) — an unexpired prior acquisition from the SAME organiser is retained unchanged, not refreshed", async () => {
    const originalAcquiredAt = new Date("2026-01-01T00:00:00.000Z");
    const originalExpiresAt = new Date("2027-01-01T00:00:00.000Z");
    const priorParticipation = {
      id: "part-original",
      acquisitionOrganiserId: "org-1",
      acquisitionCampaignId: "camp-0",
      acquiredAt: originalAcquiredAt,
      organiserAttributionExpiresAt: originalExpiresAt,
    };
    m.campaignParticipant.findUnique.mockResolvedValue(null as any);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as any);
    m.campaignParticipant.findFirst.mockResolvedValue(priorParticipation as any);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-2" } as any);

    await upsertParticipantWithAttribution({ id: "camp-2", organiserId: "org-1" }, "buyer-1");

    expect(m.campaignParticipant.create).toHaveBeenCalledWith({
      data: {
        campaignId: "camp-2",
        userId: "buyer-1",
        acquisitionOrganiserId: "org-1",
        acquisitionCampaignId: "camp-0", // the ORIGINAL campaign, not this reorder's campaign
        acquiredAt: originalAcquiredAt, // unchanged — never refreshed by a reorder
        organiserAttributionExpiresAt: originalExpiresAt, // unchanged
        attributionSource: "REORDER_RETAINED",
        repeatCampaignParentId: "part-original",
      },
    });
  });

  it("AT-46 — an independent join of a DIFFERENT organiser's campaign attributes fresh to the new organiser, even with an active attribution elsewhere", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue(null as any);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-2", userId: "organiser-user-2" } as any);
    // findFirst is scoped to acquisitionOrganiserId=org-2 — a real prior
    // acquisition from a DIFFERENT organiser (org-1) must never match.
    m.campaignParticipant.findFirst.mockResolvedValue(null as any);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-3" } as any);

    await upsertParticipantWithAttribution({ id: "camp-9", organiserId: "org-2" }, "buyer-1");

    expect(m.campaignParticipant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ acquisitionOrganiserId: "org-2" }) }),
    );
    const createCall = m.campaignParticipant.create.mock.calls[0][0] as any;
    expect(createCall.data.acquisitionOrganiserId).toBe("org-2");
    expect(createCall.data.attributionSource).toBe("DIRECT_JOIN");
  });

  it("an expired prior acquisition from the same organiser is treated as a fresh acquisition, not a retention", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue(null as any);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as any);
    // The query itself filters organiserAttributionExpiresAt > now, so an
    // expired row is never returned by a correct implementation.
    m.campaignParticipant.findFirst.mockResolvedValue(null as any);
    m.campaignParticipant.create.mockResolvedValue({ id: "part-4" } as any);

    await upsertParticipantWithAttribution(CAMPAIGN, "buyer-1");

    const call = m.campaignParticipant.findFirst.mock.calls[0][0] as any;
    expect(call.where.organiserAttributionExpiresAt).toEqual({ gt: expect.any(Date) });
  });

  it("duplicate attribution prevention — a lost create race falls back to the winner's already-created row instead of creating a second one", async () => {
    m.campaignParticipant.findUnique.mockResolvedValueOnce(null as any).mockResolvedValueOnce({ id: "part-winner" } as any);
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" } as any);
    m.campaignParticipant.findFirst.mockResolvedValue(null as any);
    m.campaignParticipant.create.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    m.campaignParticipant.findUniqueOrThrow.mockResolvedValue({ id: "part-winner" } as any);

    const result = await upsertParticipantWithAttribution(CAMPAIGN, "buyer-1");
    expect(result).toEqual({ id: "part-winner" });
  });
});

describe("attributionReviewService — admin investigation flow (spec §14.5: 'do not auto-divert rewards')", () => {
  it("flagForReview() moves ACTIVE -> UNDER_REVIEW with a reason, audited", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1", attributionStatus: "ACTIVE" } as any);
    m.campaignParticipant.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignParticipant.findUniqueOrThrow.mockResolvedValue({ id: "part-1", attributionStatus: "UNDER_REVIEW" } as any);

    const result = await attributionReviewService.flagForReview("admin-1", "part-1", "supplier appears to be copying organiser's participant list");
    expect(result.attributionStatus).toBe("UNDER_REVIEW");
    expect(m.auditLog.create).toHaveBeenCalled();
  });

  it("flagForReview() refuses an already-invalidated attribution", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1", attributionStatus: "INVALIDATED" } as any);
    await expect(attributionReviewService.flagForReview("admin-1", "part-1", "reason")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.campaignParticipant.updateMany).not.toHaveBeenCalled();
  });

  it("resolveReview(CONFIRMED_VALID) restores ACTIVE — a false alarm", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1", attributionStatus: "UNDER_REVIEW" } as any);
    m.campaignParticipant.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignParticipant.findUniqueOrThrow.mockResolvedValue({ id: "part-1", attributionStatus: "ACTIVE" } as any);

    const result = await attributionReviewService.resolveReview("admin-1", "part-1", "CONFIRMED_VALID", "checked — legitimate reorder");
    expect(result.attributionStatus).toBe("ACTIVE");
  });

  it("resolveReview(INVALIDATED) never reassigns acquisitionOrganiserId to a different organiser — it only invalidates", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1", attributionStatus: "UNDER_REVIEW", acquisitionOrganiserId: "org-1" } as any);
    m.campaignParticipant.updateMany.mockResolvedValue({ count: 1 } as any);
    m.campaignParticipant.findUniqueOrThrow.mockResolvedValue({ id: "part-1", attributionStatus: "INVALIDATED", acquisitionOrganiserId: "org-1" } as any);

    await attributionReviewService.resolveReview("admin-1", "part-1", "INVALIDATED", "confirmed solicitation");

    const updateCall = m.campaignParticipant.updateMany.mock.calls[0][0] as any;
    expect(updateCall.data).not.toHaveProperty("acquisitionOrganiserId");
    expect(updateCall.data.attributionStatus).toBe("INVALIDATED");
  });

  it("resolveReview() refuses when the attribution isn't currently under review", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1", attributionStatus: "ACTIVE" } as any);
    await expect(attributionReviewService.resolveReview("admin-1", "part-1", "INVALIDATED", "reason")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a lost race on the guarded resolve claim refuses rather than double-applying", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1", attributionStatus: "UNDER_REVIEW" } as any);
    m.campaignParticipant.updateMany.mockResolvedValue({ count: 0 } as any);
    await expect(attributionReviewService.resolveReview("admin-1", "part-1", "CONFIRMED_VALID", "reason")).rejects.toMatchObject({ statusCode: 409 });
  });
});
