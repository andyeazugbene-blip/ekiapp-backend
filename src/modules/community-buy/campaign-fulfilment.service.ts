import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";

/**
 * Operational fulfilment tracking for a succeeded campaign — doc Phase 8.
 * Strictly separate from CampaignSupplierPayment: progressing this state
 * machine never moves money. Supplier payment release/hold stays a
 * distinct, admin-controlled action in campaign-contributions.service.ts.
 *
 * State machine (supplier-driven, one direction only):
 *   AWAITING_INVENTORY_CONFIRMATION -> INVENTORY_CONFIRMED -> PACKING
 *   -> READY_FOR_DISPATCH_OR_COLLECTION -> DISPATCHED | COLLECTED
 * Then the organiser confirms receipt, closing it out at COMPLETED.
 */

async function requireSupplierOwned(vendorId: string, campaignId: string) {
  const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !supplier || campaign.supplierId !== supplier.id) {
    throw new AppError("Campaign not found", 404);
  }
  const fulfilment = await prisma.campaignFulfilment.findUnique({ where: { campaignId } });
  if (!fulfilment) throw new AppError("This campaign has no fulfilment record yet", 404);
  return { campaign, fulfilment };
}

async function requireOrganiserOwned(userId: string, campaignId: string) {
  const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !organiser || campaign.organiserId !== organiser.id) {
    throw new AppError("Campaign not found", 404);
  }
  const fulfilment = await prisma.campaignFulfilment.findUnique({ where: { campaignId } });
  if (!fulfilment) throw new AppError("This campaign has no fulfilment record yet", 404);
  return { campaign, fulfilment };
}

export const campaignFulfilmentService = {
  async getForSupplier(vendorId: string, campaignId: string) {
    const { fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    return fulfilment;
  },

  async getForOrganiser(userId: string, campaignId: string) {
    const { fulfilment } = await requireOrganiserOwned(userId, campaignId);
    return fulfilment;
  },

  async confirmInventory(vendorId: string, campaignId: string) {
    const { fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "AWAITING_INVENTORY_CONFIRMATION") {
      throw new AppError("Inventory has already been confirmed for this campaign", 409);
    }
    return prisma.campaignFulfilment.update({
      where: { campaignId },
      data: { status: "INVENTORY_CONFIRMED", inventoryConfirmedAt: new Date() },
    });
  },

  /** Fulfilment plan — method (delivery/collection), an optional estimated-ready date, and free-text notes. Settable any time before dispatch/collection. */
  async setPlan(vendorId: string, campaignId: string, input: { method: "DELIVERY" | "COLLECTION"; estimatedReadyAt?: string; notes?: string }) {
    const { fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status === "AWAITING_INVENTORY_CONFIRMATION") {
      throw new AppError("Confirm inventory before setting a fulfilment plan", 409);
    }
    if (fulfilment.status === "DISPATCHED" || fulfilment.status === "COLLECTED" || fulfilment.status === "COMPLETED") {
      throw new AppError("This campaign has already been dispatched or collected", 409);
    }
    return prisma.campaignFulfilment.update({
      where: { campaignId },
      data: {
        method: input.method,
        estimatedReadyAt: input.estimatedReadyAt ? new Date(input.estimatedReadyAt) : undefined,
        notes: input.notes,
      },
    });
  },

  async startPacking(vendorId: string, campaignId: string) {
    const { fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "INVENTORY_CONFIRMED") {
      throw new AppError("Confirm inventory before starting packing", 409);
    }
    if (!fulfilment.method) throw new AppError("Set a fulfilment plan (delivery or collection) before starting packing", 409);
    return prisma.campaignFulfilment.update({
      where: { campaignId },
      data: { status: "PACKING", packingStartedAt: new Date() },
    });
  },

  async markReady(vendorId: string, campaignId: string) {
    const { fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "PACKING") throw new AppError("Start packing before marking this campaign ready", 409);
    return prisma.campaignFulfilment.update({
      where: { campaignId },
      data: { status: "READY_FOR_DISPATCH_OR_COLLECTION", readyAt: new Date() },
    });
  },

  async markDispatched(vendorId: string, campaignId: string) {
    const { campaign, fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "READY_FOR_DISPATCH_OR_COLLECTION") throw new AppError("This campaign is not ready for dispatch", 409);
    if (fulfilment.method !== "DELIVERY") throw new AppError("This campaign's fulfilment plan is collection, not delivery", 409);
    const updated = await prisma.campaignFulfilment.update({
      where: { campaignId },
      data: { status: "DISPATCHED", dispatchedAt: new Date() },
    });
    await notifyOrganiserAndParticipants(campaign.id, campaign.title, "Your Community Buy has been dispatched", `${campaign.title} has been dispatched by the supplier.`);
    return updated;
  },

  async markCollected(vendorId: string, campaignId: string) {
    const { campaign, fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "READY_FOR_DISPATCH_OR_COLLECTION") throw new AppError("This campaign is not ready for collection", 409);
    if (fulfilment.method !== "COLLECTION") throw new AppError("This campaign's fulfilment plan is delivery, not collection", 409);
    const updated = await prisma.campaignFulfilment.update({
      where: { campaignId },
      data: { status: "COLLECTED", collectedAt: new Date() },
    });
    await notifyOrganiserAndParticipants(campaign.id, campaign.title, "Your Community Buy is ready for collection", `${campaign.title} is ready for collection from the supplier.`);
    return updated;
  },

  /** Organiser confirms the campaign's goods were actually received/collected — closes fulfilment out. */
  async organiserConfirmCompletion(userId: string, campaignId: string) {
    const { fulfilment } = await requireOrganiserOwned(userId, campaignId);
    if (fulfilment.status !== "DISPATCHED" && fulfilment.status !== "COLLECTED") {
      throw new AppError("This campaign hasn't been dispatched or collected yet", 409);
    }
    return prisma.campaignFulfilment.update({
      where: { campaignId },
      data: { status: "COMPLETED" },
    });
  },
};

async function notifyOrganiserAndParticipants(campaignId: string, title: string, notifTitle: string, body: string) {
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id: campaignId },
    include: { organiser: true, participants: true },
  });
  if (!campaign) return;
  const recipients = [campaign.organiser.userId, ...campaign.participants.map((p) => p.userId)];
  for (const userId of recipients) {
    await notificationsService.enqueue({
      userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: notifTitle,
      body,
      data: { type: "community_campaign_update", event: "fulfilment_update", campaignId },
    });
  }
}
