import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    supplierProfile: { findUnique: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    campaignFulfilment: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    // M5 — fulfilment evidence log + participant own-contribution lookup.
    campaignFulfilmentEvent: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    campaignParticipant: { findUnique: vi.fn() },
    campaignContribution: { findFirst: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

vi.mock("../modules/community-buy/support-case.service", () => ({
  supportCaseService: { create: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { supportCaseService } from "../modules/community-buy/support-case.service";
import { campaignFulfilmentService } from "../modules/community-buy/campaign-fulfilment.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  // WS5: every mutating transition now claims its write via updateMany
  // before re-reading the row — default to "claim succeeded" so existing
  // success-path tests don't need to know about this plumbing; tests that
  // specifically exercise the race override this to { count: 0 }.
  m.campaignFulfilment.updateMany.mockResolvedValue({ count: 1 } as never);
  m.campaignFulfilmentEvent.create.mockResolvedValue({} as never);
  m.campaignFulfilmentEvent.findFirst.mockResolvedValue(null);
});

function ownedBySupplier(status: string, extra: Record<string, unknown> = {}) {
  m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "vendor-user-1" } } as never);
  m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1", organiserId: "org-1", title: "Rice bulk buy" } as never);
  m.campaignFulfilment.findUnique.mockResolvedValue({ campaignId: "camp-1", status, method: null, ...extra } as never);
}

function ownedByOrganiser(status: string, extra: Record<string, unknown> = {}) {
  m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
  m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1", organiserId: "org-1", title: "Rice bulk buy" } as never);
  m.campaignFulfilment.findUnique.mockResolvedValue({ campaignId: "camp-1", status, method: null, ...extra } as never);
}

describe("campaignFulfilmentService — ownership checks", () => {
  it("confirmInventory throws 404 when the vendor doesn't own the campaign's supplier profile", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "someone-else" } as never);
    await expect(campaignFulfilmentService.confirmInventory("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 404 when the campaign has no fulfilment record yet (never succeeded)", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "sup-1" } as never);
    m.campaignFulfilment.findUnique.mockResolvedValue(null);
    await expect(campaignFulfilmentService.confirmInventory("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("campaignFulfilmentService — state machine (supplier side)", () => {
  it("confirmInventory moves AWAITING_INVENTORY_CONFIRMATION -> INVENTORY_CONFIRMED", async () => {
    ownedBySupplier("AWAITING_INVENTORY_CONFIRMATION");
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "INVENTORY_CONFIRMED" } as never);
    await campaignFulfilmentService.confirmInventory("vendor-1", "camp-1");
    expect(m.campaignFulfilment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: "camp-1", status: "AWAITING_INVENTORY_CONFIRMATION" }, data: expect.objectContaining({ status: "INVENTORY_CONFIRMED" }) }),
    );
  });

  it("confirmInventory rejects a second confirmation", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED");
    await expect(campaignFulfilmentService.confirmInventory("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  // WS5: two concurrent confirmInventory calls (e.g. a double-tap) both
  // pass the read-time status check — only the guarded write's atomic
  // claim decides the real winner. The loser must not notify twice.
  it("WS5: a losing concurrent confirmInventory call gets 409 and never fires a duplicate notification", async () => {
    ownedBySupplier("AWAITING_INVENTORY_CONFIRMATION");
    m.campaignFulfilment.updateMany.mockResolvedValue({ count: 0 } as never); // another call already won

    await expect(campaignFulfilmentService.confirmInventory("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });

  it("setPlan rejects being set before inventory is confirmed", async () => {
    ownedBySupplier("AWAITING_INVENTORY_CONFIRMATION");
    // Method is COLLECTION here deliberately — this test exercises the
    // inventory-confirmation gate, not M4's delivery-method gating (see the
    // dedicated describe block below for that).
    await expect(
      campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "COLLECTION" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("setPlan rejects being changed after dispatch", async () => {
    ownedBySupplier("DISPATCHED");
    await expect(
      campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "COLLECTION" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("setPlan succeeds once inventory is confirmed", async () => {
    // COLLECTION here deliberately — see the M4 describe block below for
    // DELIVERY-specific gating coverage; this test is only about the
    // inventory-confirmed precondition.
    ownedBySupplier("INVENTORY_CONFIRMED");
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ method: "COLLECTION" } as never);
    await campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "COLLECTION", notes: "Fragile" });
    expect(m.campaignFulfilment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ method: "COLLECTION", notes: "Fragile" }) }),
    );
  });

  it("startPacking requires INVENTORY_CONFIRMED and a plan already set", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED", { method: null });
    await expect(campaignFulfilmentService.startPacking("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("startPacking succeeds once a plan is set", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED", { method: "DELIVERY" });
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "PACKING" } as never);
    await campaignFulfilmentService.startPacking("vendor-1", "camp-1");
    expect(m.campaignFulfilment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PACKING" }) }),
    );
  });

  it("markReady requires PACKING", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED");
    await expect(campaignFulfilmentService.markReady("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("markDispatched rejects when the plan is COLLECTION, not DELIVERY", async () => {
    ownedBySupplier("READY_FOR_DISPATCH_OR_COLLECTION", { method: "COLLECTION" });
    await expect(campaignFulfilmentService.markDispatched("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("markDispatched succeeds for a DELIVERY plan and notifies organiser + participants", async () => {
    ownedBySupplier("READY_FOR_DISPATCH_OR_COLLECTION", { method: "DELIVERY" });
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "DISPATCHED" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({ id: "camp-1", supplierId: "sup-1", organiserId: "org-1", title: "Rice bulk buy" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({
      id: "camp-1", organiser: { userId: "organiser-user" }, participants: [{ userId: "buyer-1" }, { userId: "buyer-2" }],
    } as never);

    await campaignFulfilmentService.markDispatched("vendor-1", "camp-1");

    expect(m.campaignFulfilment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: "camp-1", status: "READY_FOR_DISPATCH_OR_COLLECTION", method: "DELIVERY" }, data: expect.objectContaining({ status: "DISPATCHED" }) }),
    );
    expect(notificationsService.enqueue).toHaveBeenCalledTimes(3); // organiser + 2 participants
  });

  // WS5: the pre-check reads `method` once; folding method into the guarded
  // write itself means a concurrent setPlan() flip (DELIVERY -> COLLECTION)
  // landing between the read and this write can no longer sneak a
  // COLLECTION-planned campaign through as DISPATCHED.
  it("WS5: a concurrent setPlan flipping the method away from DELIVERY makes the guarded dispatch claim 0 rows, not a stale success", async () => {
    ownedBySupplier("READY_FOR_DISPATCH_OR_COLLECTION", { method: "DELIVERY" });
    m.campaignFulfilment.updateMany.mockResolvedValue({ count: 0 } as never); // method/status no longer matches by write time

    await expect(campaignFulfilmentService.markDispatched("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });

  it("markCollected rejects when the plan is DELIVERY, not COLLECTION", async () => {
    ownedBySupplier("READY_FOR_DISPATCH_OR_COLLECTION", { method: "DELIVERY" });
    await expect(campaignFulfilmentService.markCollected("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("campaignFulfilmentService — organiser confirms completion", () => {
  it("rejects confirming completion before dispatch/collection", async () => {
    ownedByOrganiser("PACKING");
    await expect(campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows confirming completion once DISPATCHED", async () => {
    ownedByOrganiser("DISPATCHED");
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "COMPLETED" } as never);
    await campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1");
    expect(m.campaignFulfilment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETED" } }),
    );
  });

  it("allows confirming completion once COLLECTED", async () => {
    ownedByOrganiser("COLLECTED");
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "COMPLETED" } as never);
    await campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1");
    expect(m.campaignFulfilment.updateMany).toHaveBeenCalled();
  });

  it("rejects a caller who isn't the campaign's organiser", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "someone-else" } as never);
    await expect(campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("campaignFulfilmentService — SupplierAccount path (WS3 twins) race guard", () => {
  function ownedBySupplierAccount(status: string, extra: Record<string, unknown> = {}) {
    // requireSupplierAccountOwned reads prisma.supplierAccount, not
    // supplierProfile — mocked separately here since it's not part of the
    // shared prisma mock above.
    (prisma as any).supplierAccount = { findUnique: vi.fn().mockResolvedValue({ id: "acct-1" }) };
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-1", organiserId: "org-1", title: "Rice bulk buy" } as never);
    m.campaignFulfilment.findUnique.mockResolvedValue({ campaignId: "camp-1", status, method: null, ...extra } as never);
  }

  it("WS5: confirmInventoryForAccount is race-guarded the same way as the legacy Vendor path", async () => {
    ownedBySupplierAccount("AWAITING_INVENTORY_CONFIRMATION");
    m.campaignFulfilment.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(campaignFulfilmentService.confirmInventoryForAccount("account-user-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });
});

// M5 — append-only fulfilment evidence (spec §10.2 step 5, Appendix B).
describe("recordFulfilmentEvent() — wired into every existing transition", () => {
  it("confirmInventory logs an INVENTORY_CONFIRMED event attributed to the real vendor user, not the vendorId", async () => {
    ownedBySupplier("AWAITING_INVENTORY_CONFIRMATION");
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "INVENTORY_CONFIRMED" } as never);

    await campaignFulfilmentService.confirmInventory("vendor-1", "camp-1");

    expect(m.campaignFulfilmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ campaignId: "camp-1", actorUserId: "vendor-user-1", actorRole: "SUPPLIER", eventType: "INVENTORY_CONFIRMED" }),
    }));
  });

  it("a fulfilment event log failure never breaks the transition it's recording (never-throws contract)", async () => {
    ownedBySupplier("AWAITING_INVENTORY_CONFIRMATION");
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "INVENTORY_CONFIRMED" } as never);
    m.campaignFulfilmentEvent.create.mockRejectedValue(new Error("DB down"));

    const result = await campaignFulfilmentService.confirmInventory("vendor-1", "camp-1");
    expect(result.status).toBe("INVENTORY_CONFIRMED");
  });

  it("organiserConfirmCompletion logs a COMPLETED event attributed to the organiser", async () => {
    ownedByOrganiser("DISPATCHED");
    m.campaignFulfilment.findUniqueOrThrow.mockResolvedValue({ status: "COMPLETED" } as never);

    await campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1");

    expect(m.campaignFulfilmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorUserId: "organiser-user-1", actorRole: "ORGANISER", eventType: "COMPLETED" }),
    }));
  });
});

describe("reportExceptionForVendor()/reportExceptionForAccount() — informational overlay, never changes fulfilment.status", () => {
  it("records an EXCEPTION event and notifies the organiser, without touching CampaignFulfilment", async () => {
    ownedBySupplier("PACKING");
    // notifyOrganiser() makes its own separate communityCampaign lookup
    // (with organiser included) after requireSupplierOwned()'s own lookup —
    // same two-call pattern the pre-existing confirmInventory tests above use.
    m.communityCampaign.findUnique.mockResolvedValueOnce({ id: "camp-1", supplierId: "sup-1", organiserId: "org-1", title: "Rice bulk buy" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({ id: "camp-1", title: "Rice bulk buy", organiser: { userId: "organiser-user-1" } } as never);

    await campaignFulfilmentService.reportExceptionForVendor("vendor-1", "camp-1", "Stock damaged in transit");

    expect(m.campaignFulfilmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorRole: "SUPPLIER", eventType: "EXCEPTION", note: "Stock damaged in transit" }),
    }));
    expect(m.campaignFulfilment.update).not.toHaveBeenCalled();
    expect(m.campaignFulfilment.updateMany).not.toHaveBeenCalled();
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "organiser-user-1" }));
  });

  it("404s for a vendor who doesn't own the campaign", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1", vendor: { userId: "vendor-user-1" } } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", supplierId: "someone-else" } as never);
    await expect(campaignFulfilmentService.reportExceptionForVendor("vendor-1", "camp-1", "issue")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("confirmReceiptForParticipant() — participant-authorized, cannot be forged by a supplier", () => {
  it("requires an owned PAID contribution — 404 if the caller never joined", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue(null);
    await expect(campaignFulfilmentService.confirmReceiptForParticipant("buyer-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s if the participant joined but has no captured (PAID) order yet", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst.mockResolvedValue(null);
    await expect(campaignFulfilmentService.confirmReceiptForParticipant("buyer-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("records exactly one PARTICIPANT_RECEIPT_CONFIRMED event for a genuine captured order", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst.mockResolvedValue({ id: "contrib-1" } as never);

    const result = await campaignFulfilmentService.confirmReceiptForParticipant("buyer-1", "camp-1");

    expect(result).toEqual({ confirmed: true });
    expect(m.campaignFulfilmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contributionId: "contrib-1", actorUserId: "buyer-1", actorRole: "PARTICIPANT", eventType: "PARTICIPANT_RECEIPT_CONFIRMED" }),
    }));
  });

  it("is idempotent — a repeat confirmation does not create a second event", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst.mockResolvedValue({ id: "contrib-1" } as never);
    m.campaignFulfilmentEvent.findFirst.mockResolvedValue({ id: "existing-event" } as never);

    await campaignFulfilmentService.confirmReceiptForParticipant("buyer-1", "camp-1");

    expect(m.campaignFulfilmentEvent.create).not.toHaveBeenCalled();
  });
});

