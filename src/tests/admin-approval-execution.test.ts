/**
 * adminDecideApproval — the four-eyes decision must not be durably
 * recorded until the gated action has actually executed successfully.
 *
 * Real bug found via live QA testing: the approval was marked APPROVED
 * (decidedById/decidedAt written) BEFORE the gated action ran. When
 * execution then failed (e.g. a real Stripe error), the approval was
 * permanently stuck APPROVED with the underlying refund never having
 * happened, no way to retry through this endpoint (re-deciding an
 * already-decided approval is correctly rejected), and no audit record
 * explaining what happened at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../lib/prisma", () => ({
  prisma: {
    adminApproval: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    campaignContribution: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    communityBuyDataAccessLog: { create: vi.fn() },
  },
}));

vi.mock("../modules/admin/admin-refunds.controller", () => ({
  executeOrderRefund: vi.fn(),
}));

vi.mock("../modules/community-buy/campaign-contributions.service", () => ({
  campaignContributionsService: { releaseSupplierPayment: vi.fn() },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { executeOrderRefund } from "../modules/admin/admin-refunds.controller";
import { campaignContributionsService } from "../modules/community-buy/campaign-contributions.service";
import { notificationsService } from "../modules/notifications/notifications.service";
import { adminDecideApproval } from "../modules/admin/admin-approvals.controller";

const m = vi.mocked(prisma, true);
const mExecuteRefund = vi.mocked(executeOrderRefund);
const mReleaseSupplierPayment = vi.mocked(campaignContributionsService.releaseSupplierPayment);
const mNotify = vi.mocked(notificationsService, true);

function createMockReq(body: Record<string, unknown>): Request {
  return { user: { id: "admin-b", role: "ADMIN", email: "b@test.com" }, params: { id: "appr-1" }, body, headers: {} } as unknown as Request;
}
function createMockRes(): Response & { statusCode: number; data: unknown } {
  const res = {
    statusCode: 0,
    data: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.data = data; return res; },
  };
  return res as unknown as Response & { statusCode: number; data: unknown };
}

const pendingApproval = {
  id: "appr-1",
  status: "PENDING",
  actionType: "order.refund.large",
  businessRefType: "Order",
  businessRefId: "order-1",
  amount: 1500,
  requestedById: "admin-a",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.auditLog.create.mockResolvedValue({} as never);
});

describe("adminDecideApproval — approve path only commits after successful execution", () => {
  it("execution failure leaves the approval PENDING (retryable), never marks it APPROVED, and records a failure audit entry", async () => {
    m.adminApproval.findUnique.mockResolvedValue(pendingApproval as never);
    mExecuteRefund.mockRejectedValue(new Error("Stripe refund failed"));

    const res = createMockRes();
    await expect(adminDecideApproval(createMockReq({ approve: true }), res as unknown as Response)).rejects.toThrow("Stripe refund failed");

    // The decision must NEVER be committed when execution failed.
    expect(m.adminApproval.update).not.toHaveBeenCalled();

    // But the failed attempt must still be auditable — never silently lost.
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "admin_approval.execution_failed",
        entityType: "Order",
        entityId: "order-1",
      }),
    }));
  });

  it("execution success commits the approval as APPROVED and records the success audit entry", async () => {
    m.adminApproval.findUnique.mockResolvedValue(pendingApproval as never);
    mExecuteRefund.mockResolvedValue({ refundId: "re_1", amount: 1500, currency: "gbp", status: "succeeded", provider: "stripe" } as never);
    m.adminApproval.update.mockResolvedValue({ ...pendingApproval, status: "APPROVED", decidedById: "admin-b" } as never);

    const res = createMockRes();
    await adminDecideApproval(createMockReq({ approve: true }), res as unknown as Response);

    expect(m.adminApproval.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "appr-1" },
      data: expect.objectContaining({ status: "APPROVED", decidedById: "admin-b" }),
    }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "admin_approval.approved_and_executed" }),
    }));
    expect((res.data as Record<string, unknown>).approval).toMatchObject({ status: "APPROVED" });
  });

  it("a retry after a failed execution is still possible — the approval stayed PENDING, so validateDecision (self-approval/already-decided checks) runs fresh again", async () => {
    m.adminApproval.findUnique.mockResolvedValue(pendingApproval as never); // still PENDING after the earlier failure
    mExecuteRefund.mockResolvedValueOnce(undefined as never).mockResolvedValue({ refundId: "re_2", amount: 1500, currency: "gbp", status: "succeeded", provider: "stripe" } as never);
    m.adminApproval.update.mockResolvedValue({ ...pendingApproval, status: "APPROVED" } as never);

    const res = createMockRes();
    await adminDecideApproval(createMockReq({ approve: true }), res as unknown as Response);

    expect(m.adminApproval.update).toHaveBeenCalledTimes(1);
    expect((res.data as Record<string, unknown>).approval).toMatchObject({ status: "APPROVED" });
  });

  // WS6: a four-eyes-approved Community Buy supplier-payment release used to
  // be audited ONLY as the generic admin_approval.approved_and_executed
  // entry — a query for "every supplier payment release" silently missed
  // every gated one. This proves the specific entry now also fires.
  it("WS6: approving a community_buy.supplier_payment_release action records BOTH the specific release audit entry and the generic approval-executed entry", async () => {
    const supplierPaymentApproval = {
      id: "appr-2", status: "PENDING", actionType: "community_buy.supplier_payment_release",
      businessRefType: "CampaignSupplierPayment", businessRefId: "camp-99", amount: 5000, requestedById: "admin-a",
    };
    m.adminApproval.findUnique.mockResolvedValue(supplierPaymentApproval as never);
    mReleaseSupplierPayment.mockResolvedValue({ status: "PAID" } as never);
    m.adminApproval.update.mockResolvedValue({ ...supplierPaymentApproval, status: "APPROVED" } as never);

    const res = createMockRes();
    await adminDecideApproval(createMockReq({ approve: true }), res as unknown as Response);

    expect(mReleaseSupplierPayment).toHaveBeenCalledWith("admin-b", "camp-99");
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "community_supplier_payment.release",
        entityType: "CampaignSupplierPayment",
        entityId: "camp-99",
      }),
    }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "admin_approval.approved_and_executed" }),
    }));
  });

  // M4 (spec §14.3, AT-42) — emergency real-number disclosure. This
  // execution branch IS the grant: it never exists before a second,
  // different admin has approved it.
  it("AT-42: approving community_buy.emergency_contact_disclosure creates a time-bound ADMIN_OVERRIDE access-log grant and notifies the assigned supplier", async () => {
    const disclosureApproval = {
      id: "appr-3", status: "PENDING", actionType: "community_buy.emergency_contact_disclosure",
      businessRefType: "CampaignContribution", businessRefId: "contrib-1", amount: null, requestedById: "admin-a",
      reason: "Participant unreachable, delivery window closing",
    };
    m.adminApproval.findUnique.mockResolvedValue(disclosureApproval as never);
    m.campaignContribution.findUnique.mockResolvedValue({ id: "contrib-1", campaignId: "camp-1", participantId: "part-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", title: "Rice bulk buy", supplierAccount: { userId: "supplier-user-1" }, supplier: null } as never);
    m.adminApproval.update.mockResolvedValue({ ...disclosureApproval, status: "APPROVED" } as never);

    const before = Date.now();
    const res = createMockRes();
    await adminDecideApproval(createMockReq({ approve: true }), res as unknown as Response);

    expect(m.communityBuyDataAccessLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        campaignId: "camp-1",
        contributionId: "contrib-1",
        participantId: "part-1",
        accessorUserId: "admin-b",
        accessorRole: "ADMIN",
        dataCategory: "EMERGENCY_NUMBER",
        action: "ADMIN_OVERRIDE",
        purposeCode: disclosureApproval.reason,
        adminOverrideId: "appr-3",
      }),
    }));
    // Bounded expiry — a fixed, non-configurable window, not admin-chosen.
    const call = m.communityBuyDataAccessLog.create.mock.calls[0][0] as any;
    const expiresAt = call.data.accessExpiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(before);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before + 61 * 60 * 1000);
    expect(expiresAt.getTime()).toBeGreaterThan(before + 59 * 60 * 1000);

    expect(mNotify.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "supplier-user-1" }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "community_buy_data_access.emergency_disclosure_granted", entityId: "contrib-1" }),
    }));
  });

  it("reject path never calls execution at all, commits REJECTED immediately", async () => {
    m.adminApproval.findUnique.mockResolvedValue(pendingApproval as never);
    m.adminApproval.update.mockResolvedValue({ ...pendingApproval, status: "REJECTED" } as never);

    const res = createMockRes();
    await adminDecideApproval(createMockReq({ approve: false, note: "not valid" }), res as unknown as Response);

    expect(mExecuteRefund).not.toHaveBeenCalled();
    expect(m.adminApproval.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }));
  });
});
