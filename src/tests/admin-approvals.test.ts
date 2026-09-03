import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    adminApprovalRule: { findUnique: vi.fn(), upsert: vi.fn() },
    adminApproval: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminApprovalsService } from "../modules/admin/admin-approvals.service";

const ruleFindUnique = prisma.adminApprovalRule.findUnique as unknown as ReturnType<typeof vi.fn>;
const approvalFindFirst = prisma.adminApproval.findFirst as unknown as ReturnType<typeof vi.fn>;
const approvalFindUnique = prisma.adminApproval.findUnique as unknown as ReturnType<typeof vi.fn>;
const approvalUpdate = prisma.adminApproval.update as unknown as ReturnType<typeof vi.fn>;
const approvalCreate = prisma.adminApproval.create as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("adminApprovalsService.requiresApproval", () => {
  it("defaults to false with no rule configured — never silently blocks an action nobody opted into gating", async () => {
    ruleFindUnique.mockResolvedValue(null);
    expect(await adminApprovalsService.requiresApproval("some.action", 100000)).toBe(false);
  });

  it("false when rule exists but is disabled", async () => {
    ruleFindUnique.mockResolvedValue({ actionType: "refund.large", thresholdAmount: 1000, enabled: false });
    expect(await adminApprovalsService.requiresApproval("refund.large", 5000)).toBe(false);
  });

  it("always requires approval when thresholdAmount is null (no amount-based exemption)", async () => {
    ruleFindUnique.mockResolvedValue({ actionType: "role.grant_super_admin", thresholdAmount: null, enabled: true });
    expect(await adminApprovalsService.requiresApproval("role.grant_super_admin")).toBe(true);
  });

  it("requires approval only at/above the configurable threshold", async () => {
    ruleFindUnique.mockResolvedValue({ actionType: "community_buy.supplier_payment_release", thresholdAmount: 100000, enabled: true });
    expect(await adminApprovalsService.requiresApproval("community_buy.supplier_payment_release", 50000)).toBe(false);
    expect(await adminApprovalsService.requiresApproval("community_buy.supplier_payment_release", 100000)).toBe(true);
    expect(await adminApprovalsService.requiresApproval("community_buy.supplier_payment_release", 250000)).toBe(true);
  });
});

describe("adminApprovalsService.requestApproval", () => {
  it("is idempotent — a second request for the same pending action returns the existing one", async () => {
    const existing = { id: "appr-1", status: "PENDING" };
    approvalFindFirst.mockResolvedValue(existing);

    const result = await adminApprovalsService.requestApproval({
      actionType: "community_buy.supplier_payment_release",
      businessRefType: "CampaignSupplierPayment",
      businessRefId: "camp-1",
      requestedById: "admin-a",
      reason: "release",
    });

    expect(result).toBe(existing);
    expect(approvalCreate).not.toHaveBeenCalled();
  });
});

describe("adminApprovalsService.decide — the core four-eyes invariant", () => {
  it("rejects self-approval — the requester cannot decide their own request", async () => {
    approvalFindUnique.mockResolvedValue({ id: "appr-1", status: "PENDING", requestedById: "admin-a" });

    await expect(adminApprovalsService.decide("appr-1", "admin-a", true)).rejects.toThrow(/second, different admin/i);
    expect(approvalUpdate).not.toHaveBeenCalled();
  });

  it("allows a different admin to approve", async () => {
    approvalFindUnique.mockResolvedValue({ id: "appr-1", status: "PENDING", requestedById: "admin-a" });
    approvalUpdate.mockResolvedValue({ id: "appr-1", status: "APPROVED" });

    const result = await adminApprovalsService.decide("appr-1", "admin-b", true, "looks fine");
    expect(result.status).toBe("APPROVED");
    expect(approvalUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "appr-1" },
      data: expect.objectContaining({ status: "APPROVED", decidedById: "admin-b" }),
    }));
  });

  it("rejects deciding an already-decided approval", async () => {
    approvalFindUnique.mockResolvedValue({ id: "appr-1", status: "APPROVED", requestedById: "admin-a" });
    await expect(adminApprovalsService.decide("appr-1", "admin-b", true)).rejects.toThrow(/already been decided/i);
  });
});
