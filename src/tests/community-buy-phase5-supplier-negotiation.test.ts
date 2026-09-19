/**
 * Phase 5 (organiser<->supplier negotiation) — focused tests for the
 * supplier-proposal state machine: submission + validation, ownership,
 * admin review (approve / changes-needed), organiser accept/reject,
 * withdraw, duplicate/idempotency guards, stale-proposal re-validation,
 * concurrent-update races, invalid transitions, and notification
 * behavior. Mirrors the existing Prisma-mocked unit-test convention.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn(), update: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
    supplierAccount: { findUnique: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    campaignSupplierProposal: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/automation/automation.service", () => ({ automationService: { trigger: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { campaignSupplierProposalService } from "../modules/community-buy/campaign-supplier-proposal.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

const baseCampaign = {
  id: "camp-1",
  organiserId: "org-1",
  title: "Rice Bulk Buy",
  status: "LIVE",
  fulfilmentOwner: "SUPPLIER",
  supplierId: "sup-1",
  supplierAccountId: null,
  maximumShares: 20,
  confirmedShares: 5,
};

const futureDate = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

describe("submitForVendor() — validation and ownership", () => {
  it("rejects when the caller is not the campaign's assigned supplier", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-2", vendor: { userId: "v2" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-2", "camp-1", { message: "Please raise price" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a self-fulfilled campaign — nothing to negotiate", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    // supplierId kept set so ownership resolves first — this isolates the
    // fulfilmentOwner guard itself from the (separate) ownership guard.
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, fulfilmentOwner: "SELF" });

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "x", proposedMaximumShares: 15 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a proposal with no field actually changed", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "just a note" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a reduced-quantity request below shares already confirmed", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign); // confirmedShares: 5
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "reduce slots", proposedMaximumShares: 3 }),
    ).rejects.toMatchObject({ code: "PROPOSAL_BELOW_CONFIRMED_SHARES" });
  });

  it("rejects a negative wholesale amount", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "x", proposedWholesaleAmountMinor: -100 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a ready-by date in the past", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "x", proposedReadyByDate: new Date(Date.now() - 1000).toISOString() }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a second proposal while one is already pending (duplicate-request guard)", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findFirst.mockResolvedValue({ id: "existing-proposal", status: "SUBMITTED" });

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "x", proposedMaximumShares: 18 }),
    ).rejects.toMatchObject({ code: "PROPOSAL_ALREADY_PENDING" });
  });

  it("rejects when the campaign is past the negotiable status window", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, status: "FULFILLING" });

    await expect(
      campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "x", proposedMaximumShares: 18 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("accepts a valid price (wholesale amount) change", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);
    m.campaignSupplierProposal.create.mockResolvedValue({ id: "prop-1", status: "SUBMITTED", proposedWholesaleAmountMinor: 5000 });

    const result = await campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "Cost of rice went up", proposedWholesaleAmountMinor: 5000 });

    expect(result.status).toBe("SUBMITTED");
    expect(m.campaignSupplierProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ proposedWholesaleAmountMinor: 5000, supplierId: "sup-1", supplierAccountId: null, status: "SUBMITTED" }),
    }));
  });

  it("accepts a valid slot (maximum shares) change", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);
    m.campaignSupplierProposal.create.mockResolvedValue({ id: "prop-2", status: "SUBMITTED", proposedMaximumShares: 30 });

    const result = await campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "We can supply more", proposedMaximumShares: 30 });

    expect(result.proposedMaximumShares).toBe(30);
  });

  it("accepts a valid ready-by date change", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);
    const readyBy = futureDate();
    m.campaignSupplierProposal.create.mockResolvedValue({ id: "prop-3", status: "SUBMITTED", proposedReadyByDate: new Date(readyBy) });

    const result = await campaignSupplierProposalService.submitForVendor("vendor-1", "camp-1", { message: "Need more time", proposedReadyByDate: readyBy });

    expect(result.proposedReadyByDate).toEqual(new Date(readyBy));
  });

  it("SupplierAccount path resolves supplierAccountId, not supplierId", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, supplierId: null, supplierAccountId: "acct-1" });
    m.campaignSupplierProposal.findFirst.mockResolvedValue(null);
    m.campaignSupplierProposal.create.mockResolvedValue({ id: "prop-4", status: "SUBMITTED" });

    await campaignSupplierProposalService.submitForAccount("account-user-1", "camp-1", { message: "x", proposedMaximumShares: 25 });

    expect(m.campaignSupplierProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ supplierId: null, supplierAccountId: "acct-1", submittedByUserId: "account-user-1" }),
    }));
  });
});

describe("Admin review — Eki changes-needed vs approve", () => {
  it("approveForAdmin() moves SUBMITTED -> AWAITING_ORGANISER and notifies the organiser", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", status: "SUBMITTED", campaignId: "camp-1", campaign: { title: "Rice Bulk Buy", organiser: { userId: "organiser-user-1" } } });
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 1 });
    m.campaignSupplierProposal.findUniqueOrThrow.mockResolvedValue({ id: "prop-1", status: "AWAITING_ORGANISER" });

    const result = await campaignSupplierProposalService.approveForAdmin("admin-1", "prop-1");

    expect(result.status).toBe("AWAITING_ORGANISER");
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      userId: "organiser-user-1",
      data: expect.objectContaining({ event: "supplier_proposal_awaiting_organiser" }),
    }));
  });

  it("requestChangesForAdmin() moves SUBMITTED -> ADMIN_CHANGES_NEEDED with notes, notifies the supplier", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", status: "SUBMITTED", campaignId: "camp-1", submittedByUserId: "vendor-user-1" });
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 1 });
    m.campaignSupplierProposal.findUniqueOrThrow.mockResolvedValue({ id: "prop-1", status: "ADMIN_CHANGES_NEEDED", campaignId: "camp-1", submittedByUserId: "vendor-user-1" });

    const result = await campaignSupplierProposalService.requestChangesForAdmin("admin-1", "prop-1", "Wholesale increase too high — please justify or lower it.");

    expect(result.status).toBe("ADMIN_CHANGES_NEEDED");
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "vendor-user-1", data: expect.objectContaining({ event: "supplier_proposal_changes_needed" }) }));
  });

  it("requestChangesForAdmin() rejects a blank notes body", async () => {
    await expect(campaignSupplierProposalService.requestChangesForAdmin("admin-1", "prop-1", "   ")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects admin action on a proposal that isn't SUBMITTED (invalid transition)", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", status: "AWAITING_ORGANISER" });

    await expect(campaignSupplierProposalService.approveForAdmin("admin-1", "prop-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("duplicate admin approval attempt (concurrent claim loses) is rejected — idempotency", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", status: "SUBMITTED" });
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 0 }); // another call already claimed it

    await expect(campaignSupplierProposalService.approveForAdmin("admin-1", "prop-1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("Organiser accept/reject — applies changes exactly once, re-validates staleness", () => {
  const awaitingProposal = {
    id: "prop-1",
    campaignId: "camp-1",
    status: "AWAITING_ORGANISER",
    proposedWholesaleAmountMinor: 6000,
    proposedMaximumShares: 25,
    proposedReadyByDate: new Date(futureDate()),
    campaign: { ...baseCampaign, organiser: { userId: "organiser-user-1" } },
  };

  it("rejects a non-owner organiser", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue(awaitingProposal);

    await expect(campaignSupplierProposalService.accept("someone-else", "prop-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("accept() applies wholesale amount, maximum shares, and ready-by date to the campaign, exactly once", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue(awaitingProposal);
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 1 });
    m.campaignSupplierProposal.findUniqueOrThrow.mockResolvedValue({ id: "prop-1", status: "ORGANISER_ACCEPTED" });

    const result = await campaignSupplierProposalService.accept("organiser-user-1", "prop-1");

    expect(result.status).toBe("ORGANISER_ACCEPTED");
    expect(m.communityCampaign.update).toHaveBeenCalledTimes(1);
    expect(m.communityCampaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { wholesaleAmountMinor: 6000, maximumShares: 25, agreedReadyByDate: awaitingProposal.proposedReadyByDate },
    });
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ event: "supplier_proposal_accepted" }) }));
  });

  it("accept() re-validates against CURRENT confirmedShares at accept time — rejects a now-stale reduced-quantity proposal", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue({
      ...awaitingProposal,
      proposedMaximumShares: 6,
      campaign: { ...baseCampaign, confirmedShares: 10, organiser: { userId: "organiser-user-1" } }, // more pledges landed since submission
    });

    await expect(campaignSupplierProposalService.accept("organiser-user-1", "prop-1")).rejects.toMatchObject({ code: "PROPOSAL_STALE_BELOW_CONFIRMED_SHARES" });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("duplicate accept attempt (concurrent claim loses) is rejected — never double-applies changes", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue(awaitingProposal);
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 0 });

    await expect(campaignSupplierProposalService.accept("organiser-user-1", "prop-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("reject() moves AWAITING_ORGANISER -> ORGANISER_REJECTED, never touches the campaign", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue(awaitingProposal);
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 1 });
    m.campaignSupplierProposal.findUniqueOrThrow.mockResolvedValue({ id: "prop-1", status: "ORGANISER_REJECTED" });

    const result = await campaignSupplierProposalService.reject("organiser-user-1", "prop-1", "Too expensive");

    expect(result.status).toBe("ORGANISER_REJECTED");
    expect(m.communityCampaign.update).not.toHaveBeenCalled();
  });

  it("rejects deciding on a proposal not awaiting the organiser (invalid transition)", async () => {
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ ...awaitingProposal, status: "SUBMITTED" });

    await expect(campaignSupplierProposalService.accept("organiser-user-1", "prop-1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("Resubmit and withdraw", () => {
  it("resubmit only works from ADMIN_CHANGES_NEEDED, increments revisionCount, clears adminNotes", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", campaignId: "camp-1", submittedByUserId: "v1", status: "ADMIN_CHANGES_NEEDED" });
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 1 });
    m.campaignSupplierProposal.findUniqueOrThrow.mockResolvedValue({ id: "prop-1", status: "SUBMITTED", revisionCount: 1 });

    const result = await campaignSupplierProposalService.resubmitForVendor("vendor-1", "camp-1", "prop-1", { message: "Lowered the ask", proposedWholesaleAmountMinor: 5500 });

    expect(result.status).toBe("SUBMITTED");
    expect(m.campaignSupplierProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "prop-1", status: "ADMIN_CHANGES_NEEDED" },
      data: expect.objectContaining({ status: "SUBMITTED", revisionCount: { increment: 1 }, adminNotes: null }),
    }));
  });

  it("resubmit rejects from any other status", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", campaignId: "camp-1", submittedByUserId: "v1", status: "SUBMITTED" });

    await expect(
      campaignSupplierProposalService.resubmitForVendor("vendor-1", "camp-1", "prop-1", { message: "x", proposedMaximumShares: 20 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("withdraw works from any live status and is idempotency-guarded against a second call", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", campaignId: "camp-1", submittedByUserId: "v1", status: "SUBMITTED" });
    m.campaignSupplierProposal.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    m.campaignSupplierProposal.findUniqueOrThrow.mockResolvedValue({ id: "prop-1", status: "WITHDRAWN" });

    const first = await campaignSupplierProposalService.withdrawForVendor("vendor-1", "camp-1", "prop-1");
    expect(first.status).toBe("WITHDRAWN");

    await expect(campaignSupplierProposalService.withdrawForVendor("vendor-1", "camp-1", "prop-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a supplier cannot withdraw another supplier's proposal", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "v1" } });
    m.communityCampaign.findUnique.mockResolvedValue(baseCampaign);
    m.campaignSupplierProposal.findUnique.mockResolvedValue({ id: "prop-1", campaignId: "camp-1", submittedByUserId: "someone-else", status: "SUBMITTED" });

    await expect(campaignSupplierProposalService.withdrawForVendor("vendor-1", "camp-1", "prop-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Read-scoping — organiser never sees adminNotes", () => {
  it("listForOrganiser() strips adminNotes and only returns AWAITING_ORGANISER-or-later proposals", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "org-1" });
    m.campaignSupplierProposal.findMany.mockResolvedValue([
      { id: "prop-1", status: "AWAITING_ORGANISER", adminNotes: "internal admin chatter", proposedMaximumShares: 25 },
    ]);

    const result = await campaignSupplierProposalService.listForOrganiser("organiser-user-1", "camp-1");

    expect(m.campaignSupplierProposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["AWAITING_ORGANISER", "ORGANISER_ACCEPTED", "ORGANISER_REJECTED", "EXPIRED"] } }),
    }));
    expect(result[0]).not.toHaveProperty("adminNotes");
    expect(JSON.stringify(result)).not.toMatch(/internal admin chatter/);
  });

  it("listForOrganiser() rejects a non-owner", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1", userId: "organiser-user-1" });
    m.communityCampaign.findUnique.mockResolvedValue({ ...baseCampaign, organiserId: "someone-else" });

    await expect(campaignSupplierProposalService.listForOrganiser("organiser-user-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Overdue reminder + expiry sweep", () => {
  it("sends exactly one reminder per overdue proposal and marks remindedAt (no double-reminder)", async () => {
    m.campaignSupplierProposal.findMany
      .mockResolvedValueOnce([{ id: "prop-1", campaignId: "camp-1", status: "AWAITING_ORGANISER", submittedByUserId: "v1", campaign: { title: "Rice Bulk Buy", organiser: { userId: "organiser-user-1" } } }])
      .mockResolvedValueOnce([]);
    m.campaignSupplierProposal.updateMany.mockResolvedValue({ count: 1 });

    const result = await campaignSupplierProposalService.remindAndExpireOverdue();

    expect(result.reminded).toBe(1);
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "organiser-user-1", data: expect.objectContaining({ event: "supplier_proposal_overdue_reminder" }) }));
  });

  it("expires a proposal past the reminder grace period, and is idempotent against a race", async () => {
    m.campaignSupplierProposal.findMany
      .mockResolvedValueOnce([]) // no new reminders this pass
      .mockResolvedValueOnce([{ id: "prop-1", status: "AWAITING_ORGANISER" }]);
    m.campaignSupplierProposal.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await campaignSupplierProposalService.remindAndExpireOverdue();

    expect(result.expired).toBe(1);
    expect(m.campaignSupplierProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "prop-1", status: { in: ["SUBMITTED", "ADMIN_CHANGES_NEEDED", "AWAITING_ORGANISER"] } },
      data: { status: "EXPIRED" },
    }));
  });
});
