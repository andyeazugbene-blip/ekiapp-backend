import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { automationService } from "../automation/automation.service";
import { marketConfigurationService } from "./market-configuration.service";
import { campaignContributionsService } from "./campaign-contributions.service";
import { recordAudit } from "../../shared/utils/audit";

// Community Buy Workstream 2: only `title` and `country` are hard
// requirements to start a draft (spec §7 — "any authenticated user can
// create and save a draft; gates apply only when an action creates
// supplier, payment or public obligations"). Everything else is optional
// at creation and filled in incrementally via update(); submit() is the
// authoritative gate that requires the rest before review.
export interface CreateCampaignInput {
  title: string;
  country: string;
  // Client-corrected flow: supplier is an optional fulfilment choice, never
  // a prerequisite for publication. SUPPLIER requires supplierId; SELF
  // requires it be absent.
  fulfilmentOwner?: "SELF" | "SUPPLIER";
  supplierId?: string;
  // Workstream 3 — the no-Vendor-required supplier choice. Preferred over
  // supplierId for new assignments; both remain accepted so nothing already
  // integrated against supplierId breaks. See resolveSupplierChoice().
  supplierAccountId?: string;
  description?: string;
  currency?: string;
  minimumShares?: number;
  goalShares?: number;
  maximumShares?: number;
  pricePerShareMinor?: number;
  deadline?: string;
  rescueDurationMinutes?: number;
  // Product step (spec §7 step 1).
  images?: string[];
  unit?: string;
  quantityPerOrder?: number;
  qualityNotes?: string;
  // Delivery step (spec §7 step 5) — organiser intent only, no address data.
  deliveryPreference?: "COLLECTION" | "DELIVERY";
}

type SupplyRoute = {
  fulfilmentOwner: "SELF" | "SUPPLIER";
  supplierId: string | null;
  supplierAccountId: string | null;
  notifyUserId: string | null;
};

/**
 * Workstream 3 — resolves an organiser's supplier choice against either
 * route: the new no-Vendor-required SupplierAccount (preferred — checked
 * first) or the legacy Vendor-backed SupplierProfile (untouched from before
 * this workstream — same lookup, same checks, same error messages/codes).
 * When the chosen SupplierAccount is itself linked to a legacy
 * SupplierProfile (legacySupplierProfileId), supplierId is dual-written too
 * so every existing campaign.supplier.vendor... read keeps working.
 */
async function resolveSupplierChoice(
  supplierId: string | null | undefined,
  supplierAccountId: string | null | undefined,
  country: string | null | undefined,
): Promise<{ fulfilmentOwner: "SUPPLIER"; supplierId: string | null; supplierAccountId: string | null; notifyUserId: string }> {
  if (supplierAccountId) {
    const account = await prisma.supplierAccount.findUnique({ where: { id: supplierAccountId } });
    if (!account || account.supplierState !== "APPROVED") throw new AppError("Supplier not found or not approved", 404);
    if (country && !account.coverageRegions.includes(country)) {
      // spec §8.2: campaigns operate as a local-market feature only — no
      // cross-border organiser/supplier pairing in this version.
      throw new AppError("Supplier must cover the campaign's market", 400);
    }
    return { fulfilmentOwner: "SUPPLIER", supplierId: account.legacySupplierProfileId ?? null, supplierAccountId: account.id, notifyUserId: account.userId };
  }
  if (!supplierId) throw new AppError("supplierId is required when choosing a supplier", 400);
  const supplier = await prisma.supplierProfile.findUnique({ where: { id: supplierId }, include: { vendor: { select: { userId: true } } } });
  if (!supplier || !supplier.isVerified) throw new AppError("Supplier not found or not verified", 404);
  if (supplier.isRestricted) throw new AppError("This supplier is currently restricted and cannot take on new campaigns", 403);
  if (country && supplier.country !== country) {
    // spec §8.2: campaigns operate as a local-market feature only — no
    // cross-border organiser/supplier pairing in this version.
    throw new AppError("Supplier must be based in the same market as the campaign", 400);
  }
  return { fulfilmentOwner: "SUPPLIER", supplierId, supplierAccountId: null, notifyUserId: supplier.vendor.userId };
}

/** Shared by create()/update() — every rule here already existed in create() verbatim; only the "must be provided" requirement moved to submit(). */
async function resolveSupplyRoute(
  fulfilmentOwner: "SELF" | "SUPPLIER" | undefined,
  supplierId: string | null | undefined,
  supplierAccountId: string | null | undefined,
  country: string | null | undefined,
): Promise<SupplyRoute | null> {
  if (fulfilmentOwner === undefined) {
    if (supplierId || supplierAccountId) throw new AppError("supplierId requires fulfilmentOwner to be set to SUPPLIER", 400);
    return null;
  }
  if (fulfilmentOwner !== "SELF" && fulfilmentOwner !== "SUPPLIER") {
    throw new AppError("fulfilmentOwner must be SELF or SUPPLIER", 400);
  }
  if (fulfilmentOwner === "SELF") {
    if (supplierId || supplierAccountId) throw new AppError("supplierId must not be set when self-fulfilling", 400);
    return { fulfilmentOwner: "SELF", supplierId: null, supplierAccountId: null, notifyUserId: null };
  }
  return resolveSupplierChoice(supplierId, supplierAccountId, country);
}

/** Every numeric rule create() already enforced, made conditional on the field actually being provided so a partial draft save only validates what it touches. */
function validateSharesAndPricing(fields: { minimumShares?: number; goalShares?: number; maximumShares?: number; pricePerShareMinor?: number }): void {
  const { minimumShares, goalShares, maximumShares, pricePerShareMinor } = fields;
  if (minimumShares !== undefined && (!Number.isInteger(minimumShares) || minimumShares < 1)) {
    throw new AppError("Minimum shares must be at least 1", 400);
  }
  if (goalShares !== undefined) {
    if (!Number.isInteger(goalShares) || goalShares < 1) throw new AppError("Campaign goal must be at least 1", 400);
    if (minimumShares !== undefined && goalShares < minimumShares) throw new AppError("Campaign goal must be at least the minimum shares", 400);
  }
  if (maximumShares !== undefined) {
    if (!Number.isInteger(maximumShares) || maximumShares < 1) throw new AppError("Maximum capacity must be at least 1", 400);
    if (goalShares !== undefined && maximumShares < goalShares) throw new AppError("Maximum capacity must be at least the campaign goal", 400);
  }
  if (pricePerShareMinor !== undefined && (!Number.isInteger(pricePerShareMinor) || pricePerShareMinor <= 0)) {
    throw new AppError("Price per share must be positive", 400);
  }
}

function validateDeadline(deadline: string | undefined): Date | undefined {
  if (deadline === undefined) return undefined;
  const parsed = new Date(deadline);
  if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
    throw new AppError("Deadline must be a valid future date", 400);
  }
  return parsed;
}

function validateQuantityPerOrder(quantityPerOrder: number | undefined): void {
  if (quantityPerOrder !== undefined && (!Number.isInteger(quantityPerOrder) || quantityPerOrder < 1)) {
    throw new AppError("Quantity per order must be at least 1", 400);
  }
}

/** A raw JSON body isn't TS-checked at runtime — reject anything outside the real enum with a clean 400 instead of letting an invalid value reach Prisma as a DB-level enum error. */
function validateDeliveryPreference(deliveryPreference: string | undefined): void {
  if (deliveryPreference !== undefined && deliveryPreference !== "COLLECTION" && deliveryPreference !== "DELIVERY") {
    throw new AppError("deliveryPreference must be COLLECTION or DELIVERY", 400);
  }
}

const MAX_EXTENSIONS = 1;

