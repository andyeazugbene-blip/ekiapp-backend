import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    supplierProfile: { findUnique: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    communityCampaign: { findUnique: vi.fn() },
    campaignFulfilment: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { notificationsService } from "../modules/notifications/notifications.service";
import { campaignFulfilmentService } from "../modules/community-buy/campaign-fulfilment.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

function ownedBySupplier(status: string, extra: Record<string, unknown> = {}) {
  m.supplierProfile.findUnique.mockResolvedValue({ id: "sup-1" } as never);
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
    m.campaignFulfilment.update.mockResolvedValue({ status: "INVENTORY_CONFIRMED" } as never);
    await campaignFulfilmentService.confirmInventory("vendor-1", "camp-1");
    expect(m.campaignFulfilment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "INVENTORY_CONFIRMED" }) }),
    );
  });

  it("confirmInventory rejects a second confirmation", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED");
    await expect(campaignFulfilmentService.confirmInventory("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("setPlan rejects being set before inventory is confirmed", async () => {
    ownedBySupplier("AWAITING_INVENTORY_CONFIRMATION");
    await expect(
      campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "DELIVERY" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("setPlan rejects being changed after dispatch", async () => {
    ownedBySupplier("DISPATCHED");
    await expect(
      campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "COLLECTION" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("setPlan succeeds once inventory is confirmed", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED");
    m.campaignFulfilment.update.mockResolvedValue({ method: "DELIVERY" } as never);
    await campaignFulfilmentService.setPlan("vendor-1", "camp-1", { method: "DELIVERY", notes: "Fragile" });
    expect(m.campaignFulfilment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ method: "DELIVERY", notes: "Fragile" }) }),
    );
  });

  it("startPacking requires INVENTORY_CONFIRMED and a plan already set", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED", { method: null });
    await expect(campaignFulfilmentService.startPacking("vendor-1", "camp-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("startPacking succeeds once a plan is set", async () => {
    ownedBySupplier("INVENTORY_CONFIRMED", { method: "DELIVERY" });
    m.campaignFulfilment.update.mockResolvedValue({ status: "PACKING" } as never);
    await campaignFulfilmentService.startPacking("vendor-1", "camp-1");
    expect(m.campaignFulfilment.update).toHaveBeenCalledWith(
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
    m.campaignFulfilment.update.mockResolvedValue({ status: "DISPATCHED" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({ id: "camp-1", supplierId: "sup-1", organiserId: "org-1", title: "Rice bulk buy" } as never);
    m.communityCampaign.findUnique.mockResolvedValueOnce({
      id: "camp-1", organiser: { userId: "organiser-user" }, participants: [{ userId: "buyer-1" }, { userId: "buyer-2" }],
    } as never);

    await campaignFulfilmentService.markDispatched("vendor-1", "camp-1");

    expect(m.campaignFulfilment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DISPATCHED" }) }),
    );
    expect(notificationsService.enqueue).toHaveBeenCalledTimes(3); // organiser + 2 participants
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
    m.campaignFulfilment.update.mockResolvedValue({ status: "COMPLETED" } as never);
    await campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1");
    expect(m.campaignFulfilment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETED" } }),
    );
  });

  it("allows confirming completion once COLLECTED", async () => {
    ownedByOrganiser("COLLECTED");
    m.campaignFulfilment.update.mockResolvedValue({ status: "COMPLETED" } as never);
    await campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1");
    expect(m.campaignFulfilment.update).toHaveBeenCalled();
  });

  it("rejects a caller who isn't the campaign's organiser", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "someone-else" } as never);
    await expect(campaignFulfilmentService.organiserConfirmCompletion("organiser-user-1", "camp-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});
