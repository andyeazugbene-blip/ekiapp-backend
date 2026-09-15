/**
 * M5 — Supplier KYC state machine. Covers the SupplierAccount transitions
 * that were reachable-in-enum-but-never-set before this milestone
 * (VERIFICATION_REQUIRED, INFORMATION_REQUIRED, PAUSED, SUSPENDED, CLOSED),
 * plus the Stripe-requirements sync and the new collectionCapacityPerDay
 * onboarding field. Existing APPROVED/RESTRICTED/UNDER_REVIEW behaviour
 * (Workstream 1/3) is untouched — see supplier-account.service.ts's own
 * pre-M5 tests elsewhere for that coverage; this file only adds what's new.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    supplierAccount: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    communityCampaign: { findMany: vi.fn() },
    deliveryReference: { updateMany: vi.fn() },
    communityBuyDataAccessLog: { create: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));

import { prisma } from "../lib/prisma";
import { supplierAccountService } from "../modules/community-buy/supplier-account.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  m.communityCampaign.findMany.mockResolvedValue([]);
  m.deliveryReference.updateMany.mockResolvedValue({ count: 0 } as never);
  m.communityBuyDataAccessLog.create.mockResolvedValue({} as never);
});

describe("applyAsSupplier() — M5 additions (collectionCapacityPerDay, SUSPENDED/CLOSED re-apply block)", () => {
  it("persists collectionCapacityPerDay on first application", async () => {
    m.supplierAccount.findUnique.mockResolvedValue(null);
    m.supplierAccount.upsert.mockResolvedValue({ id: "acct-1", supplierState: "UNDER_REVIEW", categories: ["food"], coverageRegions: ["GB"], collectionCapacityPerDay: 50 } as never);

    await supplierAccountService.applyAsSupplier("u1", { country: "GB", categories: ["food"], coverageRegions: ["GB"], collectionCapacityPerDay: 50 });

    expect(m.supplierAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ collectionCapacityPerDay: 50 }),
      update: expect.objectContaining({ collectionCapacityPerDay: 50 }),
    }));
  });

  it("rejects re-applying to a SUSPENDED account — no self-service reversal", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ supplierState: "SUSPENDED" } as never);
    await expect(supplierAccountService.applyAsSupplier("u1", { country: "GB" })).rejects.toMatchObject({ statusCode: 403 });
    expect(m.supplierAccount.upsert).not.toHaveBeenCalled();
  });

  it("rejects re-applying to a CLOSED account — permanent, terminal", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ supplierState: "CLOSED" } as never);
    await expect(supplierAccountService.applyAsSupplier("u1", { country: "GB" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("resubmission after INFORMATION_REQUIRED falls through to the normal UNDER_REVIEW upsert (no separate resubmit endpoint)", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ supplierState: "INFORMATION_REQUIRED", categories: ["food"], coverageRegions: ["GB"], collectionCapacityPerDay: null } as never);
    m.supplierAccount.upsert.mockResolvedValue({ supplierState: "UNDER_REVIEW", categories: ["food"], coverageRegions: ["GB"] } as never);

    const result = await supplierAccountService.applyAsSupplier("u1", { country: "GB" });

    expect(result.supplierState).toBe("UNDER_REVIEW");
    expect(m.supplierAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ supplierState: "UNDER_REVIEW" }) }));
  });
});

describe("requestInformation() — spec §10.1/§10.2 step 6", () => {
  it("UNDER_REVIEW -> INFORMATION_REQUIRED with the reason recorded", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "UNDER_REVIEW" } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "INFORMATION_REQUIRED", reasonCode: "Missing coverage regions" } as never);

    const result = await supplierAccountService.requestInformation("acct-1", "Missing coverage regions");

    expect(result.supplierState).toBe("INFORMATION_REQUIRED");
    expect(m.supplierAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supplierState: "INFORMATION_REQUIRED", reasonCode: "Missing coverage regions" }) }));
  });

  it("refuses on a CLOSED (terminal) account", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "CLOSED" } as never);
    await expect(supplierAccountService.requestInformation("acct-1", "reason")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("404s for a missing account", async () => {
    m.supplierAccount.findUnique.mockResolvedValue(null);
    await expect(supplierAccountService.requestInformation("acct-missing", "reason")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("suspend() — spec §6.4/§14.4: admin-only, always revokes data access", () => {
  it("APPROVED -> SUSPENDED, sets suspendedAt, and revokes data access across every assigned campaign", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "SUSPENDED" } as never);
    m.communityCampaign.findMany.mockResolvedValue([{ id: "camp-1" }, { id: "camp-2" }] as never);

    const result = await supplierAccountService.suspend("acct-1", "policy violation", "admin-1");

    expect(result.supplierState).toBe("SUSPENDED");
    expect(m.supplierAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ supplierState: "SUSPENDED", reasonCode: "policy violation", suspendedAt: expect.any(Date) }),
    }));
    // revokeDeliveryReferencesForSupplierAccount fans out per assigned campaign.
    expect(m.deliveryReference.updateMany).toHaveBeenCalledTimes(2);
  });

  it("refuses to suspend an already-CLOSED account", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "CLOSED" } as never);
    await expect(supplierAccountService.suspend("acct-1", "reason", "admin-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("suspending with NO active campaigns is a safe no-op revoke (no crash, zero revocations)", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "RESTRICTED" } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "SUSPENDED" } as never);
    m.communityCampaign.findMany.mockResolvedValue([]);

    const result = await supplierAccountService.suspend("acct-1", "reason", "admin-1");
    expect(result.supplierState).toBe("SUSPENDED");
    expect(m.deliveryReference.updateMany).not.toHaveBeenCalled();
  });
});

describe("close() — permanent, terminal, idempotent", () => {
  it("any non-CLOSED state -> CLOSED, sets closedAt, revokes data access", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "CLOSED" } as never);
    m.communityCampaign.findMany.mockResolvedValue([{ id: "camp-1" }] as never);

    const result = await supplierAccountService.close("acct-1", "requested closure", "admin-1");

    expect(result.supplierState).toBe("CLOSED");
    expect(m.supplierAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supplierState: "CLOSED", closedAt: expect.any(Date) }) }));
    expect(m.deliveryReference.updateMany).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — closing an already-CLOSED account is a no-op, not an error", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "CLOSED" } as never);
    const result = await supplierAccountService.close("acct-1", "reason", "admin-1");
    expect(result.supplierState).toBe("CLOSED");
    expect(m.supplierAccount.update).not.toHaveBeenCalled();
  });
});

describe("pause()/resume() — spec §6.4 'paused: voluntarily unavailable for new work' — the only self-service transition", () => {
  it("pause() requires APPROVED; sets PAUSED + pausedAt", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", userId: "u1", supplierState: "APPROVED" } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "PAUSED" } as never);

    const result = await supplierAccountService.pause("u1");

    expect(result.supplierState).toBe("PAUSED");
    expect(m.supplierAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supplierState: "PAUSED", pausedAt: expect.any(Date) }) }));
  });

  it("pause() refuses from any state other than APPROVED (e.g. UNDER_REVIEW cannot skip review by pausing)", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", userId: "u1", supplierState: "UNDER_REVIEW" } as never);
    await expect(supplierAccountService.pause("u1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("pause() never revokes data access — existing fulfilment access continues per spec §14.4", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", userId: "u1", supplierState: "APPROVED" } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "PAUSED" } as never);
    await supplierAccountService.pause("u1");
    expect(m.deliveryReference.updateMany).not.toHaveBeenCalled();
  });

  it("resume() requires PAUSED; returns to APPROVED, clears pausedAt", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", userId: "u1", supplierState: "PAUSED" } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" } as never);

    const result = await supplierAccountService.resume("u1");

    expect(result.supplierState).toBe("APPROVED");
    expect(m.supplierAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: { supplierState: "APPROVED", pausedAt: null } }));
  });

  it("resume() refuses when not currently PAUSED", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", userId: "u1", supplierState: "APPROVED" } as never);
    await expect(supplierAccountService.resume("u1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("pause()/resume() 403 without a SupplierAccount at all", async () => {
    m.supplierAccount.findUnique.mockResolvedValue(null);
    await expect(supplierAccountService.pause("stranger")).rejects.toMatchObject({ statusCode: 403 });
    await expect(supplierAccountService.resume("stranger")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("unrestrict() — M5 fix: must refuse SUSPENDED/CLOSED, never silently restore them", () => {
  it("refuses a SUSPENDED account — unrestrict is not the reversal for suspend()", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "SUSPENDED" } as never);
    await expect(supplierAccountService.unrestrict("acct-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.supplierAccount.update).not.toHaveBeenCalled();
  });

  it("refuses a CLOSED account", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "CLOSED" } as never);
    await expect(supplierAccountService.unrestrict("acct-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("still works normally for an actually-RESTRICTED account", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "RESTRICTED", approvedAt: new Date() } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" } as never);
    const result = await supplierAccountService.unrestrict("acct-1");
    expect(result.supplierState).toBe("APPROVED");
  });
});

describe("unsuspend() — the equally-guarded reversal for suspend()", () => {
  it("SUSPENDED -> APPROVED (if previously approved), clears suspendedAt", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "SUSPENDED", approvedAt: new Date() } as never);
    m.supplierAccount.update.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" } as never);

    const result = await supplierAccountService.unsuspend("acct-1");

    expect(result.supplierState).toBe("APPROVED");
    expect(m.supplierAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ suspendedAt: null }) }));
  });

  it("refuses an account that isn't currently SUSPENDED", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "RESTRICTED" } as never);
    await expect(supplierAccountService.unsuspend("acct-1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("syncStripeRequirements() — demotes/promotes UNDER_REVIEW<->VERIFICATION_REQUIRED only", () => {
  it("demotes UNDER_REVIEW to VERIFICATION_REQUIRED when Stripe reports outstanding requirements", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "UNDER_REVIEW" } as never);
    await supplierAccountService.syncStripeRequirements("acct-1", ["individual.id_number"]);
    expect(m.supplierAccount.update).toHaveBeenCalledWith({ where: { id: "acct-1" }, data: { stripeRequirementsDue: ["individual.id_number"], supplierState: "VERIFICATION_REQUIRED" } });
  });

  it("promotes VERIFICATION_REQUIRED back to UNDER_REVIEW once requirements clear", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "VERIFICATION_REQUIRED" } as never);
    await supplierAccountService.syncStripeRequirements("acct-1", []);
    expect(m.supplierAccount.update).toHaveBeenCalledWith({ where: { id: "acct-1" }, data: { stripeRequirementsDue: [], supplierState: "UNDER_REVIEW" } });
  });

  it("never touches an already-decided state (APPROVED) even if Stripe reports requirements", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" } as never);
    await supplierAccountService.syncStripeRequirements("acct-1", ["some.requirement"]);
    expect(m.supplierAccount.update).toHaveBeenCalledWith({ where: { id: "acct-1" }, data: { stripeRequirementsDue: ["some.requirement"] } });
  });

  it("never touches RESTRICTED/PAUSED/SUSPENDED/CLOSED", async () => {
    for (const state of ["RESTRICTED", "PAUSED", "SUSPENDED", "CLOSED"]) {
      vi.clearAllMocks();
      m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: state } as never);
      await supplierAccountService.syncStripeRequirements("acct-1", ["x"]);
      expect(m.supplierAccount.update).toHaveBeenCalledWith({ where: { id: "acct-1" }, data: { stripeRequirementsDue: ["x"] } });
    }
  });

  it("is a safe no-op for a non-existent account", async () => {
    m.supplierAccount.findUnique.mockResolvedValue(null);
    await expect(supplierAccountService.syncStripeRequirements("missing", [])).resolves.toBeUndefined();
    expect(m.supplierAccount.update).not.toHaveBeenCalled();
  });
});
