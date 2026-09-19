import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { isIndividualDeliveryEnabled } from "./community-buy-privacy.service";
import { supportCaseService } from "./support-case.service";

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
  // M5: vendor also selected (userId only) so every mutating function below
  // can attribute its CampaignFulfilmentEvent to the real acting user
  // without changing any existing function's public signature/call sites.
  const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId }, include: { vendor: { select: { userId: true } } } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !supplier || campaign.supplierId !== supplier.id) {
    throw new AppError("Campaign not found", 404);
  }
  const fulfilment = await prisma.campaignFulfilment.findUnique({ where: { campaignId } });
  if (!fulfilment) throw new AppError("This campaign has no fulfilment record yet", 404);
  return { campaign, fulfilment, actorUserId: supplier.vendor.userId };
}

/**
 * Workstream 3 — same ownership gate as requireSupplierOwned() above, for
 * the no-Vendor SupplierAccount path. Deliberately a separate function
 * (not merged into requireSupplierOwned) so the legacy vendorId-keyed path
 * stays completely untouched — see the plan's "dual-path resolver, not a
 * rewrite" principle.
 */
async function requireSupplierAccountOwned(userId: string, campaignId: string) {
  const account = await prisma.supplierAccount.findUnique({ where: { userId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !account || campaign.supplierAccountId !== account.id) {
    throw new AppError("Campaign not found", 404);
  }
  const fulfilment = await prisma.campaignFulfilment.findUnique({ where: { campaignId } });
  if (!fulfilment) throw new AppError("This campaign has no fulfilment record yet", 404);
  return { campaign, fulfilment, actorUserId: userId };
}

/**
 * M4 (spec §14.2, AT-38) — a second, independent gate against a supplier
 * setting DELIVERY at fulfilment time. Two checks, both required: the
 * global kill-switch, AND the campaign's own organiser-set intent — a
 * supplier can never pick DELIVERY for a campaign the organiser created as
 * COLLECTION, even while the flag happens to be on. Never silently
 * downgrades to COLLECTION; rejects the request outright.
 */
function assertFulfilmentMethodAllowed(method: "DELIVERY" | "COLLECTION", campaign: { deliveryPreference: string }): void {
  if (method !== "DELIVERY") return;
  if (!isIndividualDeliveryEnabled()) {
    throw new AppError("Individual delivery is not available yet — use collection point.", 400, undefined, "INDIVIDUAL_DELIVERY_NOT_AVAILABLE");
  }
  if (campaign.deliveryPreference !== "DELIVERY") {
    throw new AppError("This campaign was created as collection-point only — its fulfilment method cannot be changed to delivery.", 409, undefined, "DELIVERY_METHOD_MISMATCH");
  }
}

/**
 * M5 (spec §10.2 step 5 "fulfilment evidence"; Appendix B event catalogue)
 * — append-only historical record alongside CampaignFulfilment's mutable
 * current-state row. Mirrors community-buy-privacy.service.ts's
 * recordDataAccess()'s never-throws contract exactly: a logging failure
 * must never break the fulfilment transition it's recording.
 */
async function recordFulfilmentEvent(entry: {
  campaignId: string;
  contributionId?: string | null;
  actorUserId: string;
  actorRole: "SUPPLIER" | "ORGANISER" | "PARTICIPANT" | "ADMIN";
  eventType: "INVENTORY_CONFIRMED" | "PLAN_SET" | "PACKING_STARTED" | "READY" | "DISPATCHED" | "COLLECTED" | "COMPLETED" | "EXCEPTION" | "PARTICIPANT_RECEIPT_CONFIRMED" | "PARTICIPANT_PROBLEM_REPORTED";
  note?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await prisma.campaignFulfilmentEvent.create({
      data: {
        campaignId: entry.campaignId,
        contributionId: entry.contributionId ?? null,
        actorUserId: entry.actorUserId,
        actorRole: entry.actorRole,
        eventType: entry.eventType,
        note: entry.note ?? null,
        metadata: (entry.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
  } catch (error) {
    logger.error("Community Buy fulfilment event log write failed", {
      campaignId: entry.campaignId,
      eventType: entry.eventType,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

// Phase 6 (delivery + collection/tracking) — closes the wiring gap between
// the campaign-wide CampaignFulfilment state machine and each individual
// participant's own DeliveryReference row: dispatching the whole campaign
// hands every DELIVERY-method participant's order to the courier at once.
// Best-effort/never-throws, same contract as recordFulfilmentEvent() —
// a logging/bookkeeping failure here must never roll back the dispatch
// transition it's riding behind.
async function bulkMarkHandedToCourier(campaignId: string): Promise<void> {
  try {
    await prisma.deliveryReference.updateMany({
      where: { campaignId, deliveryMethod: "DELIVERY", status: "PENDING" },
      data: { status: "HANDED_TO_COURIER" },
    });
  } catch (error) {
    logger.error("Failed to bulk-update DeliveryReference to HANDED_TO_COURIER", {
      campaignId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

// Phase 6 — no real courier-webhook integration exists (see
// community-buy-privacy.service.ts's own doc comment on why one isn't
// invented here), so the participant's own receipt confirmation IS the
// delivered signal for a DELIVERY-method order — never touches a
// COLLECTION-method row, which only ever completes via a verified
// collection code (a stronger, physical-handover proof). Never throws
// beyond what confirmReceiptForParticipant() itself already risks — this
// runs after that function's own idempotent event check.
async function markOwnDeliveryReferenceDelivered(contributionId: string): Promise<void> {
  try {
    await prisma.deliveryReference.updateMany({
      where: { contributionId, deliveryMethod: "DELIVERY", status: { not: "DELIVERED" } },
      data: { status: "DELIVERED" },
    });
  } catch (error) {
    logger.error("Failed to mark DeliveryReference DELIVERED from participant receipt confirmation", {
      contributionId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function markOwnDeliveryReferenceException(contributionId: string): Promise<void> {
  try {
    await prisma.deliveryReference.updateMany({
      where: { contributionId, status: { notIn: ["DELIVERED", "COLLECTED", "REVOKED"] } },
      data: { status: "EXCEPTION" },
    });
  } catch (error) {
    logger.error("Failed to mark DeliveryReference EXCEPTION from participant problem report", {
      contributionId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function requireOrganiserOwned(userId: string, campaignId: string) {
  const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !organiser || campaign.organiserId !== organiser.id) {
    throw new AppError("Campaign not found", 404);
  }
  const fulfilment = await prisma.campaignFulfilment.findUnique({ where: { campaignId } });
  if (!fulfilment) throw new AppError("This campaign has no fulfilment record yet", 404);
  return { campaign, fulfilment, actorUserId: userId };
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
    const { campaign, fulfilment, actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "AWAITING_INVENTORY_CONFIRMATION") {
      throw new AppError("Inventory has already been confirmed for this campaign", 409);
    }
    // WS5: atomic claim — the pre-check above reads a snapshot that can be
    // stale by the time this write runs (two concurrent calls, e.g. a
    // double-tap). Guarding the write itself on the still-expected prior
    // status means only one caller's write actually lands; the loser gets
    // the same 409 as if it had lost the read-time check.
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "AWAITING_INVENTORY_CONFIRMATION" },
      data: { status: "INVENTORY_CONFIRMED", inventoryConfirmedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("Inventory has already been confirmed for this campaign", 409);
    const updated = await prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "INVENTORY_CONFIRMED" });
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
    const { campaign, fulfilment, actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    assertFulfilmentMethodAllowed(input.method, campaign);
    if (fulfilment.status === "AWAITING_INVENTORY_CONFIRMATION") {
      throw new AppError("Confirm inventory before setting a fulfilment plan", 409);
    }
    if (fulfilment.status === "DISPATCHED" || fulfilment.status === "COLLECTED" || fulfilment.status === "COMPLETED") {
      throw new AppError("This campaign has already been dispatched or collected", 409);
    }
    // WS5: same atomic-claim guard — a concurrent dispatch/collect call
    // must not have this plan change land after the campaign has already
    // moved past the point where a plan still makes sense.
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: { notIn: ["AWAITING_INVENTORY_CONFIRMATION", "DISPATCHED", "COLLECTED", "COMPLETED"] } },
      data: {
        method: input.method,
        estimatedReadyAt: input.estimatedReadyAt ? new Date(input.estimatedReadyAt) : undefined,
        notes: input.notes,
      },
    });
    if (claim.count !== 1) throw new AppError("This campaign has already been dispatched or collected", 409);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "PLAN_SET", metadata: { method: input.method } });
    return prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
  },

  async startPacking(vendorId: string, campaignId: string) {
    const { fulfilment, actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "INVENTORY_CONFIRMED") {
      throw new AppError("Confirm inventory before starting packing", 409);
    }
    if (!fulfilment.method) throw new AppError("Set a fulfilment plan (delivery or collection) before starting packing", 409);
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "INVENTORY_CONFIRMED" },
      data: { status: "PACKING", packingStartedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("Confirm inventory before starting packing", 409);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "PACKING_STARTED" });
    return prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
  },

  async markReady(vendorId: string, campaignId: string) {
    const { fulfilment, actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "PACKING") throw new AppError("Start packing before marking this campaign ready", 409);
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "PACKING" },
      data: { status: "READY_FOR_DISPATCH_OR_COLLECTION", readyAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("Start packing before marking this campaign ready", 409);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "READY" });
    return prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
  },

  async markDispatched(vendorId: string, campaignId: string) {
    const { campaign, fulfilment, actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "READY_FOR_DISPATCH_OR_COLLECTION") throw new AppError("This campaign is not ready for dispatch", 409);
    if (fulfilment.method !== "DELIVERY") throw new AppError("This campaign's fulfilment plan is collection, not delivery", 409);
    // WS5: method is folded into the guard itself, not just the pre-check —
    // a concurrent setPlan() flipping method between the read above and
    // this write can no longer sneak a COLLECTION-planned campaign through
    // as DISPATCHED.
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "READY_FOR_DISPATCH_OR_COLLECTION", method: "DELIVERY" },
      data: { status: "DISPATCHED", dispatchedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("This campaign is not ready for dispatch", 409);
    const updated = await prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "DISPATCHED" });
    await bulkMarkHandedToCourier(campaignId);
    await notifyOrganiserAndParticipants(campaign.id, campaign.title, "Your Community Buy has been dispatched", `${campaign.title} has been dispatched by the supplier.`);
    return updated;
  },

  async markCollected(vendorId: string, campaignId: string) {
    const { campaign, fulfilment, actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    if (fulfilment.status !== "READY_FOR_DISPATCH_OR_COLLECTION") throw new AppError("This campaign is not ready for collection", 409);
    if (fulfilment.method !== "COLLECTION") throw new AppError("This campaign's fulfilment plan is delivery, not collection", 409);
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "READY_FOR_DISPATCH_OR_COLLECTION", method: "COLLECTION" },
      data: { status: "COLLECTED", collectedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("This campaign is not ready for collection", 409);
    const updated = await prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "COLLECTED" });
    await notifyOrganiserAndParticipants(campaign.id, campaign.title, "Your Community Buy is ready for collection", `${campaign.title} is ready for collection from the supplier.`);
    return updated;
  },

  /** Organiser confirms the campaign's goods were actually received/collected — closes fulfilment out. */
  async organiserConfirmCompletion(userId: string, campaignId: string) {
    const { fulfilment, actorUserId } = await requireOrganiserOwned(userId, campaignId);
    if (fulfilment.status !== "DISPATCHED" && fulfilment.status !== "COLLECTED") {
      throw new AppError("This campaign hasn't been dispatched or collected yet", 409);
    }
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: { in: ["DISPATCHED", "COLLECTED"] } },
      data: { status: "COMPLETED" },
    });
    if (claim.count !== 1) throw new AppError("This campaign hasn't been dispatched or collected yet", 409);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "ORGANISER", eventType: "COMPLETED" });
    return prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
  },

  // ─── Workstream 3 — no-Vendor SupplierAccount path. Each method below is
  // the exact same state-machine action as its vendorId-keyed twin above,
  // gated by requireSupplierAccountOwned() instead of requireSupplierOwned()
  // — kept as separate functions rather than a shared/merged implementation
  // so the legacy path above is provably untouched by this workstream. ────

  async getForSupplierAccount(userId: string, campaignId: string) {
    const { fulfilment } = await requireSupplierAccountOwned(userId, campaignId);
    return fulfilment;
  },

  async confirmInventoryForAccount(userId: string, campaignId: string) {
    const { campaign, fulfilment, actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    if (fulfilment.status !== "AWAITING_INVENTORY_CONFIRMATION") {
      throw new AppError("Inventory has already been confirmed for this campaign", 409);
    }
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "AWAITING_INVENTORY_CONFIRMATION" },
      data: { status: "INVENTORY_CONFIRMED", inventoryConfirmedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("Inventory has already been confirmed for this campaign", 409);
    const updated = await prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "INVENTORY_CONFIRMED" });
    await notifyOrganiser(
      campaign.id,
      "inventory_confirmed",
      "Supplier confirmed inventory",
      `Your supplier confirmed they can fulfil ${campaign.confirmedShares} confirmed share${campaign.confirmedShares === 1 ? "" : "s"} of "${campaign.title}".`,
      `inventory_confirmed:${campaign.id}`,
    );
    return updated;
  },

  async setPlanForAccount(userId: string, campaignId: string, input: { method: "DELIVERY" | "COLLECTION"; estimatedReadyAt?: string; notes?: string }) {
    const { campaign, fulfilment, actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    assertFulfilmentMethodAllowed(input.method, campaign);
    if (fulfilment.status === "AWAITING_INVENTORY_CONFIRMATION") {
      throw new AppError("Confirm inventory before setting a fulfilment plan", 409);
    }
    if (fulfilment.status === "DISPATCHED" || fulfilment.status === "COLLECTED" || fulfilment.status === "COMPLETED") {
      throw new AppError("This campaign has already been dispatched or collected", 409);
    }
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: { notIn: ["AWAITING_INVENTORY_CONFIRMATION", "DISPATCHED", "COLLECTED", "COMPLETED"] } },
      data: {
        method: input.method,
        estimatedReadyAt: input.estimatedReadyAt ? new Date(input.estimatedReadyAt) : undefined,
        notes: input.notes,
      },
    });
    if (claim.count !== 1) throw new AppError("This campaign has already been dispatched or collected", 409);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "PLAN_SET", metadata: { method: input.method } });
    return prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
  },

  async startPackingForAccount(userId: string, campaignId: string) {
    const { fulfilment, actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    if (fulfilment.status !== "INVENTORY_CONFIRMED") {
      throw new AppError("Confirm inventory before starting packing", 409);
    }
    if (!fulfilment.method) throw new AppError("Set a fulfilment plan (delivery or collection) before starting packing", 409);
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "INVENTORY_CONFIRMED" },
      data: { status: "PACKING", packingStartedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("Confirm inventory before starting packing", 409);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "PACKING_STARTED" });
    return prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
  },

  async markReadyForAccount(userId: string, campaignId: string) {
    const { fulfilment, actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    if (fulfilment.status !== "PACKING") throw new AppError("Start packing before marking this campaign ready", 409);
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "PACKING" },
      data: { status: "READY_FOR_DISPATCH_OR_COLLECTION", readyAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("Start packing before marking this campaign ready", 409);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "READY" });
    return prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
  },

  async markDispatchedForAccount(userId: string, campaignId: string) {
    const { campaign, fulfilment, actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    if (fulfilment.status !== "READY_FOR_DISPATCH_OR_COLLECTION") throw new AppError("This campaign is not ready for dispatch", 409);
    if (fulfilment.method !== "DELIVERY") throw new AppError("This campaign's fulfilment plan is collection, not delivery", 409);
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "READY_FOR_DISPATCH_OR_COLLECTION", method: "DELIVERY" },
      data: { status: "DISPATCHED", dispatchedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("This campaign is not ready for dispatch", 409);
    const updated = await prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "DISPATCHED" });
    await bulkMarkHandedToCourier(campaignId);
    await notifyOrganiserAndParticipants(campaign.id, campaign.title, "Your Community Buy has been dispatched", `${campaign.title} has been dispatched by the supplier.`);
    return updated;
  },

  async markCollectedForAccount(userId: string, campaignId: string) {
    const { campaign, fulfilment, actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    if (fulfilment.status !== "READY_FOR_DISPATCH_OR_COLLECTION") throw new AppError("This campaign is not ready for collection", 409);
    if (fulfilment.method !== "COLLECTION") throw new AppError("This campaign's fulfilment plan is delivery, not collection", 409);
    const claim = await prisma.campaignFulfilment.updateMany({
      where: { campaignId, status: "READY_FOR_DISPATCH_OR_COLLECTION", method: "COLLECTION" },
      data: { status: "COLLECTED", collectedAt: new Date() },
    });
    if (claim.count !== 1) throw new AppError("This campaign is not ready for collection", 409);
    const updated = await prisma.campaignFulfilment.findUniqueOrThrow({ where: { campaignId } });
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "COLLECTED" });
    await notifyOrganiserAndParticipants(campaign.id, campaign.title, "Your Community Buy is ready for collection", `${campaign.title} is ready for collection from the supplier.`);
    return updated;
  },

  // ─── M5 — participant-facing evidence: receipt confirmation and problem
  // reporting. Participant-authorized only (requires an owned PAID
  // contribution for this campaign) — a supplier can never forge these.

  /** Participant confirms they actually received/collected their own order. Idempotent — a repeat call is a harmless no-op, not a duplicate event. */
  async confirmReceiptForParticipant(userId: string, campaignId: string) {
    const contribution = await requireOwnPaidContribution(userId, campaignId);
    const already = await prisma.campaignFulfilmentEvent.findFirst({
      where: { campaignId, contributionId: contribution.id, eventType: "PARTICIPANT_RECEIPT_CONFIRMED" },
      select: { id: true },
    });
    if (already) return { confirmed: true };
    await recordFulfilmentEvent({ campaignId, contributionId: contribution.id, actorUserId: userId, actorRole: "PARTICIPANT", eventType: "PARTICIPANT_RECEIPT_CONFIRMED" });
    await markOwnDeliveryReferenceDelivered(contribution.id);
    return { confirmed: true };
  },

  /**
   * Participant reports a fulfilment problem. Reuses the existing
   * CommunityBuySupportCase ticket workflow (already has description/
   * evidenceUrls/admin-triage/escalation built — see support-case.service.ts)
   * rather than inventing a second, parallel ticket system; the fulfilment
   * event log entry is only the append-only timeline marker.
   */
  async reportFulfilmentProblem(userId: string, campaignId: string, description: string, evidenceUrls?: string[]) {
    const contribution = await requireOwnPaidContribution(userId, campaignId);
    await recordFulfilmentEvent({ campaignId, contributionId: contribution.id, actorUserId: userId, actorRole: "PARTICIPANT", eventType: "PARTICIPANT_PROBLEM_REPORTED", note: description });
    await markOwnDeliveryReferenceException(contribution.id);
    return supportCaseService.create(userId, campaignId, { caseType: "FULFILMENT_ISSUE", description, evidenceUrls });
  },

  // ─── M5 — supplier-facing exception reporting. Informational overlay
  // only (Appendix B's delivery_exception is an EVENT, not a distinct
  // CampaignFulfilment status) — never changes fulfilment.status itself.

  async reportExceptionForVendor(vendorId: string, campaignId: string, note: string) {
    const { campaign, actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "EXCEPTION", note });
    await notifyOrganiser(campaign.id, "fulfilment_exception", "Fulfilment exception reported", `Your supplier reported an issue with "${campaign.title}": ${note}`, `fulfilment_exception:${campaign.id}:${Date.now()}`);
    return { recorded: true };
  },

  async reportExceptionForAccount(userId: string, campaignId: string, note: string) {
    const { campaign, actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    await recordFulfilmentEvent({ campaignId, actorUserId, actorRole: "SUPPLIER", eventType: "EXCEPTION", note });
    await notifyOrganiser(campaign.id, "fulfilment_exception", "Fulfilment exception reported", `Your supplier reported an issue with "${campaign.title}": ${note}`, `fulfilment_exception:${campaign.id}:${Date.now()}`);
    return { recorded: true };
  },

  /** M5 — the append-only evidence timeline (spec §10.2 step 5). Organiser/supplier (their own campaign) and admin only — never raw participant contact data (M4 rules stay authoritative; events only ever carry actorUserId, never a participant's email/phone). */
  async getFulfilmentEventsForOrganiser(userId: string, campaignId: string) {
    await requireOrganiserOwned(userId, campaignId);
    return prisma.campaignFulfilmentEvent.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
  },

  async getFulfilmentEventsForVendor(vendorId: string, campaignId: string) {
    await requireSupplierOwned(vendorId, campaignId);
    return prisma.campaignFulfilmentEvent.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
  },

  async getFulfilmentEventsForAccount(userId: string, campaignId: string) {
    await requireSupplierAccountOwned(userId, campaignId);
    return prisma.campaignFulfilmentEvent.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
  },

  async getFulfilmentEventsForAdmin(campaignId: string) {
    return prisma.campaignFulfilmentEvent.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
  },

  // ─── Phase 6 (delivery + collection/tracking) — per-participant delivery
  // status/collection code. Distinct from the campaign-wide fulfilment
  // reads/actions above: these operate on DeliveryReference (one row per
  // captured contribution), never on CampaignFulfilment.

  /**
   * Participant's own delivery/collection status, including their
   * collection code while it's still unredeemed. Never another
   * participant's row — requireOwnPaidContribution() already proved
   * ownership of the exact contribution this reference belongs to.
   */
  async getMyDeliveryReference(userId: string, campaignId: string) {
    const contribution = await requireOwnPaidContribution(userId, campaignId);
    const reference = await prisma.deliveryReference.findUnique({ where: { contributionId: contribution.id } });
    if (!reference) return null;
    return {
      deliveryMethod: reference.deliveryMethod,
      status: reference.status,
      // Only ever shown to its owner, and only until it's actually used —
      // once redeemed there is nothing left for the buyer to act on.
      collectionCode: reference.collectionCodeRedeemedAt ? null : reference.collectionCode,
      collectionCodeRedeemedAt: reference.collectionCodeRedeemedAt,
    };
  },

  /** Supplier verifies a buyer's collection code at physical handover (Vendor path). Campaign + code alone — no contributionId needed at the counter. */
  async verifyCollectionCodeForVendor(vendorId: string, campaignId: string, code: string) {
    const { actorUserId } = await requireSupplierOwned(vendorId, campaignId);
    return claimCollectionCode(campaignId, code, actorUserId);
  },

  /** Workstream 3 twin of verifyCollectionCodeForVendor() above, for the no-Vendor SupplierAccount path. */
  async verifyCollectionCodeForAccount(userId: string, campaignId: string, code: string) {
    const { actorUserId } = await requireSupplierAccountOwned(userId, campaignId);
    return claimCollectionCode(campaignId, code, actorUserId);
  },

  /**
   * Self-fulfilled campaigns have no supplier and no CampaignFulfilment
   * row at all (createSupplierOrder() only creates one on the
   * SUPPLIER-fulfilment branch — the organiser handles fulfilment tracking
   * itself, outside that state machine) — but a COLLECTION-method
   * self-fulfilled campaign's participants still get a real DeliveryReference
   * and collection code, so the organiser (who is physically handing goods
   * over) needs a way to verify one too. Deliberately its own lightweight
   * ownership check (requireOrganiserOwnedCampaignOnly, not
   * requireOrganiserOwned) since it must not 404 for lack of a
   * CampaignFulfilment row that will never exist here.
   */
  async verifyCollectionCodeForOrganiser(userId: string, campaignId: string, code: string) {
    const campaign = await requireOrganiserOwnedCampaignOnly(userId, campaignId);
    if (campaign.fulfilmentOwner !== "SELF") {
      throw new AppError("This campaign has an assigned supplier — only they can verify collection for it", 409);
    }
    return claimCollectionCode(campaignId, code, userId, "ORGANISER");
  },
};

