/**
 * Phase 4 (cancellation under review) — focused tests for organiser-
 * initiated cancellation: the pre-payment vs already-captured-funds
 * routing decision, the CANCELLATION_UNDER_REVIEW state transition,
 * admin approve/reject, duplicate-approval/duplicate-refund protection,
 * and the "already paid out" block on approval. Mirrors the existing
 * Prisma-mocked unit-test convention (see community-buy.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    campaignCancellationRequest: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    campaignContribution: { count: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    campaignParticipant: { findMany: vi.fn() },
    campaignRefund: { create: vi.fn() },
    campaignSupplierPayment: { findUnique: vi.fn(), update: vi.fn() },
    communityBuyOrganiserPayout: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { trigger: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { communityCampaignsService } from "../modules/community-buy/community-campaigns.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  // Array-form $transaction (used by the no-financial-activity branch) —
  // resolves each already-invoked operation's mocked return value, same
  // shape real Prisma's array-transaction API returns.
  m.$transaction.mockImplementation(async (ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : ops));
  m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "u1" });
});

const baseCampaign = {
  id: "camp-1",
  organiserId: "org-1",
  title: "Rice Bulk Buy",
  status: "LIVE",
  currency: "GBP",
};

describe("requestCancellation() — routing decision (pre-payment vs already-captured)", () => {
  it("rejects when the caller doesn't own the campaign", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "someone-else" });

    await expect(communityCampaignsService.requestCancellation("u1", "camp-1", "changed my mind")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a missing/blank reason", async () => {
    await expect(communityCampaignsService.requestCancellation("u1", "camp-1", "   ")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.communityCampaign.findUnique).not.toHaveBeenCalled();
  });

  it("rejects when the campaign's status isn't in the requestable set", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "DRAFT" });

    await expect(communityCampaignsService.requestCancellation("u1", "camp-1", "changed my mind")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects when a cancellation request is already pending for this campaign", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignCancellationRequest.findFirst.mockResolvedValue({ id: "req-existing", status: "PENDING" });

    await expect(communityCampaignsService.requestCancellation("u1", "camp-1", "changed my mind")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("no PAID contributions — cancels immediately, no admin review needed", async () => {
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignCancellationRequest.findFirst.mockResolvedValue(null);
    m.campaignContribution.count.mockResolvedValue(0);
    m.communityCampaign.update.mockResolvedValue({ ...baseCampaign, status: "CANCELLED" });
    m.campaignCancellationRequest.create.mockResolvedValue({ id: "req-1", status: "APPROVED", hadFinancialActivity: false });
    m.campaignParticipant.findMany.mockResolvedValue([{ userId: "buyer-1" }]);

    const result = await communityCampaignsService.requestCancellation("u1", "camp-1", "changed my mind");

    expect(result.requiresReview).toBe(false);
    expect(result.campaign.status).toBe("CANCELLED");
    expect(m.communityCampaign.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
    expect(m.campaignCancellationRequest.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ hadFinancialActivity: false, status: "APPROVED" }) }));
    expect(m.campaignContribution.updateMany).toHaveBeenCalledWith({ where: { campaignId: "camp-1", status: "PLEDGED" }, data: { status: "CANCELLED" } });
    // Never routes through CANCELLATION_UNDER_REVIEW for this case.
    expect(m.communityCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("at least one PAID contribution — routes to CANCELLATION_UNDER_REVIEW and creates a PENDING request", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "FULFILLING" });
    m.campaignCancellationRequest.findFirst.mockResolvedValue(null);
    m.campaignContribution.count.mockResolvedValue(3);
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 });
    m.campaignCancellationRequest.create.mockResolvedValue({ id: "req-2", status: "PENDING", hadFinancialActivity: true });
    m.communityCampaign.findUniqueOrThrow.mockResolvedValue({ ...baseCampaign, status: "CANCELLATION_UNDER_REVIEW" });
    m.campaignParticipant.findMany.mockResolvedValue([{ userId: "buyer-1" }, { userId: "buyer-2" }]);

    const result = await communityCampaignsService.requestCancellation("u1", "camp-1", "supplier fell through");

    expect(result.requiresReview).toBe(true);
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith({ where: { id: "camp-1", status: "FULFILLING" }, data: { status: "CANCELLATION_UNDER_REVIEW" } });
    expect(m.campaignCancellationRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ hadFinancialActivity: true, preCancellationStatus: "FULFILLING", status: "PENDING" }),
    }));
    // Never directly cancels or touches pledges for this case — admin decides.
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
    expect(m.campaignContribution.updateMany).not.toHaveBeenCalled();
  });

  it("loses the atomic-claim race (status changed concurrently) — rejects instead of silently proceeding", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "SUCCEEDED" });
    m.campaignCancellationRequest.findFirst.mockResolvedValue(null);
    m.campaignContribution.count.mockResolvedValue(5);
    m.communityCampaign.updateMany.mockResolvedValue({ count: 0 });

    await expect(communityCampaignsService.requestCancellation("u1", "camp-1", "reason")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.campaignCancellationRequest.create).not.toHaveBeenCalled();
  });
});

describe("approveCancellation() — refund/reversal without double-processing", () => {
  const pendingRequest = {
    id: "req-2",
    campaignId: "camp-1",
    status: "PENDING",
    preCancellationStatus: "FULFILLING",
    campaign: { id: "camp-1", title: "Rice Bulk Buy", organiser: { userId: "organiser-user-1" }, participants: [{ userId: "buyer-1" }, { userId: "buyer-2" }] },
  };

  it("rejects an unknown request", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(null);
    await expect(communityCampaignsService.approveCancellation("admin-1", "missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("blocks approval when the supplier has already been paid — no clawback mechanism exists", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(pendingRequest);
    m.campaignSupplierPayment.findUnique.mockResolvedValue({ status: "PAID" });
    m.communityBuyOrganiserPayout.findUnique.mockResolvedValue(null);

    await expect(communityCampaignsService.approveCancellation("admin-1", "req-2")).rejects.toMatchObject({ code: "SUPPLIER_ALREADY_PAID" });
    expect(m.campaignCancellationRequest.updateMany).not.toHaveBeenCalled();
  });

  it("blocks approval when the organiser has already been paid — no clawback mechanism exists", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(pendingRequest);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.communityBuyOrganiserPayout.findUnique.mockResolvedValue({ status: "PAID" });

    await expect(communityCampaignsService.approveCancellation("admin-1", "req-2")).rejects.toMatchObject({ code: "ORGANISER_ALREADY_PAID" });
    expect(m.campaignCancellationRequest.updateMany).not.toHaveBeenCalled();
  });

  it("approves, creates refund records, holds any not-yet-paid supplier/organiser records, and transitions the campaign to CANCELLED", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(pendingRequest);
    m.campaignSupplierPayment.findUnique.mockResolvedValue({ status: "NOT_RELEASED" });
    m.communityBuyOrganiserPayout.findUnique.mockResolvedValue({ status: "NOT_RELEASED" });
    m.campaignCancellationRequest.updateMany.mockResolvedValue({ count: 1 });
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 });
    m.campaignContribution.findMany.mockResolvedValueOnce([{ id: "contrib-1", amount: 1000, buyerServiceFeeAmount: 50, currency: "GBP" }]);
    m.campaignRefund.create.mockResolvedValue({});
    m.campaignContribution.update.mockResolvedValue({});
    m.campaignSupplierPayment.update.mockResolvedValue({});
    m.communityBuyOrganiserPayout.update.mockResolvedValue({});
    m.campaignCancellationRequest.findUniqueOrThrow.mockResolvedValue({ id: "req-2", status: "APPROVED" });

    const result = await communityCampaignsService.approveCancellation("admin-1", "req-2");

    expect(result.status).toBe("APPROVED");
    expect(m.campaignCancellationRequest.updateMany).toHaveBeenCalledWith({ where: { id: "req-2", status: "PENDING" }, data: expect.objectContaining({ status: "APPROVED", reviewedById: "admin-1" }) });
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith({ where: { id: "camp-1", status: "CANCELLATION_UNDER_REVIEW" }, data: expect.objectContaining({ status: "CANCELLED" }) });
    // Refund creation reused verbatim — one CampaignRefund row per PAID contribution.
    expect(m.campaignRefund.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ contributionId: "contrib-1", amount: 1050, status: "REFUND_PENDING" }) }));
    // Both payout records placed on hold rather than left releasable.
    expect(m.campaignSupplierPayment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ON_HOLD" }) }));
    expect(m.communityBuyOrganiserPayout.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ON_HOLD" }) }));
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "organiser-user-1" }));
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "buyer-1" }));
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "buyer-2" }));
  });

  it("a second approval attempt on the same request is rejected — no duplicate refund creation", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(pendingRequest);
    m.campaignSupplierPayment.findUnique.mockResolvedValue(null);
    m.communityBuyOrganiserPayout.findUnique.mockResolvedValue(null);
    // Simulates the request having already been claimed by a concurrent/earlier call.
    m.campaignCancellationRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(communityCampaignsService.approveCancellation("admin-1", "req-2")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.campaignRefund.create).not.toHaveBeenCalled();
    expect(m.campaignSupplierPayment.update).not.toHaveBeenCalled();
  });

  it("rejects outright when the request is no longer PENDING (already APPROVED/REJECTED)", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue({ ...pendingRequest, status: "REJECTED" });

    await expect(communityCampaignsService.approveCancellation("admin-1", "req-2")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.campaignSupplierPayment.findUnique).not.toHaveBeenCalled();
  });

  it("createRefundRecordsForFailedCampaign() itself never creates a duplicate refund for the same contribution (existing idempotency, reused verbatim)", async () => {
    m.campaignContribution.findMany.mockResolvedValue([{ id: "contrib-9", amount: 500, buyerServiceFeeAmount: 20, currency: "GBP" }]);
    m.campaignRefund.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    m.campaignContribution.update.mockResolvedValue({});

    const created = await communityCampaignsService.createRefundRecordsForFailedCampaign("camp-1");

    // The P2002 (already-exists) branch is swallowed, not re-thrown, and
    // doesn't count as a newly-created refund.
    expect(created).toBe(0);
  });
});

describe("rejectCancellation() — restores the exact prior operational state", () => {
  const pendingRequest = {
    id: "req-3",
    campaignId: "camp-1",
    status: "PENDING",
    preCancellationStatus: "RESCUE_WINDOW",
    campaign: { id: "camp-1", title: "Rice Bulk Buy", organiser: { userId: "organiser-user-1" } },
  };

  it("rejects an unknown request", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(null);
    await expect(communityCampaignsService.rejectCancellation("admin-1", "missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("restores the campaign to preCancellationStatus and marks the request REJECTED", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(pendingRequest);
    m.campaignCancellationRequest.updateMany.mockResolvedValue({ count: 1 });
    m.communityCampaign.updateMany.mockResolvedValue({ count: 1 });
    m.campaignCancellationRequest.findUniqueOrThrow.mockResolvedValue({ id: "req-3", status: "REJECTED" });

    const result = await communityCampaignsService.rejectCancellation("admin-1", "req-3", "Supplier confirmed they can still deliver");

    expect(result.status).toBe("REJECTED");
    expect(m.campaignCancellationRequest.updateMany).toHaveBeenCalledWith({ where: { id: "req-3", status: "PENDING" }, data: expect.objectContaining({ status: "REJECTED", reviewedById: "admin-1" }) });
    expect(m.communityCampaign.updateMany).toHaveBeenCalledWith({ where: { id: "camp-1", status: "CANCELLATION_UNDER_REVIEW" }, data: { status: "RESCUE_WINDOW" } });
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "organiser-user-1", data: expect.objectContaining({ event: "cancellation_rejected" }) }));
  });

  it("a second rejection attempt on the same request is rejected — restore logic never runs twice", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue(pendingRequest);
    m.campaignCancellationRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(communityCampaignsService.rejectCancellation("admin-1", "req-3")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.communityCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("rejects outright when the request is no longer PENDING", async () => {
    m.campaignCancellationRequest.findUnique.mockResolvedValue({ ...pendingRequest, status: "APPROVED" });

    await expect(communityCampaignsService.rejectCancellation("admin-1", "req-3")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("listCancellationRequestsForAdmin()", () => {
  it("only ever returns PENDING requests", async () => {
    m.campaignCancellationRequest.findMany.mockResolvedValue([]);

    await communityCampaignsService.listCancellationRequestsForAdmin();

    expect(m.campaignCancellationRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "PENDING" } }));
  });
});
