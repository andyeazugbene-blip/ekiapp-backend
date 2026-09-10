import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
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
  /**
   * Participant-facing read — unlike getForSupplier/getForOrganiser, this
   * has no ownership check (any participant, or a browsing buyer who
   * hasn't joined yet, may see a campaign's fulfilment plan) and returns
   * null rather than throwing when no plan exists yet (normal for any
   * campaign that hasn't succeeded — nothing to invent, nothing to hide).
   */
  async getForParticipant(campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    return prisma.campaignFulfilment.findUnique({ where: { campaignId } });
  },

  async getForSupplier(vendorId: string, campaignId: string) {
    const { fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    return fulfilment;
  },

  async getForOrganiser(userId: string, campaignId: string) {
    const { fulfilment } = await requireOrganiserOwned(userId, campaignId);
    return fulfilment;
  },

  async confirmInventory(vendorId: string, campaignId: string) {
    const { campaign, fulfilment } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "AWAITING_INVENTORY_CONFIRMATION") {
      throw new AppError("Inventory has already been confirmed for this campaign", 409);
    }
    const updated = await prisma.campaignFulfilment.update({
      where: { campaignId },
      data: { status: "INVENTORY_CONFIRMED", inventoryConfirmedAt: new Date() },
    });
    // Fires only after the status transition above actually succeeds. The
    // AWAITING_INVENTORY_CONFIRMATION -> INVENTORY_CONFIRMED move is
    // one-directional and already guarded above, so a genuine retry gets a
    // 409 before reaching here — the dedupeKey is defence in depth, not
    // the only thing preventing a duplicate.
    await notifyOrganiser(
      campaign.id,
      "inventory_confirmed",
      "Supplier confirmed inventory",
      `Your supplier confirmed they can fulfil ${campaign.confirmedShares} confirmed share${campaign.confirmedShares === 1 ? "" : "s"} of "${campaign.title}".`,
      `inventory_confirmed:${campaign.id}`,
    );
    return updated;
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

async function notifyOrganiser(campaignId: string, event: string, title: string, body: string, dedupeKey: string) {
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
  if (!campaign) return;
  // A notification must never be able to fail a fulfilment transition that
  // already succeeded — see the identical defensive comment on
  // notifyCampaign() in community-campaigns.service.ts.
  try {
    await notificationsService.enqueue({
      userId: campaign.organiser.userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title,
      body,
      data: { type: "community_campaign_update", event, campaignId },
      dedupeKey,
    });
  } catch (error) {
    logger.error("Community Buy fulfilment notification failed (non-blocking)", {
      event,
      campaignId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function notifyOrganiserAndParticipants(campaignId: string, title: string, notifTitle: string, body: string) {
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id: campaignId },
    include: { organiser: true, participants: true },
  });
  if (!campaign) return;
  const recipients = [campaign.organiser.userId, ...campaign.participants.map((p) => p.userId)];
  for (const userId of recipients) {
    // NAV-08 fix: "fulfilment_update" fires under the IDENTICAL event name
    // to both the organiser and every participant — tagging the organiser's
    // own copy with audience:"organiser" is what lets the frontend route
    // them to the management screen without misrouting participants, who
    // share this exact event name and get no audience field at all.
    const audience = userId === campaign.organiser.userId ? "organiser" : undefined;
    await notificationsService.enqueue({
      userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: notifTitle,
      body,
      data: { type: "community_campaign_update", event: "fulfilment_update", campaignId, ...(audience ? { audience } : {}) },
    });
  }
}