/** Shared by confirmReceiptForParticipant()/reportFulfilmentProblem() — participant-authorized, never trusts a client-supplied contribution id without checking ownership + capture status. */
async function requireOwnPaidContribution(userId: string, campaignId: string) {
  const participant = await prisma.campaignParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId } } });
  if (!participant) throw new AppError("You have not joined this campaign", 404);
  const contribution = await prisma.campaignContribution.findFirst({
    where: { campaignId, participantId: participant.id, status: "PAID" },
    orderBy: { createdAt: "desc" },
  });
  if (!contribution) throw new AppError("No captured order found for you on this campaign yet", 404);
  return contribution;
}

/**
 * Phase 6 — same organiser-ownership check as requireOrganiserOwned()
 * above, minus its CampaignFulfilment requirement. Needed because a
 * self-fulfilled campaign never has a CampaignFulfilment row, so
 * requireOrganiserOwned() would 404 it even though the organiser
 * genuinely owns it and needs to verify a collection code.
 */
async function requireOrganiserOwnedCampaignOnly(userId: string, campaignId: string) {
  const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !organiser || campaign.organiserId !== organiser.id) {
    throw new AppError("Campaign not found", 404);
  }
  return campaign;
}

// Generic message on every failure path (wrong code, already-redeemed code,
// lost the atomic-claim race) — deliberately never distinguishes which, so
// a supplier/organiser probing this endpoint learns nothing that would help
// them guess a real buyer's code.
const INVALID_COLLECTION_CODE_MESSAGE = "Invalid or already-used collection code";