// Client-corrected flow: supplier acceptance/decline/reassignment is
// fulfilment workflow state, not a publication gate — so unlike before
// (DRAFT/CHANGES_REQUIRED only), a supplier can respond at any point up to
// the campaign actually closing out. Excludes only the terminal/closing
// statuses where a supplier decision no longer means anything.
const SUPPLIER_RESPONSE_STATUSES = [
  "DRAFT",
  "CHANGES_REQUIRED",
  "UNDER_REVIEW",
  "APPROVED",
  "LIVE",
  "PAUSED",
  "RESCUE_WINDOW",
] as const;

async function notifyCampaign(
  userId: string,
  event: string,
  title: string,
  body: string,
  campaignId: string,
  dedupeKey?: string,
  // NAV-08 fix: several events (admin_cancelled, cancelled, rescue_opened,
  // extension_approved, succeeded, failed) fire under the IDENTICAL event
  // name to both the organiser and every participant — the frontend's
  // tap-router can't tell them apart by event name alone, since an
  // organiser is just a buyer-role account like any participant. Passing
  // "organiser" only on the organiser-directed call (participant calls
  // pass nothing, unchanged) lets the router send the organiser to their
  // management screen without misrouting participants who share the exact
  // same event name.
  audience?: "organiser",
) {
  // notificationsService.enqueue() is documented as never throwing (its own
  // internal try/catches cover the DB insert and the push send) — this is
  // still wrapped defensively because a notification must never be able to
  // fail a business transaction that already succeeded, regardless of what
  // the dependency currently promises.
  try {
    await notificationsService.enqueue({
      userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title,
      body,
      data: { type: "community_campaign_update", event, campaignId, ...(audience ? { audience } : {}) },
      dedupeKey,
    });
  } catch (error) {
    logger.error("Community Buy notification failed (non-blocking)", {
      event,
      campaignId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export const communityCampaignsService = {
  async create(userId: string, input: CreateCampaignInput) {
    if (!input.title?.trim()) throw new AppError("Title is required", 400);
    if (!input.country) throw new AppError("Country is required", 400);

    // Community Buy Workstream 2: organising is available to every
    // authenticated user (WS1 canOrganise:true) — an OrganiserProfile is
    // created on first draft, the same lightweight/instant/non-admin-gated
    // record applyAsOrganiser() already produces, isVerified:false until
    // admin review. Verification is enforced at submit(), not here.
    let organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    if (!organiser) {
      const applicationConfig = await marketConfigurationService.get(input.country);
      if (!applicationConfig?.organiserApplicationsEnabled) {
        throw new AppError("Organiser applications are not open in this market yet", 403);
      }
      organiser = await prisma.organiserProfile.create({ data: { userId, country: input.country } });
    }
    if (organiser.isRestricted) throw new AppError("Your organiser account is currently restricted from creating new campaigns", 403);

    const config = await marketConfigurationService.get(input.country);
    if (!config?.communityBuyEnabled) throw new AppError("Community Buy is not available in this market yet", 403);

    // Client-corrected flow: choosing a supplier is optional, and — new
    // this workstream — so is choosing a supply route at all while still
    // drafting. Every eligibility rule below is unchanged from before;
    // only "must be provided" moved to submit().
    const route = await resolveSupplyRoute(input.fulfilmentOwner, input.supplierId, input.supplierAccountId, input.country);
    validateSharesAndPricing(input);
    validateQuantityPerOrder(input.quantityPerOrder);
    validateDeliveryPreference(input.deliveryPreference);
    const deadline = validateDeadline(input.deadline);

    const campaign = await prisma.communityCampaign.create({
      data: {
        organiserId: organiser.id,
        fulfilmentOwner: route?.fulfilmentOwner ?? "SELF",
        supplierId: route?.supplierId ?? null,
        supplierAccountId: route?.supplierAccountId ?? null,
        title: input.title.trim(),
        description: input.description,
        country: input.country,
        currency: input.currency,
        // targetAmount kept in sync with goalShares × price for anything
        // still reading the amount-based field during the UI migration —
        // 0 (not a fabricated guess) until both are known.
        targetAmount: input.goalShares && input.pricePerShareMinor ? input.goalShares * input.pricePerShareMinor : 0,
        minimumShares: input.minimumShares,
        goalShares: input.goalShares,
        maximumShares: input.maximumShares,
        pricePerShareMinor: input.pricePerShareMinor,
        images: input.images ?? [],
        unit: input.unit,
        quantityPerOrder: input.quantityPerOrder,
        qualityNotes: input.qualityNotes,
        deliveryPreference: input.deliveryPreference ?? "COLLECTION",
        rescueDurationMinutes: input.rescueDurationMinutes ?? 2880,
        deadline,
        status: "DRAFT",
      },
    });
    // Real supplier invitation — fires exactly when the commitment state
    // actually comes into existence (supplierId assigned, supplierCommitted:
    // false), not merely because a campaign object exists. Self-fulfilled
    // campaigns have no supplier, so there is nothing to invite.
    if (route?.fulfilmentOwner === "SUPPLIER" && route.notifyUserId) {
      await notifyCampaign(
        route.notifyUserId,
        "supplier_invited",
        "New Community Buy invitation",
        `An organiser wants you to supply "${campaign.title}"${input.minimumShares && input.maximumShares ? ` — ${input.minimumShares} to ${input.maximumShares} shares` : ""}. Review and accept or decline.`,
        campaign.id,
        `supplier_invited:${campaign.id}:${route.supplierId ?? route.supplierAccountId}`,
      );
    }
    return campaign;
  },

  async update(userId: string, campaignId: string, input: Partial<CreateCampaignInput>) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);

    const financialFieldsTouched = input.minimumShares !== undefined || input.goalShares !== undefined
      || input.maximumShares !== undefined || input.pricePerShareMinor !== undefined || input.deadline !== undefined;
    // Community Buy Workstream 2: the wizard's Supply step must stay
    // editable on a draft, same as every other step — but only while
    // still DRAFT/CHANGES_REQUIRED; a LIVE campaign's supplier can only
    // change via reassignSupplier(), which also resets commitment state.
    const supplyRouteTouched = input.fulfilmentOwner !== undefined || input.supplierId !== undefined || input.supplierAccountId !== undefined;

    // spec §8.10 / doc §Screen 102: an organiser cannot edit financial
    // terms after contributions begin — termsLockedAt is set on the first
    // confirmed contribution (see campaign-contributions.service.ts). Once
    // a campaign is live, only non-financial content (title/description)
    // stays editable — doc's "Edit Live Campaign" is about correcting
    // copy, never about changing the terms participants already paid under.
    const isDraftLike = campaign.status === "DRAFT" || campaign.status === "CHANGES_REQUIRED";
    const isLiveLike = campaign.status === "LIVE" || campaign.status === "PAUSED" || campaign.status === "RESCUE_WINDOW";

    if (!isDraftLike && !isLiveLike) {
      throw new AppError("This campaign can no longer be edited", 409);
    }
    if (financialFieldsTouched && (!isDraftLike || campaign.termsLockedAt)) {
      throw new AppError(
        campaign.termsLockedAt
          ? "This campaign's terms are locked after the first confirmed contribution"
          : "Financial terms can only be edited while a campaign is in draft",
        409,
      );
    }
    if (supplyRouteTouched && !isDraftLike) {
      throw new AppError("The supply route can only be changed while a campaign is in draft — reassign the supplier once live", 409);
    }

    const route = supplyRouteTouched
      ? await resolveSupplyRoute(
          input.fulfilmentOwner ?? (campaign.supplierId || campaign.supplierAccountId ? "SUPPLIER" : "SELF"),
          input.supplierId !== undefined ? input.supplierId : campaign.supplierId,
          input.supplierAccountId !== undefined ? input.supplierAccountId : campaign.supplierAccountId,
          input.country !== undefined ? input.country : campaign.country,
        )
      : null;
    validateSharesAndPricing(input);
    validateQuantityPerOrder(input.quantityPerOrder);
    validateDeliveryPreference(input.deliveryPreference);
    const deadline = validateDeadline(input.deadline);

    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.country !== undefined && { country: input.country }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.minimumShares !== undefined && { minimumShares: input.minimumShares }),
        ...(input.goalShares !== undefined && { goalShares: input.goalShares }),
        ...(input.maximumShares !== undefined && { maximumShares: input.maximumShares }),
        ...(input.pricePerShareMinor !== undefined && {
          pricePerShareMinor: input.pricePerShareMinor,
          targetAmount: (input.goalShares ?? campaign.goalShares ?? 0) * input.pricePerShareMinor,
        }),
        ...(deadline !== undefined && { deadline }),
        ...(input.images !== undefined && { images: input.images }),
        ...(input.unit !== undefined && { unit: input.unit }),
        ...(input.quantityPerOrder !== undefined && { quantityPerOrder: input.quantityPerOrder }),
        ...(input.qualityNotes !== undefined && { qualityNotes: input.qualityNotes }),
        ...(input.deliveryPreference !== undefined && { deliveryPreference: input.deliveryPreference }),
        ...(route && { fulfilmentOwner: route.fulfilmentOwner, supplierId: route.supplierId, supplierAccountId: route.supplierAccountId }),
      },
    });

    if (route?.fulfilmentOwner === "SUPPLIER" && route.notifyUserId) {
      // Same real invitation as create()/reassignSupplier() — deduped by
      // notificationsService's dedupeKey, so re-saving the same supplier
      // choice on a later draft edit is a safe no-op, not a repeat spam.
      await notifyCampaign(
        route.notifyUserId,
        "supplier_invited",
        "New Community Buy invitation",
        `An organiser wants you to supply "${updated.title}"${updated.minimumShares && updated.maximumShares ? ` — ${updated.minimumShares} to ${updated.maximumShares} shares` : ""}. Review and accept or decline.`,
        campaignId,
        `supplier_invited:${campaignId}:${route.supplierId ?? route.supplierAccountId}`,
      );
    }

    return updated;
  },

  /**
   * Necessary companion to declineSupplierCommitment() above — without
   * this, a decline would be a dead end, since the organiser would have no
   * way to move the campaign forward with a different supplier. Only
   * valid pre-commitment (mirrors update()'s financial-terms-locked gate);
   * resets the commitment/decline state so the new supplier starts clean.
   */
  async reassignSupplier(userId: string, campaignId: string, newSupplierId?: string | null, newSupplierAccountId?: string | null) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.fulfilmentOwner !== "SUPPLIER") {
      throw new AppError("This campaign is self-fulfilled and has no supplier to reassign", 409);
    }
    if (!(SUPPLIER_RESPONSE_STATUSES as readonly string[]).includes(campaign.status)) {
      throw new AppError("The supplier can no longer be changed once the campaign has closed out", 409);
    }
    if (campaign.termsLockedAt) {
      throw new AppError("This campaign's terms are locked after the first confirmed contribution", 409);
    }
    // Workstream 3: same short-circuit as before for the legacy (supplierId)
    // path — checked against the raw input, before any lookup, so this
    // still throws 409 without ever touching supplierProfile/supplierAccount.
    const alreadyAssigned = newSupplierAccountId
      ? newSupplierAccountId === campaign.supplierAccountId
      : newSupplierId === campaign.supplierId;
    if (alreadyAssigned) {
      throw new AppError("This is already the assigned supplier", 409);
    }
    const choice = await resolveSupplierChoice(newSupplierId, newSupplierAccountId, campaign.country);
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: {
        supplierId: choice.supplierId,
        supplierAccountId: choice.supplierAccountId,
        supplierCommitted: false,
        supplierCommittedAt: null,
        supplierDeclinedAt: null,
        supplierDeclineReason: null,
      },
    });
    // Same real invitation event as create() — a fresh commitment state now
    // exists for this (new) supplier.
    await notifyCampaign(
      choice.notifyUserId,
      "supplier_invited",
      "New Community Buy invitation",
      `An organiser wants you to supply "${campaign.title}" — ${campaign.minimumShares} to ${campaign.maximumShares} shares. Review and accept or decline.`,
      campaignId,
      `supplier_invited:${campaignId}:${choice.supplierId ?? choice.supplierAccountId}`,
    );
    return updated;
  },

  /** Supplier-side commitment — doc screens 115-117. Required before the organiser can submit for admin review. */
  async confirmSupplierCommitment(vendorId: string, campaignId: string) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign || !supplier || campaign.supplierId !== supplier.id) {
      throw new AppError("Campaign not found", 404);
    }
    if (supplier.isRestricted) throw new AppError("Your supplier account is currently restricted from committing to campaigns", 403);
    if (!(SUPPLIER_RESPONSE_STATUSES as readonly string[]).includes(campaign.status)) {
      throw new AppError("This campaign is not awaiting supplier commitment", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { supplierCommitted: true, supplierCommittedAt: new Date() },
    });
    // Fires only after the state transition above actually succeeds —
    // deduped per (campaign, supplier) so a retried/duplicate accept call
    // (nothing here currently blocks calling this twice while still DRAFT)
    // notifies the organiser once, not once per call.
    await notifyCampaign(
      campaign.organiser.userId,
      "supplier_accepted",
      "Supplier accepted your campaign",
      // Client-corrected flow: submission/publication never waited on this,
      // so the copy no longer implies it did.
      `Your supplier accepted "${campaign.title}".`,
      campaignId,
      `supplier_accepted:${campaignId}:${supplier.id}`,
    );
    return updated;
  },

  /**
   * Workstream 3 — same commitment action as confirmSupplierCommitment()
   * above, for the no-Vendor SupplierAccount path. Kept fully separate
   * (not merged into the function above) so the legacy vendorId-keyed path
   * stays byte-for-byte untouched — see the plan's "dual-path resolver, not
   * a rewrite" principle.
   */
  async confirmSupplierCommitmentForAccount(userId: string, campaignId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign || !account || campaign.supplierAccountId !== account.id) {
      throw new AppError("Campaign not found", 404);
    }
    if (account.supplierState === "RESTRICTED" || account.supplierState === "SUSPENDED" || account.supplierState === "PAUSED") {
      throw new AppError("Your supplier account is currently restricted from committing to campaigns", 403);
    }
    if (!(SUPPLIER_RESPONSE_STATUSES as readonly string[]).includes(campaign.status)) {
      throw new AppError("This campaign is not awaiting supplier commitment", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { supplierCommitted: true, supplierCommittedAt: new Date() },
    });
    await notifyCampaign(
      campaign.organiser.userId,
      "supplier_accepted",
      "Supplier accepted your campaign",
      `Your supplier accepted "${campaign.title}".`,
      campaignId,
      `supplier_accepted:${campaignId}:${account.id}`,
    );
    return updated;
  },

  /**
   * Client spec (Community Buy doc, Screen CB67) requires a real Decline
   * alongside Accept. Deliberately does NOT touch campaign.status or
   * supplierId — a restricted supplier may still decline (restriction only
   * blocks taking on NEW work, not backing out of an unwanted invite).
   * The organiser must call reassignSupplier() below to move forward;
   * this only records the decline and notifies them.
   */
  async declineSupplierCommitment(userId: string, vendorId: string, campaignId: string, reason?: string) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign || !supplier || campaign.supplierId !== supplier.id) {
      throw new AppError("Campaign not found", 404);
    }
    if (!(SUPPLIER_RESPONSE_STATUSES as readonly string[]).includes(campaign.status)) {
      throw new AppError("This campaign is not awaiting your decision", 409);
    }
    if (campaign.supplierCommitted) {
      throw new AppError("You have already accepted this campaign", 409);
    }
    if (campaign.supplierDeclinedAt) {
      throw new AppError("You have already declined this campaign", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { supplierDeclinedAt: new Date(), supplierDeclineReason: reason?.trim() || null },
    });
    await recordAudit({
      actorId: userId,
      action: "community_campaign.supplier_declined",
      entityType: "CommunityCampaign",
      entityId: campaignId,
      reason,
      afterState: { supplierDeclinedAt: updated.supplierDeclinedAt, supplierDeclineReason: updated.supplierDeclineReason },
    });
    await notifyCampaign(
      campaign.organiser.userId,
      "supplier_declined",
      "Supplier declined your campaign",
      reason ? `The supplier declined: ${reason}` : "The supplier declined this campaign. Choose a different supplier to continue.",
      campaignId,
    );
    return updated;
  },

  /** Workstream 3 — declineSupplierCommitment() above, for the no-Vendor SupplierAccount path. Kept separate for the same reason as confirmSupplierCommitmentForAccount(). */
  async declineSupplierCommitmentForAccount(userId: string, campaignId: string, reason?: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign || !account || campaign.supplierAccountId !== account.id) {
      throw new AppError("Campaign not found", 404);
    }
    if (!(SUPPLIER_RESPONSE_STATUSES as readonly string[]).includes(campaign.status)) {
      throw new AppError("This campaign is not awaiting your decision", 409);
    }
    if (campaign.supplierCommitted) {
      throw new AppError("You have already accepted this campaign", 409);
    }
    if (campaign.supplierDeclinedAt) {
      throw new AppError("You have already declined this campaign", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { supplierDeclinedAt: new Date(), supplierDeclineReason: reason?.trim() || null },
    });
    await recordAudit({
      actorId: userId,
      action: "community_campaign.supplier_declined",
      entityType: "CommunityCampaign",
      entityId: campaignId,
      reason,
      afterState: { supplierDeclinedAt: updated.supplierDeclinedAt, supplierDeclineReason: updated.supplierDeclineReason },
    });
    await notifyCampaign(
      campaign.organiser.userId,
      "supplier_declined",
      "Supplier declined your campaign",
      reason ? `The supplier declined: ${reason}` : "The supplier declined this campaign. Choose a different supplier to continue.",
      campaignId,
    );
    return updated;
  },

  // Client-corrected flow: supplier acceptance is fulfilment workflow state,
  // never a publication gate. A campaign can be submitted for review — and
  // go on to be approved, published, and LIVE — regardless of whether a
  // selected supplier has responded yet, or whether one was selected at all.
  // Community Buy Workstream 2: this is now the authoritative gate that
  // create()/update() no longer are — organiser verification and every
  // required campaign field are checked here, once, right before the
  // action that actually creates a public/admin obligation. A draft that
  // fails this never gets deleted or invalidated — it stays exactly as
  // saved, editable, with the caller told precisely what's missing.
  async submit(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "DRAFT" && campaign.status !== "CHANGES_REQUIRED") {
      throw new AppError("Only a draft campaign can be submitted for review", 409);
    }

    const organiser = await prisma.organiserProfile.findUnique({ where: { id: campaign.organiserId } });
    const missing: string[] = [];

    if (!organiser) missing.push("organiser_profile");
    else {
      if (organiser.isRestricted) missing.push("organiser_restricted");
      if (!organiser.isVerified) missing.push("organiser_verification");
    }
    if (!campaign.country) missing.push("country");
    if (!campaign.currency) missing.push("currency");
    if (!campaign.deadline || campaign.deadline <= new Date()) missing.push("deadline");
    if (!campaign.minimumShares || campaign.minimumShares < 1) missing.push("minimumShares");
    if (!campaign.goalShares || (campaign.minimumShares != null && campaign.goalShares < campaign.minimumShares)) missing.push("goalShares");
    if (!campaign.maximumShares || (campaign.goalShares != null && campaign.maximumShares < campaign.goalShares)) missing.push("maximumShares");
    if (!campaign.pricePerShareMinor || campaign.pricePerShareMinor <= 0) missing.push("pricePerShareMinor");
    if (!campaign.unit) missing.push("unit");
    if (!campaign.quantityPerOrder || campaign.quantityPerOrder < 1) missing.push("quantityPerOrder");

    if (campaign.fulfilmentOwner === "SUPPLIER") {
      if (!campaign.supplierId) {
        missing.push("supplierId");
      } else {
        const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId } });
        if (!supplier || !supplier.isVerified || supplier.isRestricted) missing.push("supplier_eligibility");
      }
    }

    if (campaign.country) {
      const config = await marketConfigurationService.get(campaign.country);
      if (!config?.communityBuyEnabled) missing.push("market_not_enabled");
    }

    if (missing.length > 0) {
      throw new AppError("This campaign is not ready to submit for review.", 400, { missing }, "SUBMIT_REQUIREMENTS_NOT_MET");
    }

    return prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "UNDER_REVIEW" } });
  },

  /** "Participants" — every contributor to the organiser's own campaign, with their real total. */
  async listParticipantsForOrganiser(userId: string, campaignId: string) {
    await this.requireOwnedByOrganiser(userId, campaignId);
    const participants = await prisma.campaignParticipant.findMany({
      where: { campaignId, contributions: { some: { status: "PAID" } } },
      include: {
        user: { select: { name: true, email: true } },
        contributions: { where: { status: "PAID" }, select: { quantity: true, amount: true, isOrganiserTopUp: true, createdAt: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
    return participants.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      email: p.user.email,
      joinedAt: p.joinedAt,
      totalQuantity: p.contributions.reduce((sum, c) => sum + c.quantity, 0),
      totalPaid: p.contributions.reduce((sum, c) => sum + c.amount, 0),
      isOrganiser: p.contributions.some((c) => c.isOrganiserTopUp),
    }));
  },

  /** "Refund Progress" — real counts, not a fabricated progress bar, for a campaign the organiser owns. */
  async getRefundProgressForOrganiser(userId: string, campaignId: string) {
    await this.requireOwnedByOrganiser(userId, campaignId);
    const refunds = await prisma.campaignRefund.findMany({
      where: { contribution: { campaignId } },
      select: { status: true },
    });
    const total = refunds.length;
    const completed = refunds.filter((r) => r.status === "REFUNDED").length;
    const pending = refunds.filter((r) => r.status === "REFUND_PENDING" || r.status === "REFUND_PROCESSING").length;
    const failed = refunds.filter((r) => r.status === "REFUND_FAILED").length;
    return { total, completed, pending, failed };
  },

  async requireOwnedByOrganiser(userId: string, campaignId: string) {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || !organiser || campaign.organiserId !== organiser.id) {
      throw new AppError("Campaign not found", 404);
    }
    return campaign;
  },

  // ─── Admin review ─────────────────────────────────────────────────────

  async listForReview() {
    return prisma.communityCampaign.findMany({
      where: { status: "UNDER_REVIEW" },
      include: { organiser: { include: { user: { select: { name: true, email: true } } } }, supplier: { include: { vendor: { select: { storeName: true } } } } },
      orderBy: { createdAt: "asc" },
    });
  },

  /** Admin visibility into how campaigns actually closed — the review queue only ever shows UNDER_REVIEW, so this is the only place an admin can see a FAILED campaign awaiting an organiser decision, or the outcome once one's been made. */
  async listRecentlyClosed(limit = 50) {
    return prisma.communityCampaign.findMany({
      // Includes LIVE/PAUSED so admin risk controls (spec §132 "Pause new
      // contributions") have a real campaign to act on, not just closed
      // ones. RESCUE_WINDOW is included too (Phase 9) — without it, a
      // campaign in its completion period was invisible to admin entirely,
      // making rescue/deadline monitoring impossible.
      where: { status: { in: ["SUCCEEDED", "FAILED", "FULFILLING", "CANCELLED", "LIVE", "PAUSED", "RESCUE_WINDOW"] } },
      include: { organiser: { include: { user: { select: { name: true, email: true } } } }, supplier: { include: { vendor: { select: { storeName: true } } } } },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
  },

  async approve(adminId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "UNDER_REVIEW") throw new AppError("Campaign is not under review", 409);
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "APPROVED", reviewedById: adminId, reviewedAt: new Date() },
    });
    await notifyCampaign(campaign.organiser.userId, "approved", "Campaign approved", `${campaign.title} has been approved.`, campaignId);
    return updated;
  },

  async requestChanges(adminId: string, campaignId: string, notes: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);

    // Final Client Decision 1: admin can request changes on UNDER_REVIEW, APPROVED, and LIVE.
    // LIVE campaigns are paused (pledging frozen) while the organiser corrects the issue.
    // Financial terms (termsLockedAt) are NOT reset — contributions already confirmed are immutable.
    const allowedStatuses = ["UNDER_REVIEW", "APPROVED", "LIVE"] as const;
    type AllowedStatus = typeof allowedStatuses[number];
    const isAllowed = (allowedStatuses as ReadonlyArray<string>).includes(campaign.status);
    if (!isAllowed) {
      throw new AppError("Changes can only be requested on a campaign that is under review, approved, or live", 409);
    }

    // Determine the next status: LIVE → CHANGES_REQUIRED (pledging paused implicitly
    // by status; organiser notified their live campaign has been frozen).
    // APPROVED / UNDER_REVIEW → CHANGES_REQUIRED directly (no pledging to freeze).
    const wasLive = campaign.status === "LIVE";

    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: {
        status: "CHANGES_REQUIRED",
        reviewNotes: notes,
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });

    const notificationBody = wasLive
      ? `Your campaign "${campaign.title}" has been temporarily paused by Eki admin. Please review and action the following feedback before it can resume accepting pledges: ${notes}`
      : notes;

    await notifyCampaign(campaign.organiser.userId, "changes_requested", "Campaign changes requested", notificationBody, campaignId);
    return updated;
  },

  async reject(adminId: string, campaignId: string, notes?: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "UNDER_REVIEW") throw new AppError("Campaign is not under review", 409);
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "REJECTED", reviewNotes: notes, reviewedById: adminId, reviewedAt: new Date() },
    });
    await notifyCampaign(campaign.organiser.userId, "rejected", "Campaign rejected", notes ?? "Your campaign was not approved.", campaignId);
    return updated;
  },

  async pause(adminId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "LIVE") throw new AppError("Only a live campaign can be paused", 409);
    const updated = await prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
    // CBA-09 fix: unlike every other admin state transition on a campaign
    // (approve/reject/changes-requested/cancel), pause()/resume() never
    // notified the organiser at all — they'd have no explanation for why
    // their live campaign suddenly stopped accepting pledges.
    await notifyCampaign(campaign.organiser.userId, "admin_paused", "Campaign paused by admin", `${campaign.title} has been paused by an administrator. Pledging is temporarily unavailable.`, campaignId, undefined, "organiser");
    return updated;
  },

  async resume(adminId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    if (campaign.status !== "PAUSED") throw new AppError("Only a paused campaign can be resumed", 409);
    const updated = await prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "LIVE" } });
    await notifyCampaign(campaign.organiser.userId, "admin_resumed", "Campaign resumed by admin", `${campaign.title} has been resumed by an administrator. Pledging is available again.`, campaignId, undefined, "organiser");
    return updated;
  },

  /**
   * Admin-initiated cancel/end — Phase 9. Deliberately restricted to
   * pre-charge statuses only: under PLEDGE_THEN_CHARGE, money is captured
   * exclusively in chargePledgesAfterSuccess() (see that method's own
   * comment), which only ever runs once a campaign has already left this
   * status set (SUCCEEDED/FULFILLING onward). So every contribution here
   * is guaranteed still PLEDGED, never PAID — cancelling never needs to
   * create a real refund, only void the pledges, matching exactly what
   * endRescueAndRefund() already does for an organiser-initiated end. A
   * campaign that already succeeded (money moved or about to move) is a
   * different, harder problem — deliberately out of scope here; use the
   * existing refund tooling once real charges exist.
   */
  async cancel(adminId: string, campaignId: string, reason: string) {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: { organiser: true, participants: true },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);
    const cancellable = ["DRAFT", "UNDER_REVIEW", "CHANGES_REQUIRED", "APPROVED", "LIVE", "PAUSED", "RESCUE_WINDOW"];
    if (!cancellable.includes(campaign.status)) {
      throw new AppError("This campaign can no longer be cancelled — it has already succeeded, failed, or ended", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "CANCELLED", closedAt: new Date(), reviewNotes: reason },
    });
    // Defensive, matching endRescueAndRefund() exactly — see method comment
    // above for why this is always a no-op today, kept as a safety net.
    await this.createRefundRecordsForFailedCampaign(campaignId);
    await this.cancelPledgesForFailedCampaign(campaignId);
    await notifyCampaign(campaign.organiser.userId, "admin_cancelled", "Campaign ended by admin", `${campaign.title} has been ended by an administrator. No participant was charged — pledges have been cancelled. Reason: ${reason}`, campaignId, `admin_cancelled:${campaignId}:${campaign.organiser.userId}`, "organiser");
    for (const p of campaign.participants) {
      await notifyCampaign(p.userId, "admin_cancelled", "Campaign ended", `${campaign.title} has been ended by an administrator. Your saved payment method was never charged — your pledge is cancelled.`, campaignId, `admin_cancelled:${campaignId}:${p.userId}`);
    }
    return updated;
  },

  // ─── Publishing & discovery ────────────────────────────────────────────

  async publish(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "APPROVED") throw new AppError("Campaign must be approved before it can be published", 409);
    // Non-null: reaching APPROVED requires having passed submit()'s full
    // requirement check, which never lets country stay unset.
    if (!campaign.country) throw new AppError("Campaign is missing its market configuration", 409);
    const config = await marketConfigurationService.get(campaign.country);
    if (!config?.communityBuyEnabled) throw new AppError("Community Buy is not available in this market yet", 403);
    return prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "LIVE", publishedAt: new Date() } });
  },

  // Community Buy Workstream 2 — participant discovery search (spec Phase
  // 4). Real DB query against title/description; no invented category
  // field (none exists on the model, and Figma access is still blocked so
  // the exact taxonomy the client wants isn't confirmed).
  async listLive(country?: string, q?: string) {
    const search = q?.trim();
    return prisma.communityCampaign.findMany({
      where: {
        status: "LIVE",
        ...(country && { country }),
        ...(search && {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
          ],
        }),
      },
      include: {
        supplier: { include: { vendor: { select: { storeName: true } } } },
        // Workstream 3: display name for a no-Vendor supplier — legacy
        // campaigns have no supplierAccountId, so this is always null there.
        supplierAccount: { include: { user: { select: { name: true } } } },
      },
      orderBy: { deadline: "asc" },
    });
  },

  async listForOrganiser(userId: string) {
    const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
    if (!organiser) return [];
    const campaigns = await prisma.communityCampaign.findMany({
      where: { organiserId: organiser.id },
      include: {
        supplier: { include: { vendor: { select: { storeName: true } } } },
        supplierAccount: { include: { user: { select: { name: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true } },
        _count: { select: { participants: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return campaigns.map((c) => ({ ...c, participantCount: c._count.participants }));
  },

  async listForSupplier(vendorId: string) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    if (!supplier) return [];
    return prisma.communityCampaign.findMany({
      where: { supplierId: supplier.id },
      include: {
        organiser: { include: { user: { select: { name: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  /** Workstream 3 — listForSupplier() above, for the no-Vendor SupplierAccount path. */
  async listForSupplierAccount(userId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId } });
    if (!account) return [];
    return prisma.communityCampaign.findMany({
      where: { supplierAccountId: account.id },
      include: {
        organiser: { include: { user: { select: { name: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  async get(campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: {
        supplier: { include: { vendor: { select: { storeName: true } } } },
        supplierAccount: { include: { user: { select: { name: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true, quantity: true } },
        _count: { select: { participants: true } },
      },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);
    const paidTotal = campaign.contributions.reduce((sum, c) => sum + c.amount, 0);
    // confirmedShares is the authoritative, atomically-maintained count
    // (see campaign-contributions.service.ts) — this is only a display
    // cross-check, never used to decide success/failure.
    const goal = campaign.goalShares ?? 0;
    const progressPct = goal > 0 ? Math.min(100, Math.round((campaign.confirmedShares / goal) * 100)) : 0;
    return { ...campaign, paidTotal, progressPct, participantCount: campaign._count.participants };
  },

  // ─── Closing workflow — doc §7 Deadline Evaluation ─────────────────────
  // Financial success/failure is always decided here, server-side, from
  // the authoritative confirmedShares counter — never from the progress
  // bar or a client-reported state.
  //
  //   confirmed >= goal      -> GOAL_REACHED, proceed (FULFILLING)
  //   confirmed >= minimum   -> MINIMUM_REACHED, proceed (FULFILLING)
  //   confirmed <  minimum   -> RESCUE_WINDOW opens, no supplier order yet

  async closeDueCampaigns(): Promise<{ closed: number; succeeded: number; failed: number; rescued: number }> {
    const due = await prisma.communityCampaign.findMany({
      where: { status: "LIVE", deadline: { lte: new Date() } },
    });

    let succeeded = 0;
    let failed = 0;
    let rescued = 0;
    for (const campaign of due) {
      const minimum = campaign.minimumShares ?? 0;
      const goal = campaign.goalShares ?? 0;

      if (campaign.confirmedShares >= minimum) {
        const outcome = campaign.confirmedShares >= goal ? "GOAL_REACHED" : "MINIMUM_REACHED";
        // Atomic claim — guards against two overlapping sweep runs (e.g. a
        // manual /jobs/community-buy-sweep trigger racing the daily cron)
        // both deciding the same campaign's outcome and double-firing the
        // supplier order + charge pass.
        const claim = await prisma.communityCampaign.updateMany({
          where: { id: campaign.id, status: "LIVE" },
          data: { status: "FULFILLING", fundingOutcome: outcome, closedAt: new Date() },
        });
        if (claim.count !== 1) continue;
        succeeded++;
        await this.notifyOutcome(campaign.id, "succeeded");
        await this.createSupplierOrder(campaign);
        await this.chargePledgesAfterSuccess(campaign.id);
      } else {
        const rescueEndsAt = new Date(Date.now() + (campaign.rescueDurationMinutes ?? 2880) * 60 * 1000);
        const claim = await prisma.communityCampaign.updateMany({
          where: { id: campaign.id, status: "LIVE" },
          data: { status: "RESCUE_WINDOW", rescueEndsAt },
        });
        if (claim.count !== 1) continue;
        rescued++;
        await this.notifyRescueOpened(campaign.id, rescueEndsAt);
      }
    }
    return { closed: due.length, succeeded, failed, rescued };
  },

  /** One supplier order per campaign, using the actual final confirmedShares — never the goal — doc §11. Self-fulfilled campaigns have no supplier, so no order/payment/fulfilment record applies — the organiser handles it themselves outside this tracked workflow. */
  async createSupplierOrder(campaign: { id: string; supplierId: string | null; supplierAccountId?: string | null; title: string; currency: string | null; confirmedShares: number; pricePerShareMinor: number | null }): Promise<void> {
    if (!campaign.supplierId && !campaign.supplierAccountId) return;
    if (!campaign.pricePerShareMinor) return;
    if (!campaign.currency) return;
    const existing = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId: campaign.id } });
    if (existing) return; // idempotent — never create a second supplier order/payment record.

    const amount = campaign.confirmedShares * campaign.pricePerShareMinor;

    // Workstream 3: the no-Vendor SupplierAccount path is checked first and
    // is otherwise a complete parallel of the legacy branch below (same
    // snapshot-then-notify shape) — untouched when supplierAccountId isn't
    // set, which is every pre-Workstream-3 campaign.
    if (campaign.supplierAccountId) {
      const account = await prisma.supplierAccount.findUnique({ where: { id: campaign.supplierAccountId } });
      await prisma.campaignSupplierPayment.create({
        data: {
          campaignId: campaign.id,
          amount,
          currency: campaign.currency,
          status: "NOT_RELEASED",
          payoutStripeAccountIdAtApproval: account?.providerConnectedAccountId ?? null,
        },
      });
      await prisma.campaignFulfilment.upsert({ where: { campaignId: campaign.id }, update: {}, create: { campaignId: campaign.id } });
      if (account) {
        await notifyCampaign(account.userId, "supplier_order_created", "Campaign order confirmed", `${campaign.title} reached its funding requirement. Final quantity: ${campaign.confirmedShares}.`, campaign.id);
      }
      return;
    }

    const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId! }, include: { vendor: true } });
    await prisma.campaignSupplierPayment.create({
      data: {
        campaignId: campaign.id,
        amount,
        currency: campaign.currency,
        status: "NOT_RELEASED",
        payoutStripeAccountIdAtApproval: supplier?.vendor.stripeAccountId ?? null,
      },
    });
    await prisma.campaignFulfilment.upsert({
      where: { campaignId: campaign.id },
      update: {},
      create: { campaignId: campaign.id },
    });
    if (supplier) {
      await notifyCampaign(supplier.vendor.userId, "supplier_order_created", "Campaign order confirmed", `${campaign.title} reached its funding requirement. Final quantity: ${campaign.confirmedShares}.`, campaign.id);
    }
  },

  async notifyRescueOpened(campaignId: string, rescueEndsAt: Date): Promise<void> {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: { organiser: true, participants: true },
    });
    if (!campaign) return;
    const remaining = Math.max(0, (campaign.minimumShares ?? 0) - campaign.confirmedShares);
    const body = `${campaign.title} needs ${remaining} more share(s) to proceed. The organiser has until ${rescueEndsAt.toISOString()} to act.`;
    await notifyCampaign(campaign.organiser.userId, "rescue_opened", "Campaign needs more participants", body, campaignId, undefined, "organiser");
    for (const p of campaign.participants) {
      await notifyCampaign(p.userId, "rescue_opened", "Campaign needs more participants", body, campaignId);
    }
  },

  // ─── Rescue-window actions — doc §8 ─────────────────────────────────────
  // "Fulfil anyway below the supplier-approved minimum" is explicitly
  // forbidden by the spec. The only ways out of RESCUE_WINDOW are: an
  // organiser top-up purchase (campaign-contributions.service.ts —
  // ordinary paid checkout, re-evaluated atomically on confirmation),
  // inviting more participants (no server action needed), one
  // admin-approved extension, or ending the campaign into refunds.

  /** Evaluates campaigns whose rescue window has expired — run from the cron sweep alongside closeDueCampaigns(). */
  async evaluateRescueExpiry(): Promise<{ rescued: number; failed: number }> {
    const expired = await prisma.communityCampaign.findMany({
      where: { status: "RESCUE_WINDOW", rescueEndsAt: { lte: new Date() } },
    });
    let rescued = 0;
    let failed = 0;
    for (const campaign of expired) {
      const minimum = campaign.minimumShares ?? 0;
      const goal = campaign.goalShares ?? 0;
      if (campaign.confirmedShares >= minimum) {
        // A top-up or a newly confirmed participant pushed this over the
        // line before the window closed — proceed exactly like a normal
        // on-time success.
        const outcome = campaign.confirmedShares >= goal ? "GOAL_REACHED" : "MINIMUM_REACHED";
        await prisma.communityCampaign.update({
          where: { id: campaign.id },
          data: { status: "FULFILLING", fundingOutcome: outcome },
        });
        rescued++;
        await this.notifyOutcome(campaign.id, "succeeded");
        await this.createSupplierOrder(campaign);
        await this.chargePledgesAfterSuccess(campaign.id);
      } else {
        await prisma.communityCampaign.update({
          where: { id: campaign.id },
          data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() },
        });
        failed++;
        await this.notifyOutcome(campaign.id, "failed");
        await this.createRefundRecordsForFailedCampaign(campaign.id);
        await this.cancelPledgesForFailedCampaign(campaign.id);
      }
    }
    return { rescued, failed };
  },

  /**
   * The only point money is ever captured (client mandate 2026-09) —
   * charges every PLEDGED contribution now that the campaign has actually
   * succeeded. Failures here don't undo the success outcome; they're
   * handled per-contribution (retry / support case), never by rolling
   * back the campaign or inventing a refund for a pledge that was simply
   * never charged.
   */
  async chargePledgesAfterSuccess(campaignId: string): Promise<void> {
    const result = await campaignContributionsService.chargeAllPledgesForCampaign(campaignId);
    if (result.failed > 0) {
      logger.warn("Community Buy: some pledges failed to charge after campaign success", { campaignId, ...result });
    }
  },

  /**
   * A campaign that never reached its minimum has, by construction, no
   * PAID contribution (nothing is ever charged before success — see
   * campaign-contributions.service.ts header) — so
   * createRefundRecordsForFailedCampaign() above correctly creates zero
   * refunds. Any contribution still sitting at PLEDGED for this dead
   * campaign is closed out here so it stops showing as "awaiting outcome"
   * in the participant's app.
   */
  async cancelPledgesForFailedCampaign(campaignId: string): Promise<void> {
    await prisma.campaignContribution.updateMany({
      where: { campaignId, status: "PLEDGED" },
      data: { status: "CANCELLED" },
    });
  },

  /** Organiser ends the campaign during its rescue window instead of waiting it out — doc Screen 105. */
  async endRescueAndRefund(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "RESCUE_WINDOW") {
      throw new AppError("Only a campaign in its rescue window can be ended this way", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() },
    });
    // Under PLEDGE_THEN_CHARGE, a campaign can only reach FAILED before it
    // was ever charged (charging happens exclusively on success — see
    // chargePledgesAfterSuccess) — so createRefundRecordsForFailedCampaign
    // correctly finds nothing to refund here. It stays wired in as a
    // harmless no-op safety net, not the primary path any more.
    await this.createRefundRecordsForFailedCampaign(campaignId);
    await this.cancelPledgesForFailedCampaign(campaignId);
    await notifyCampaign(userId, "cancelled", "Campaign ended", `${campaign.title} has been ended. No participant was charged — pledges have been cancelled.`, campaignId, undefined, "organiser");
    const participants = await prisma.campaignParticipant.findMany({ where: { campaignId }, select: { userId: true } });
    for (const p of participants) {
      // NOTIF-DUP-01 fix: this used to ALSO fire a CAMPAIGN_REFUND_UPDATE
      // automation right below, for the identical event/recipient —
      // notifyCampaign() already delivers a real, immediate, correctly-typed
      // ("community_campaign_update") notification; the automation path had
      // no shared dedupeKey with it (unlike renewals.service.ts's reminder
      // pair), so both the in-app row and the push genuinely duplicated.
      // Removed rather than wired to share a dedupeKey: this event has no
      // vendorId/vendor-toggle semantics to preserve (see AUTO-06 — it was
      // never vendor-scoped), and going through the automation path would
      // additionally subject a transactional "you were not charged" message
      // to the quiet-hours suppression notifyCampaign() correctly skips.
      await notifyCampaign(p.userId, "cancelled", "Campaign ended", `${campaign.title} has ended. Your saved payment method was never charged — your pledge is cancelled.`, campaignId);
    }
    return updated;
  },

  /** Doc Screen 108 — one extension maximum, admin-approved, requires supplier reconfirmation. */
  async requestExtension(
    userId: string,
    campaignId: string,
    input: { requestedDeadline: string; reason: string; supplierReconfirmed: boolean; priceUnchangedConfirmed: boolean; participantTermsUnchanged: boolean },
  ) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "RESCUE_WINDOW") {
      throw new AppError("An extension can only be requested while a campaign is in its rescue window", 409);
    }
    if (campaign.extensionCount >= MAX_EXTENSIONS) {
      throw new AppError("This campaign has already used its permitted extension", 409);
    }
    const requestedDeadline = new Date(input.requestedDeadline);
    if (Number.isNaN(requestedDeadline.getTime()) || requestedDeadline <= new Date()) {
      throw new AppError("Requested deadline must be a valid future date", 400);
    }
    return prisma.campaignExtensionRequest.create({
      data: {
        campaignId,
        requestedDeadline,
        reason: input.reason,
        supplierReconfirmed: input.supplierReconfirmed,
        priceUnchangedConfirmed: input.priceUnchangedConfirmed,
        participantTermsUnchanged: input.participantTermsUnchanged,
        status: "PENDING",
      },
    });
  },

  async approveExtension(adminId: string, requestId: string) {
    const request = await prisma.campaignExtensionRequest.findUnique({ where: { id: requestId }, include: { campaign: { include: { organiser: true, participants: true } } } });
    if (!request) throw new AppError("Extension request not found", 404);
    if (request.status !== "PENDING") throw new AppError("This extension request has already been decided", 409);
    if (request.campaign.extensionCount >= MAX_EXTENSIONS) throw new AppError("This campaign has already used its permitted extension", 409);
    if (!request.supplierReconfirmed || !request.priceUnchangedConfirmed) {
      throw new AppError("Supplier reconfirmation and price-unchanged confirmation are required before approval", 400);
    }

    await prisma.$transaction([
      prisma.campaignExtensionRequest.update({ where: { id: requestId }, data: { status: "APPROVED", reviewedById: adminId, reviewedAt: new Date() } }),
      prisma.communityCampaign.update({
        where: { id: request.campaignId },
        data: { status: "LIVE", deadline: request.requestedDeadline, rescueEndsAt: null, extensionCount: { increment: 1 } },
      }),
    ]);

    const body = `${request.campaign.title}'s deadline has been extended to ${request.requestedDeadline.toISOString()}.`;
    await notifyCampaign(request.campaign.organiser.userId, "extension_approved", "Campaign extended", body, request.campaignId, undefined, "organiser");
    for (const p of request.campaign.participants) {
      await notifyCampaign(p.userId, "extension_approved", "Campaign extended", body, request.campaignId);
    }
    return prisma.campaignExtensionRequest.findUnique({ where: { id: requestId } });
  },

  async rejectExtension(adminId: string, requestId: string, notes?: string) {
    const request = await prisma.campaignExtensionRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError("Extension request not found", 404);
    if (request.status !== "PENDING") throw new AppError("This extension request has already been decided", 409);
    return prisma.campaignExtensionRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED", reviewedById: adminId, reviewedAt: new Date(), reviewNotes: notes },
    });
  },

  async listExtensionRequestsForAdmin() {
    return prisma.campaignExtensionRequest.findMany({
      where: { status: "PENDING" },
      include: { campaign: { select: { id: true, title: true, confirmedShares: true, minimumShares: true } } },
      orderBy: { createdAt: "asc" },
    });
  },

  async createRefundRecordsForFailedCampaign(campaignId: string): Promise<number> {
    const paidContributions = await prisma.campaignContribution.findMany({
      where: { campaignId, status: "PAID" },
    });
    let created = 0;
    for (const contribution of paidContributions) {
      try {
        await prisma.campaignRefund.create({
          data: {
            contributionId: contribution.id,
            amount: contribution.amount,
            currency: contribution.currency,
            status: "REFUND_PENDING",
            idempotencyKey: `refund:${contribution.id}`,
          },
        });
        await prisma.campaignContribution.update({ where: { id: contribution.id }, data: { status: "REFUND_PENDING" } });
        created++;
      } catch (error: any) {
        if (error?.code !== "P2002") {
          logger.error("Failed to create campaign refund record", { contributionId: contribution.id, error: String(error) });
        }
      }
    }
    return created;
  },

  async notifyOutcome(campaignId: string, outcome: "succeeded" | "failed") {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: { organiser: true, supplier: true, participants: true },
    });
    if (!campaign) return;

    const title = outcome === "succeeded" ? "Campaign succeeded!" : "Campaign did not reach its target";
    // "failed" here is neutral on purpose — no refund is promised until the
    // organiser actually decides to cancel (see cancelAfterFailure above).
    const body = outcome === "succeeded" ? `${campaign.title} reached its target.` : `${campaign.title} did not reach its target. The organiser will decide what happens next.`;

    await notifyCampaign(campaign.organiser.userId, outcome, title, body, campaignId, undefined, "organiser");
    if (outcome === "succeeded") {
      // NOTIF-DUP-01 fix: this used to ALSO fire a CAMPAIGN_MILESTONE
      // automation per participant for the identical event — see the
      // matching removal + comment in cancelAfterFailure above for the
      // full reasoning (no shared dedupeKey ever existed between the two
      // paths, no vendorId/vendor-toggle semantics to preserve here).
      for (const participant of campaign.participants) {
        await notifyCampaign(participant.userId, outcome, title, body, campaignId);
      }
    } else {
      for (const participant of campaign.participants) {
        await notifyCampaign(participant.userId, outcome, title, body, campaignId);
      }
    }
  },

  /** Deadline-approaching reminder — separate from the closing sweep so it can run more than once per campaign. */
  async remindApproachingDeadlines(): Promise<number> {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const campaigns = await prisma.communityCampaign.findMany({
      where: { status: "LIVE", deadline: { lte: soon, gt: new Date() } },
      include: { participants: true },
    });
    let notified = 0;
    for (const campaign of campaigns) {
      for (const participant of campaign.participants) {
        await automationService.scheduleAutomation({
          type: "CAMPAIGN_DEADLINE",
          recipientUserId: participant.userId,
          // Per-participant — same dedupeKey-collision fix as above.
          subjectKey: `${campaign.id}:deadline:${participant.userId}`,
          frequencyCapDays: 3,
          requiresMarketingConsent: false,
          title: "Campaign deadline approaching",
          body: `${campaign.title} closes soon.`,
          // NAV-10 fix: campaignId is what the new frontend branch needs to
          // deep-link to the actual campaign, not just open a generic screen.
          data: { campaign_title: campaign.title, campaignId: campaign.id },
        });
        notified++;
      }
    }
    return notified;
  },

  /**
   * "Campaign Updates" — two real sources, merged:
   *  1. CampaignUpdate rows: a genuine organiser/supplier broadcast,
   *     identical for every participant (see postCampaignUpdate below).
   *  2. The caller's own per-user Notification rows that notifyCampaign()
   *     already writes for system events (outcome, rescue window,
   *     extension decision, refund progress, etc) — unchanged from before.
   */
  async listMyCampaignUpdates(userId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      select: { organiser: { select: { userId: true } } },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);

    const isOrganiser = campaign.organiser.userId === userId;
    const isParticipant = isOrganiser
      ? true
      : (await prisma.campaignParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId } } })) != null;
    if (!isParticipant) throw new AppError("You don't have access to this campaign's updates", 403);

    const [broadcasts, systemNotifications] = await Promise.all([
      prisma.campaignUpdate.findMany({ where: { campaignId }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.notification.findMany({
        where: { userId, type: "COMMUNITY_CAMPAIGN_UPDATE", data: { path: ["campaignId"], equals: campaignId } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);

    const merged = [
      ...broadcasts.map((u) => ({
        id: u.id,
        source: "broadcast" as const,
        authorRole: u.authorRole,
        title: u.title,
        body: u.message,
        createdAt: u.createdAt,
      })),
      ...systemNotifications.map((n) => ({
        id: n.id,
        source: "system" as const,
        authorRole: "SYSTEM" as const,
        title: n.title,
        body: n.body,
        createdAt: n.createdAt,
      })),
    ];
    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return merged.slice(0, 100);
  },

  /** Statuses a campaign must have reached before it makes sense to broadcast an update at all — never DRAFT/under-review/rejected/cancelled. */
  _postableUpdateStatuses: ["LIVE", "PAUSED", "CLOSING", "RESCUE_WINDOW", "SUCCEEDED", "FAILED", "REFUNDING", "FULFILLING", "COMPLETED", "FINANCIALLY_CLOSED"] as const,

  /**
   * A real organiser or supplier broadcast update (communication content
   * only — no field here can touch price/minimum/goal/maximum, which stay
   * exclusively on CommunityCampaign itself). Fans out a personal
   * Notification to every current participant too, so this shows up
   * alongside system events in their existing notification feed as well
   * as the merged updates list above.
   */
  async postCampaignUpdate(userId: string, campaignId: string, input: { title: string; message: string }) {
    const title = input.title?.trim();
    const message = input.message?.trim();
    if (!title || title.length > 140) throw new AppError("Title is required and must be 140 characters or fewer", 400);
    if (!message || message.length > 2000) throw new AppError("Message is required and must be 2000 characters or fewer", 400);

    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: campaignId },
      include: {
        organiser: { select: { userId: true } },
        supplier: { select: { vendor: { select: { userId: true } } } },
        supplierAccount: { select: { userId: true } },
        participants: { select: { userId: true } },
      },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);

    const isOrganiser = campaign.organiser.userId === userId;
    const isSupplier = campaign.supplier?.vendor.userId === userId || campaign.supplierAccount?.userId === userId;
    if (!isOrganiser && !isSupplier) throw new AppError("Only this campaign's organiser or supplier can post an update", 403);

    if (!(this._postableUpdateStatuses as readonly string[]).includes(campaign.status)) {
      throw new AppError(`Cannot post an update while the campaign is ${campaign.status}`, 409);
    }

    const authorRole = isOrganiser ? "ORGANISER" : "SUPPLIER";
    const update = await prisma.campaignUpdate.create({
      data: { campaignId, authorUserId: userId, authorRole, title, message },
    });

    await recordAudit({
      actorId: userId,
      action: "community_campaign.update_posted",
      entityType: "CommunityCampaign",
      entityId: campaignId,
      metadata: { updateId: update.id, authorRole, title },
    });

    for (const participant of campaign.participants) {
      await notifyCampaign(participant.userId, "organiser_update", title, message, campaignId);
    }

    return update;
  },
};