describe("reportFulfilmentProblem() — reuses the existing CommunityBuySupportCase workflow, not a new ticket system", () => {
  it("logs a PARTICIPANT_PROBLEM_REPORTED event and creates a FULFILMENT_ISSUE support case", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst.mockResolvedValue({ id: "contrib-1" } as never);
    vi.mocked(supportCaseService.create).mockResolvedValue({ id: "case-1" } as never);

    const result = await campaignFulfilmentService.reportFulfilmentProblem("buyer-1", "camp-1", "Order never arrived", ["https://example.com/photo.jpg"]);

    expect(result).toEqual({ id: "case-1" });
    expect(supportCaseService.create).toHaveBeenCalledWith("buyer-1", "camp-1", { caseType: "FULFILMENT_ISSUE", description: "Order never arrived", evidenceUrls: ["https://example.com/photo.jpg"] });
    expect(m.campaignFulfilmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: "PARTICIPANT_PROBLEM_REPORTED", actorRole: "PARTICIPANT", note: "Order never arrived" }),
    }));
  });

  it("404s without an owned captured contribution — cannot report a problem for an order that was never charged", async () => {
    m.campaignParticipant.findUnique.mockResolvedValue({ id: "part-1" } as never);
    m.campaignContribution.findFirst.mockResolvedValue(null);
    await expect(campaignFulfilmentService.reportFulfilmentProblem("buyer-1", "camp-1", "issue")).rejects.toMatchObject({ statusCode: 404 });
    expect(supportCaseService.create).not.toHaveBeenCalled();
  });
});

describe("getFulfilmentEvents* — evidence timeline read, ownership-scoped", () => {
  it("organiser can read their own campaign's event timeline", async () => {
    ownedByOrganiser("COMPLETED");
    m.campaignFulfilmentEvent.findMany.mockResolvedValue([{ id: "evt-1", eventType: "COMPLETED" }] as never);

    const events = await campaignFulfilmentService.getFulfilmentEventsForOrganiser("organiser-user-1", "camp-1");

    expect(events).toHaveLength(1);
    expect(m.campaignFulfilmentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { campaignId: "camp-1" } }));
  });

  it("admin read has no ownership check at all (already gated at the route/permission layer)", async () => {
    m.campaignFulfilmentEvent.findMany.mockResolvedValue([]);
    await campaignFulfilmentService.getFulfilmentEventsForAdmin("camp-1");
    expect(m.campaignFulfilmentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { campaignId: "camp-1" } }));
  });
});