/**
 * Shared by every verifyCollectionCodeFor*() actor above — campaign-scoped
 * lookup by code alone (collectionCode is unique per campaign, never
 * globally), then an atomic single-use claim so two staff members typing
 * the same code at the same moment can never both "succeed".
 */
async function claimCollectionCode(campaignId: string, code: string, actorUserId: string, actorRole: "SUPPLIER" | "ORGANISER" = "SUPPLIER") {
  const trimmed = code.trim();
  if (!trimmed) throw new AppError(INVALID_COLLECTION_CODE_MESSAGE, 409, undefined, "INVALID_COLLECTION_CODE");
  const reference = await prisma.deliveryReference.findUnique({
    where: { campaignId_collectionCode: { campaignId, collectionCode: trimmed } },
  });
  if (!reference || reference.collectionCodeRedeemedAt) {
    throw new AppError(INVALID_COLLECTION_CODE_MESSAGE, 409, undefined, "INVALID_COLLECTION_CODE");
  }
  const claim = await prisma.deliveryReference.updateMany({
    where: { id: reference.id, collectionCodeRedeemedAt: null },
    data: { collectionCodeRedeemedAt: new Date(), collectionCodeRedeemedByUserId: actorUserId, status: "COLLECTED" },
  });
  if (claim.count !== 1) {
    throw new AppError(INVALID_COLLECTION_CODE_MESSAGE, 409, undefined, "INVALID_COLLECTION_CODE");
  }
  await recordFulfilmentEvent({
    campaignId,
    contributionId: reference.contributionId,
    actorUserId,
    actorRole,
    eventType: "COLLECTED",
    note: "Collection code verified at handover",
  });
  return { verified: true as const, contributionId: reference.contributionId };
}

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
