import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { automationService } from "../automation/automation.service";
import { marketConfigurationService } from "./market-configuration.service";
import { calculateBoundedServiceFee } from "../../shared/pricing";
import { campaignContributionsService } from "./campaign-contributions.service";
import { campaignAuthorisationService } from "./campaign-authorisation.service";
import { organiserPayoutService } from "./organiser-payout.service";
import { recordAudit } from "../../shared/utils/audit";
import { isIndividualDeliveryEnabled, revokeDeliveryReferencesForCampaign, recordDataAccess } from "./community-buy-privacy.service";

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
  // Phase 2 (organiser controls) — optional per-buyer slot limits. See
  // CommunityCampaign.perBuyerMinShares/perBuyerMaxShares's own doc comment.
  perBuyerMinShares?: number;
  perBuyerMaxShares?: number;
  pricePerShareMinor?: number;
  // Diaspora escrow reconciliation (final V1 settlement doc §N) — the
  // organiser-agreed wholesale price paid to an Eki-registered supplier.
  // Only meaningful when fulfilmentOwner is SUPPLIER; ignored/irrelevant for
  // SELF. See CommunityCampaign.wholesaleAmountMinor's own doc comment.
  wholesaleAmountMinor?: number;
  deadline?: string;
  rescueDurationMinutes?: number;
  // Product step (spec §7 step 1).
  images?: string[];
  unit?: string;
  quantityPerOrder?: number;
  qualityNotes?: string;
  // Delivery step (spec §7 step 5) — organiser intent only, no address data.
  deliveryPreference?: "COLLECTION" | "DELIVERY";
  // Phase 3 (address + privacy foundation) — organiser receiving
  // configuration. See CommunityCampaign.collectionAddressLine1 and
  // .deliveryCoverageAreas's own doc comments.
  collectionAddressLine1?: string;
  collectionAddressLine2?: string;
  collectionCity?: string;
  collectionPostcode?: string;
  deliveryCoverageAreas?: string[];
  // Phase 6 (delivery + collection/tracking) — see
  // CommunityCampaign.deliveryFeeAmountMinor's own doc comment.
  deliveryFeeAmountMinor?: number;
  // M2 — AUTHORISE_THEN_CAPTURE-mode scheduling (spec §7 step 4, §11.3).
  // Ignored/unused for a campaign whose snapshotted paymentMode ends up
  // PLEDGE_THEN_CHARGE. Not yet surfaced in the mobile organiser wizard
  // (that's a later milestone) — accepted here so the backend and its
  // tests are complete independent of when mobile UI catches up.
  holdWindowStartsAt?: string;
  decisionDeadline?: string;
  // Phase 2 (organiser controls) — optional scheduled opening. See
  // CommunityCampaign.scheduledOpenAt's own doc comment.
  scheduledOpenAt?: string;
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
function validateSharesAndPricing(fields: { minimumShares?: number; goalShares?: number; maximumShares?: number; pricePerShareMinor?: number; wholesaleAmountMinor?: number }): void {
  const { minimumShares, goalShares, maximumShares, pricePerShareMinor, wholesaleAmountMinor } = fields;
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
  // Diaspora escrow reconciliation — must never exceed the retail total the
  // organiser is charging participants, or the organiser's payout would be
  // negative (silently clamped to 0 by releaseOrganiserPayment(), but an
  // organiser entering a wholesale figure larger than their own retail price
  // is virtually always a data-entry mistake worth rejecting up front).
  if (wholesaleAmountMinor !== undefined) {
    if (!Number.isInteger(wholesaleAmountMinor) || wholesaleAmountMinor < 0) {
      throw new AppError("Wholesale amount must be a non-negative integer", 400);
    }
    if (maximumShares !== undefined && pricePerShareMinor !== undefined && wholesaleAmountMinor > maximumShares * pricePerShareMinor) {
      throw new AppError("Wholesale amount cannot exceed the campaign's maximum possible retail total", 400);
    }
  }
}

// Phase 2 (organiser identity display preference) — shared by every
// buyer-facing campaign read (get()/listLive()) so the rule lives in one
// place. Falls back to the full name if there's no name to split (never
// fabricates a placeholder).
function resolveOrganiserDisplayName(name: string | null | undefined, firstNameOnlyDisplay: boolean): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "Community organiser";
  if (!firstNameOnlyDisplay) return trimmed;
  return trimmed.split(/\s+/)[0];
}

function validateDeadline(deadline: string | undefined): Date | undefined {
  if (deadline === undefined) return undefined;
  const parsed = new Date(deadline);
  if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
    throw new AppError("Deadline must be a valid future date", 400);
  }
  return parsed;
}

// M2 — spec §7 step 4: "no hard-coded authorisation duration." Organiser
// sets both dates explicitly; this only enforces the ordering invariant
// (hold window can't start before the deadline/commitment-lock, decision
// can't precede the hold window) — the actual "~5 days before decision"
// default is a UI suggestion for later milestones, not a backend rule.
function validateAuthorisationSchedule(
  holdWindowStartsAt: string | undefined,
  decisionDeadline: string | undefined,
  deadline: Date | undefined,
): { holdWindowStartsAt?: Date; decisionDeadline?: Date } {
  const result: { holdWindowStartsAt?: Date; decisionDeadline?: Date } = {};
  if (holdWindowStartsAt !== undefined) {
    const parsed = new Date(holdWindowStartsAt);
    if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
      throw new AppError("Hold window start must be a valid future date", 400);
    }
    if (deadline && parsed < deadline) {
      throw new AppError("Hold window cannot start before the commitment lock (deadline)", 400);
    }
    result.holdWindowStartsAt = parsed;
  }
  if (decisionDeadline !== undefined) {
    const parsed = new Date(decisionDeadline);
    if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
      throw new AppError("Decision deadline must be a valid future date", 400);
    }
    if (result.holdWindowStartsAt && parsed < result.holdWindowStartsAt) {
      throw new AppError("Decision deadline cannot be before the hold window starts", 400);
    }
    if (deadline && parsed < deadline) {
      throw new AppError("Decision deadline cannot be before the commitment lock (deadline)", 400);
    }
    result.decisionDeadline = parsed;
  }
  return result;
}

// Phase 2 (organiser controls) — mirrors validateSharesAndPricing's shape
// exactly: independent per-field validity, then a cross-field ordering
// check against the campaign-wide maximumShares (existing or newly-set).
function validatePerBuyerLimits(fields: { perBuyerMinShares?: number; perBuyerMaxShares?: number }, maximumShares: number | undefined): void {
  const { perBuyerMinShares, perBuyerMaxShares } = fields;
  if (perBuyerMinShares !== undefined && (!Number.isInteger(perBuyerMinShares) || perBuyerMinShares < 1)) {
    throw new AppError("Per-buyer minimum must be at least 1", 400);
  }
  if (perBuyerMaxShares !== undefined) {
    if (!Number.isInteger(perBuyerMaxShares) || perBuyerMaxShares < 1) {
      throw new AppError("Per-buyer maximum must be at least 1", 400);
    }
    if (perBuyerMinShares !== undefined && perBuyerMaxShares < perBuyerMinShares) {
      throw new AppError("Per-buyer maximum must be at least the per-buyer minimum", 400);
    }
    if (maximumShares !== undefined && perBuyerMaxShares > maximumShares) {
      throw new AppError("Per-buyer maximum cannot exceed the campaign's total maximum shares", 400);
    }
  }
}

// Phase 2 (organiser controls) — mirrors validateDeadline's shape exactly;
// additionally ordered before the campaign's own deadline/close (opening
// after closing would never let a single pledge happen).
function validateScheduledOpenAt(scheduledOpenAt: string | undefined, deadline: Date | undefined): Date | undefined {
  if (scheduledOpenAt === undefined) return undefined;
  const parsed = new Date(scheduledOpenAt);
  if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
    throw new AppError("Scheduled opening must be a valid future date", 400);
  }
  if (deadline && parsed >= deadline) {
    throw new AppError("Scheduled opening must be before the campaign deadline", 400);
  }
  return parsed;
}

function validateQuantityPerOrder(quantityPerOrder: number | undefined): void {
  if (quantityPerOrder !== undefined && (!Number.isInteger(quantityPerOrder) || quantityPerOrder < 1)) {
    throw new AppError("Quantity per order must be at least 1", 400);
  }
}

/**
 * A raw JSON body isn't TS-checked at runtime — reject anything outside the
 * real enum with a clean 400 instead of letting an invalid value reach
 * Prisma as a DB-level enum error.
 *
 * M4 (spec §14.2, AT-38): DELIVERY is additionally rejected outright unless
 * COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED is set — never silently
 * downgraded to COLLECTION. "There is no creator override" (spec §14.2) —
 * this fails the request rather than coercing it.
 */
function validateDeliveryPreference(deliveryPreference: string | undefined): void {
  if (deliveryPreference !== undefined && deliveryPreference !== "COLLECTION" && deliveryPreference !== "DELIVERY") {
    throw new AppError("deliveryPreference must be COLLECTION or DELIVERY", 400);
  }
  if (deliveryPreference === "DELIVERY" && !isIndividualDeliveryEnabled()) {
    throw new AppError(
      "Individual delivery is not available yet — this campaign must use collection point.",
      400,
      undefined,
      "INDIVIDUAL_DELIVERY_NOT_AVAILABLE",
    );
  }
}

/**
 * campaign-authorisation.service.ts's commit()/AUTHORISE_THEN_CAPTURE flow
 * was built with no knowledge of delivery at all: it never accepts a
 * deliveryAddress, never validates deliveryCoverageAreas, and never adds
 * deliveryFeeAmountMinor into consentedChargeAmount the way createPledge()
 * does for PLEDGE_THEN_CHARGE. paymentMode and individual-delivery are two
 * independently-toggled gates (per-market payment mode vs a global env
 * var), so nothing else stops both being on for the same campaign — this
 * is the one place that combination is refused outright, the same
 * fail-closed shape as validateDeliveryPreference above, rather than
 * silently under-charging a real buyer or leaving their order address-less.
 */
function validateDeliveryPaymentModeCompatibility(paymentMode: string, deliveryPreference: string): void {
  if (paymentMode === "AUTHORISE_THEN_CAPTURE" && deliveryPreference === "DELIVERY") {
    throw new AppError(
      "Individual delivery is not yet supported for this market's payment mode — use collection point.",
      400,
      undefined,
      "INDIVIDUAL_DELIVERY_NOT_AVAILABLE",
    );
  }
}

// Phase 6 (delivery + collection/tracking) — real, organiser-set delivery
// charge. Format only; submit()'s "missing" gate requires it once
// deliveryPreference is DELIVERY, same two-stage pattern as the collection
// address / coverage-area fields above.
function validateDeliveryFeeAmount(deliveryFeeAmountMinor: number | undefined): void {
  if (deliveryFeeAmountMinor !== undefined && (!Number.isInteger(deliveryFeeAmountMinor) || deliveryFeeAmountMinor < 0)) {
    throw new AppError("Delivery fee must be a non-negative integer", 400);
  }
}

// Phase 3 (address + privacy foundation) — the organiser's public
// collection-point address and/or delivery coverage areas. Format/presence
// only; submit()'s "missing" gate is what actually requires these before a
// campaign can go live (mirrors every other Product/Delivery-step field's
// draft-now/gate-at-submit pattern). Coverage areas are normalized
// (trimmed, uppercased, deduped, empties dropped) so the prefix match in
// assertDeliveryAddressWithinCoverage() behaves consistently regardless of
// how the organiser typed them in.
function validateAndNormalizeCoverageAreas(deliveryCoverageAreas: string[] | undefined): string[] | undefined {
  if (deliveryCoverageAreas === undefined) return undefined;
  if (!Array.isArray(deliveryCoverageAreas) || deliveryCoverageAreas.some((a) => typeof a !== "string")) {
    throw new AppError("deliveryCoverageAreas must be an array of strings", 400);
  }
  const normalized = Array.from(
    new Set(deliveryCoverageAreas.map((a) => a.trim().toUpperCase()).filter(Boolean)),
  );
  return normalized;
}

function validateCollectionAddressFields(fields: {
  collectionAddressLine1?: string;
  collectionAddressLine2?: string;
  collectionCity?: string;
  collectionPostcode?: string;
}): void {
  // Named explicitly (not Object.entries(fields)) — the caller passes the
  // whole create/update input, which also carries unrelated fields (e.g.
  // deliveryCoverageAreas, an array) that would break a blind .trim() scan.
  const checks: [string, string | undefined][] = [
    ["collectionAddressLine1", fields.collectionAddressLine1],
    ["collectionAddressLine2", fields.collectionAddressLine2],
    ["collectionCity", fields.collectionCity],
    ["collectionPostcode", fields.collectionPostcode],
  ];
  for (const [key, value] of checks) {
    if (value !== undefined && !value.trim()) {
      throw new AppError(`${key} cannot be blank`, 400);
    }
  }
}

const MAX_EXTENSIONS = 1;

// Client-corrected flow: supplier acceptance/decline/reassignment is
// fulfilment workflow state, not a publication gate — so unlike before
// (DRAFT/CHANGES_REQUIRED only), a supplier can respond at any point up to
// the campaign actually closing out. Excludes only the terminal/closing
// statuses where a supplier decision no longer means anything.
// Phase 5 (organiser<->supplier negotiation) — exported so
// campaign-supplier-proposal.service.ts can gate proposal submission on
// the exact same "still negotiable" window, rather than defining a
// second, potentially-drifting copy of this list.
export const SUPPLIER_RESPONSE_STATUSES = [
  "DRAFT",
  "CHANGES_REQUIRED",
  "UNDER_REVIEW",
  "APPROVED",
  "LIVE",
  "PAUSED",
  "RESCUE_WINDOW",
] as const;

// Exported (Phase 5) so campaign-supplier-proposal.service.ts can reuse the
// exact same notification shape/dedupe/audience-tagging convention instead
// of duplicating it.
export async function notifyCampaign(
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
    validatePerBuyerLimits(input, input.maximumShares);
    validateQuantityPerOrder(input.quantityPerOrder);
    validateDeliveryPreference(input.deliveryPreference);
    validateCollectionAddressFields(input);
    validateDeliveryFeeAmount(input.deliveryFeeAmountMinor);
    const deliveryCoverageAreas = validateAndNormalizeCoverageAreas(input.deliveryCoverageAreas);
    const deadline = validateDeadline(input.deadline);
    const authorisationSchedule = validateAuthorisationSchedule(input.holdWindowStartsAt, input.decisionDeadline, deadline);
    const scheduledOpenAt = validateScheduledOpenAt(input.scheduledOpenAt, deadline);

    // M2 — snapshotted once, here, never re-read afterward (see
    // CommunityCampaign.paymentMode's own doc comment).
    const paymentMode = await marketConfigurationService.resolveNewCampaignPaymentMode(input.country);
    validateDeliveryPaymentModeCompatibility(paymentMode, input.deliveryPreference ?? "COLLECTION");

    const campaign = await prisma.communityCampaign.create({
      data: {
        organiserId: organiser.id,
        paymentMode,
        holdWindowStartsAt: authorisationSchedule.holdWindowStartsAt,
        decisionDeadline: authorisationSchedule.decisionDeadline,
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
        perBuyerMinShares: input.perBuyerMinShares,
        perBuyerMaxShares: input.perBuyerMaxShares,
        pricePerShareMinor: input.pricePerShareMinor,
        wholesaleAmountMinor: input.wholesaleAmountMinor,
        images: input.images ?? [],
        unit: input.unit,
        quantityPerOrder: input.quantityPerOrder,
        qualityNotes: input.qualityNotes,
        deliveryPreference: input.deliveryPreference ?? "COLLECTION",
        collectionAddressLine1: input.collectionAddressLine1,
        collectionAddressLine2: input.collectionAddressLine2,
        collectionCity: input.collectionCity,
        collectionPostcode: input.collectionPostcode,
        deliveryCoverageAreas: deliveryCoverageAreas ?? [],
        deliveryFeeAmountMinor: input.deliveryFeeAmountMinor,
        rescueDurationMinutes: input.rescueDurationMinutes ?? 2880,
        deadline,
        scheduledOpenAt,
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
      || input.maximumShares !== undefined || input.pricePerShareMinor !== undefined || input.deadline !== undefined
      || input.holdWindowStartsAt !== undefined || input.decisionDeadline !== undefined || input.wholesaleAmountMinor !== undefined
      || input.perBuyerMinShares !== undefined || input.perBuyerMaxShares !== undefined || input.deliveryFeeAmountMinor !== undefined;
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
    validatePerBuyerLimits(input, input.maximumShares ?? campaign.maximumShares ?? undefined);
    validateQuantityPerOrder(input.quantityPerOrder);
    validateDeliveryPreference(input.deliveryPreference);
    validateDeliveryPaymentModeCompatibility(campaign.paymentMode, input.deliveryPreference ?? campaign.deliveryPreference);
    validateCollectionAddressFields(input);
    validateDeliveryFeeAmount(input.deliveryFeeAmountMinor);
    const deliveryCoverageAreas = validateAndNormalizeCoverageAreas(input.deliveryCoverageAreas);
    const deadline = validateDeadline(input.deadline);
    const authorisationSchedule = validateAuthorisationSchedule(input.holdWindowStartsAt, input.decisionDeadline, deadline ?? campaign.deadline ?? undefined);
    const scheduledOpenAt = validateScheduledOpenAt(input.scheduledOpenAt, deadline ?? campaign.deadline ?? undefined);

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
        ...(input.perBuyerMinShares !== undefined && { perBuyerMinShares: input.perBuyerMinShares }),
        ...(input.perBuyerMaxShares !== undefined && { perBuyerMaxShares: input.perBuyerMaxShares }),
        ...(input.pricePerShareMinor !== undefined && {
          pricePerShareMinor: input.pricePerShareMinor,
          targetAmount: (input.goalShares ?? campaign.goalShares ?? 0) * input.pricePerShareMinor,
        }),
        ...(input.wholesaleAmountMinor !== undefined && { wholesaleAmountMinor: input.wholesaleAmountMinor }),
        ...(input.collectionAddressLine1 !== undefined && { collectionAddressLine1: input.collectionAddressLine1 }),
        ...(input.collectionAddressLine2 !== undefined && { collectionAddressLine2: input.collectionAddressLine2 }),
        ...(input.collectionCity !== undefined && { collectionCity: input.collectionCity }),
        ...(input.collectionPostcode !== undefined && { collectionPostcode: input.collectionPostcode }),
        ...(deliveryCoverageAreas !== undefined && { deliveryCoverageAreas }),
        ...(input.deliveryFeeAmountMinor !== undefined && { deliveryFeeAmountMinor: input.deliveryFeeAmountMinor }),
        ...(deadline !== undefined && { deadline }),
        ...(scheduledOpenAt !== undefined && { scheduledOpenAt }),
        ...(authorisationSchedule.holdWindowStartsAt !== undefined && { holdWindowStartsAt: authorisationSchedule.holdWindowStartsAt }),
        ...(authorisationSchedule.decisionDeadline !== undefined && { decisionDeadline: authorisationSchedule.decisionDeadline }),
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
    // M4 (spec §7.2, §14.4) — "revoke the old supplier's campaign/data
    // access immediately" before granting the new one. In the currently
    // shipped state machine this is always a no-op in practice: reassignment
    // is only reachable pre-close (the SUPPLIER_RESPONSE_STATUSES check
    // above) and before termsLockedAt, i.e. strictly before any contribution
    // could ever have been captured — so no DeliveryReference row can exist
    // yet to revoke. Called anyway for exact spec compliance and so this
    // stays correct if that gate is ever loosened.
    await revokeDeliveryReferencesForCampaign(campaignId, "supplier_replaced", userId);
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
    // Phase 3 (address + privacy foundation) — receiving configuration must
    // be set before a campaign can go live, same gate-at-submit pattern as
    // every other required field above.
    if (campaign.deliveryPreference === "COLLECTION") {
      if (!campaign.collectionAddressLine1) missing.push("collectionAddressLine1");
      if (!campaign.collectionCity) missing.push("collectionCity");
      if (!campaign.collectionPostcode) missing.push("collectionPostcode");
    } else if (campaign.deliveryPreference === "DELIVERY") {
      if (!campaign.deliveryCoverageAreas || campaign.deliveryCoverageAreas.length === 0) missing.push("deliveryCoverageAreas");
      // Phase 6 (delivery + collection/tracking) — a real delivery charge
      // must be set (0 is a valid "free delivery" choice; only null/unset
      // or negative is missing) before this campaign can go live.
      if (campaign.deliveryFeeAmountMinor == null || campaign.deliveryFeeAmountMinor < 0) missing.push("deliveryFeeAmountMinor");
    }
    if (campaign.paymentMode === "AUTHORISE_THEN_CAPTURE") {
      if (!campaign.holdWindowStartsAt) missing.push("holdWindowStartsAt");
      if (!campaign.decisionDeadline) missing.push("decisionDeadline");
      // M2 scope: Stripe Connect Direct Charges needs a supplier connected
      // account as the merchant of record (spec §11.1) — organisers have no
      // Connect account in this codebase (organiser payout is WS8, out of
      // scope here), so a self-fulfilled campaign has nothing to charge
      // against under this mode. Blocked explicitly rather than silently
      // failing later at hold-creation time.
      if (campaign.fulfilmentOwner === "SELF") missing.push("self_fulfilment_not_supported_for_authorise_then_capture");
    }

    if (campaign.fulfilmentOwner === "SUPPLIER") {
      // Workstream 3: a campaign assigned through the no-Vendor-required
      // SupplierAccount path has supplierId === null by design (only
      // supplierAccountId is set — see CreateCampaignInput's own doc
      // comment). Checking supplierId alone here meant every such campaign
      // failed this gate permanently with "missing: supplierId", even
      // though a real, approved supplier was assigned — submit() never
      // knew the new field existed. Same dual-path check as
      // confirmSupplierCommitment (legacy) vs confirmSupplierCommitmentForAccount (new).
      if (campaign.supplierId) {
        const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId } });
        if (!supplier || !supplier.isVerified || supplier.isRestricted) missing.push("supplier_eligibility");
      } else if (campaign.supplierAccountId) {
        const account = await prisma.supplierAccount.findUnique({ where: { id: campaign.supplierAccountId } });
        if (!account || account.supplierState !== "APPROVED") missing.push("supplier_eligibility");
      } else {
        missing.push("supplierId");
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

  /**
   * "Participants" — every contributor to the organiser's own campaign,
   * with their real total.
   *
   * M4 (spec §14.3, AT-44): for a SELF-fulfilled campaign the organiser IS
   * the fulfiller — there is no separate supplier to hide contact details
   * from, but the same "only fulfilment-necessary data, no contact export"
   * principle still applies. name/email are omitted for SELF; a genuine
   * third-party-supplied campaign's organiser (who is not the one fulfilling
   * orders) keeps the existing full view unchanged.
   */
  async listParticipantsForOrganiser(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    const participants = await prisma.campaignParticipant.findMany({
      where: { campaignId, contributions: { some: { status: "PAID" } } },
      include: {
        user: { select: { name: true, email: true } },
        contributions: {
          where: { status: "PAID" },
          select: {
            quantity: true, amount: true, isOrganiserTopUp: true, createdAt: true,
            // Phase 3 — only ever read here (the owning organiser's own
            // participant list), never in the supplier-facing manifest.
            deliveryRecipientName: true, deliveryAddressLine1: true, deliveryAddressLine2: true, deliveryCity: true, deliveryPostcode: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });
    const isSelfSupply = campaign.fulfilmentOwner === "SELF";
    // Phase 3 (address + privacy foundation) — a buyer's delivery address
    // is only ever meaningful for a DELIVERY campaign, and is shown to its
    // owning organiser regardless of fulfilmentOwner: unlike name/email
    // (a relationship/contact-export concern, gated by isSelfSupply above,
    // unchanged), the organiser is the one who configured delivery coverage
    // and is responsible for goods actually reaching participants either
    // way. Never exposed to a supplier — see community-buy-manifest.
    // service.ts's own "no raw home addresses" doc comment.
    const showAddress = campaign.deliveryPreference === "DELIVERY";
    if (showAddress && participants.length > 0) {
      await recordDataAccess({
        campaignId,
        accessorUserId: userId,
        accessorRole: "ORGANISER",
        dataCategory: "ADDRESS_DETAIL",
        action: "VIEWED",
        purposeCode: "organiser_participant_list",
      });
    }
    return participants.map((p) => {
      const latestPaid = p.contributions[p.contributions.length - 1];
      return {
        userId: p.userId,
        ...(isSelfSupply ? {} : { name: p.user.name, email: p.user.email }),
        joinedAt: p.joinedAt,
        totalQuantity: p.contributions.reduce((sum, c) => sum + c.quantity, 0),
        totalPaid: p.contributions.reduce((sum, c) => sum + c.amount, 0),
        isOrganiser: p.contributions.some((c) => c.isOrganiserTopUp),
        ...(showAddress && latestPaid?.deliveryAddressLine1
          ? {
              deliveryAddress: {
                recipientName: latestPaid.deliveryRecipientName,
                addressLine1: latestPaid.deliveryAddressLine1,
                addressLine2: latestPaid.deliveryAddressLine2,
                city: latestPaid.deliveryCity,
                postcode: latestPaid.deliveryPostcode,
              },
            }
          : {}),
      };
    });
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
      // making rescue/deadline monitoring impossible. M3: the same
      // reasoning applies to AUTHORISE_THEN_CAPTURE's own in-flight
      // statuses — a campaign sitting in DECISION_REQUIRED or
      // AWAITING_SUPPLIER_RECONFIRMATION needs to be visible to admin for
      // exactly the same monitoring/recovery reasons RESCUE_WINDOW already
      // is.
      // Phase 4 — CANCELLATION_UNDER_REVIEW added for the same reason as
      // RESCUE_WINDOW/DECISION_REQUIRED above: invisible here would make it
      // impossible for admin to find and act on a pending cancellation
      // request via the campaign detail page.
      where: { status: { in: ["SUCCEEDED", "FAILED", "FULFILLING", "CANCELLED", "LIVE", "PAUSED", "RESCUE_WINDOW", "HOLD_WINDOW", "DECISION_REQUIRED", "AWAITING_SUPPLIER_RECONFIRMATION", "PAYMENT_CAPTURE", "CANCELLATION_UNDER_REVIEW"] } },
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
    // M3/M9 (AT-25) — AUTHORISE_THEN_CAPTURE's own in-flight statuses added
    // alongside the original PLEDGE_THEN_CHARGE-era list. A campaign in
    // PAYMENT_CAPTURE may already have SOME captured (PAID) contributions
    // by the time an admin cancels it — those get a REAL refund
    // (createRefundRecordsForFailedCampaign() below is already payment-
    // mode-agnostic: it only looks at CampaignContribution.status="PAID",
    // which capture sets regardless of mode), while whatever holds are
    // still open get released, never captured.
    const cancellable = [
      "DRAFT", "UNDER_REVIEW", "CHANGES_REQUIRED", "APPROVED", "LIVE", "PAUSED", "RESCUE_WINDOW",
      "HOLD_WINDOW", "DECISION_REQUIRED", "AWAITING_SUPPLIER_RECONFIRMATION", "PAYMENT_CAPTURE",
    ];
    if (!cancellable.includes(campaign.status)) {
      throw new AppError("This campaign can no longer be cancelled — it has already succeeded, failed, or ended", 409);
    }
    const updated = await prisma.communityCampaign.update({
      where: { id: campaignId },
      data: { status: "CANCELLED", closedAt: new Date(), reviewNotes: reason },
    });
    // AT-25 — captured contributions get a real refund record regardless of
    // payment mode; releaseAllHoldsForCampaign() (M2 only) never touches
    // those (captureStatus-filtered, see its own doc comment) so the two
    // calls can never double-process the same authorisation.
    const refundsCreated = await this.createRefundRecordsForFailedCampaign(campaignId);
    // Individual Delivery correctness, same defensive shape as
    // reassignSupplier()'s call to this function: today this is a no-op for
    // every reachable case (a DELIVERY-mode campaign is always
    // PLEDGE_THEN_CHARGE — validateDeliveryPaymentModeCompatibility() above
    // forbids AT+DELIVERY — so it can only hit this function pre-charge,
    // never with a real address-bearing DeliveryReference row; the
    // AT-mode-only PAYMENT_CAPTURE/HOLD_WINDOW/etc statuses that CAN have
    // PAID contributions can only ever be COLLECTION, which never has an
    // address to revoke). Called anyway so this stays correct if either
    // gate is ever loosened, rather than silently leaving a cancelled
    // campaign's delivery address visible to the supplier.
    await revokeDeliveryReferencesForCampaign(campaignId, "campaign_cancelled", adminId);
    if (campaign.paymentMode === "AUTHORISE_THEN_CAPTURE") {
      // Reuses the exact same hold-release path decide()'s own cancel
      // branch and the timeout sweeps already use — no parallel
      // implementation of "how does a hold get released" invented here.
      await campaignAuthorisationService.releaseAllHoldsForCampaign(campaignId, "admin_cancelled");
    } else {
      // Defensive, matching endRescueAndRefund() exactly — see method comment
      // above for why this is always a no-op today, kept as a safety net.
      await this.cancelPledgesForFailedCampaign(campaignId);
    }
    // AT-25 — a participant already charged must never be told "you were
    // not charged." refundedUserIds separates the two truthful messages;
    // the actual "your refund is being processed"/"refund completed"
    // notification comes later from processPendingRefunds() once Stripe
    // confirms — this is just the immediate, accurate "what happened" note.
    const refundedContributions = refundsCreated > 0
      ? await prisma.campaignContribution.findMany({ where: { campaignId, status: "REFUND_PENDING" }, include: { participant: true } })
      : [];
    const refundedUserIds = new Set(refundedContributions.map((c) => c.participant.userId));
    const organiserBody = refundedUserIds.size > 0
      ? `${campaign.title} has been ended by an administrator. ${refundedUserIds.size} participant(s) who were already charged are being refunded; other pledges have been cancelled. Reason: ${reason}`
      : `${campaign.title} has been ended by an administrator. No participant was charged — pledges have been cancelled. Reason: ${reason}`;
    await notifyCampaign(campaign.organiser.userId, "admin_cancelled", "Campaign ended by admin", organiserBody, campaignId, `admin_cancelled:${campaignId}:${campaign.organiser.userId}`, "organiser");
    for (const p of campaign.participants) {
      const body = refundedUserIds.has(p.userId)
        ? `${campaign.title} has been ended by an administrator. You had already been charged — your payment is being refunded to your original payment method.`
        : `${campaign.title} has been ended by an administrator. Your saved payment method was never charged — your pledge is cancelled.`;
      await notifyCampaign(p.userId, "admin_cancelled", "Campaign ended", body, campaignId, `admin_cancelled:${campaignId}:${p.userId}`);
    }
    return updated;
  },

  /**
   * Phase 4 (cancellation under review) — organiser-initiated. Reachable
   * from every "live-ish" status a campaign can be in, both before AND
   * after a successful close. The routing decision (immediate cancel vs.
   * admin-reviewed) is made purely on whether any real money has been
   * captured — never on status alone, since under PLEDGE_THEN_CHARGE a
   * campaign is charged in the exact same instant it leaves LIVE (see
   * closeDueCampaigns()), so there is no "some paid, still LIVE" window to
   * special-case.
   */
  async requestCancellation(userId: string, campaignId: string, reason: string) {
    if (!reason?.trim()) throw new AppError("A reason is required", 400);
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    const requestable = ["LIVE", "PAUSED", "RESCUE_WINDOW", "FULFILLING", "SUCCEEDED"];
    if (!requestable.includes(campaign.status)) {
      throw new AppError("Cancellation can't be requested from this campaign's current status", 409);
    }
    const existingPending = await prisma.campaignCancellationRequest.findFirst({ where: { campaignId, status: "PENDING" } });
    if (existingPending) throw new AppError("A cancellation request is already pending review for this campaign", 409);

    const paidCount = await prisma.campaignContribution.count({ where: { campaignId, status: "PAID" } });
    const hadFinancialActivity = paidCount > 0;

    if (!hadFinancialActivity) {
      // Nothing captured yet — reuses the exact same primitives admin
      // cancel() uses for this identical case, just with organiser-facing
      // copy (never "ended by an administrator", since they did it
      // themselves) and no admin review needed.
      const [updated] = await prisma.$transaction([
        prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "CANCELLED", closedAt: new Date(), reviewNotes: reason } }),
        prisma.campaignCancellationRequest.create({
          data: { campaignId, requestedByUserId: userId, reason, hadFinancialActivity: false, preCancellationStatus: campaign.status, status: "APPROVED", reviewedAt: new Date(), reviewNotes: "Auto-approved — no funds had been captured yet" },
        }),
      ]);
      await this.cancelPledgesForFailedCampaign(campaignId);
      const participants = await prisma.campaignParticipant.findMany({ where: { campaignId } });
      for (const p of participants) {
        await notifyCampaign(p.userId, "organiser_cancelled", "Campaign ended", `${campaign.title} has been ended by its organiser. Your saved payment method was never charged — your pledge is cancelled.`, campaignId, `organiser_cancelled:${campaignId}:${p.userId}`);
      }
      return { campaign: updated, request: null, requiresReview: false as const };
    }

    // Real money has been captured — this is exactly the "different,
    // harder problem" cancel()'s own comment flags as out of scope for a
    // direct admin action. Routes to admin review instead of acting.
    const claim = await prisma.communityCampaign.updateMany({
      where: { id: campaignId, status: campaign.status },
      data: { status: "CANCELLATION_UNDER_REVIEW" },
    });
    if (claim.count !== 1) throw new AppError("This campaign's status just changed — try again", 409);
    const request = await prisma.campaignCancellationRequest.create({
      data: { campaignId, requestedByUserId: userId, reason, hadFinancialActivity: true, preCancellationStatus: campaign.status, status: "PENDING" },
    });
    const participants = await prisma.campaignParticipant.findMany({ where: { campaignId } });
    for (const p of participants) {
      await notifyCampaign(p.userId, "cancellation_under_review", "Cancellation under review", `The organiser has requested to end "${campaign.title}". Eki is reviewing this request — you'll be notified once a decision is made.`, campaignId, `cancellation_under_review:${campaignId}:${p.userId}`);
    }
    return { campaign: await prisma.communityCampaign.findUniqueOrThrow({ where: { id: campaignId } }), request, requiresReview: true as const };
  },

  async listCancellationRequestsForAdmin() {
    return prisma.campaignCancellationRequest.findMany({
      where: { status: "PENDING" },
      include: { campaign: { select: { id: true, title: true, confirmedShares: true, paidTotal: true, currency: true } } },
      orderBy: { createdAt: "asc" },
    });
  },

  /**
   * Admin approves a cancellation that already has captured funds.
   * Refund creation reuses createRefundRecordsForFailedCampaign() verbatim
   * (already idempotent — P2002-safe on its unique refund idempotency key);
   * actual Stripe refund execution stays on the existing
   * processPendingRefunds() cron sweep, unchanged. Blocks entirely if the
   * supplier payment or organiser payout has already been released — no
   * clawback mechanism exists, and inventing one is explicitly out of
   * scope (this mirrors the exact guard holdSupplierPayment()/
   * holdOrganiserPayout() already enforce, checked here first so a blocked
   * approval never leaves the request half-decided).
   */
  async approveCancellation(adminId: string, requestId: string) {
    const request = await prisma.campaignCancellationRequest.findUnique({
      where: { id: requestId },
      include: { campaign: { include: { organiser: true, participants: true } } },
    });
    if (!request) throw new AppError("Cancellation request not found", 404);
    if (request.status !== "PENDING") throw new AppError("This cancellation request has already been decided", 409);

    const [supplierPayment, organiserPayout] = await Promise.all([
      prisma.campaignSupplierPayment.findUnique({ where: { campaignId: request.campaignId } }),
      prisma.communityBuyOrganiserPayout.findUnique({ where: { campaignId: request.campaignId } }),
    ]);
    if (supplierPayment?.status === "PAID") {
      throw new AppError("The supplier has already been paid for this campaign — cancellation can't be approved automatically. Contact ops for a manual reversal.", 409, undefined, "SUPPLIER_ALREADY_PAID");
    }
    if (organiserPayout?.status === "PAID") {
      throw new AppError("The organiser has already been paid for this campaign — cancellation can't be approved automatically. Contact ops for a manual reversal.", 409, undefined, "ORGANISER_ALREADY_PAID");
    }

    // Atomic claim — the same guarded-transition pattern every other
    // admin decision in this file uses; a concurrent double-click only
    // ever lets one caller win.
    const requestClaim = await prisma.campaignCancellationRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "APPROVED", reviewedById: adminId, reviewedAt: new Date() },
    });
    if (requestClaim.count !== 1) throw new AppError("This cancellation request has already been decided", 409);
    const campaignClaim = await prisma.communityCampaign.updateMany({
      where: { id: request.campaignId, status: "CANCELLATION_UNDER_REVIEW" },
      data: { status: "CANCELLED", closedAt: new Date() },
    });
    if (campaignClaim.count !== 1) {
      logger.error("Cancellation request approved but campaign was not in CANCELLATION_UNDER_REVIEW — leaving campaign status untouched", { requestId, campaignId: request.campaignId });
    }

    const refundsCreated = await this.createRefundRecordsForFailedCampaign(request.campaignId);
    // Already guarded above (status !== "PAID" or this function already
    // threw), so any record here is safe to place on hold.
    if (supplierPayment) {
      await campaignContributionsService.holdSupplierPayment(adminId, request.campaignId, "Campaign cancelled — refunds issued").catch((error) => {
        logger.error("Failed to hold supplier payment for cancelled campaign", { campaignId: request.campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
      });
    }
    if (organiserPayout) {
      await organiserPayoutService.holdOrganiserPayout(adminId, request.campaignId, "Campaign cancelled — refunds issued").catch((error) => {
        logger.error("Failed to hold organiser payout for cancelled campaign", { campaignId: request.campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
      });
    }

    await recordAudit({
      actorId: adminId,
      action: "community_campaign.cancellation_approved",
      entityType: "CampaignCancellationRequest",
      entityId: requestId,
      metadata: { campaignId: request.campaignId, refundsCreated },
    });

    const organiserBody = `Your request to end "${request.campaign.title}" was approved. ${refundsCreated} participant(s) are being refunded.`;
    await notifyCampaign(request.campaign.organiser.userId, "cancellation_approved", "Cancellation approved", organiserBody, request.campaignId, `cancellation_approved:${request.campaignId}:${request.campaign.organiser.userId}`, "organiser");
    for (const p of request.campaign.participants) {
      await notifyCampaign(p.userId, "cancellation_approved", "Campaign ended — refund in progress", `"${request.campaign.title}" has been ended. Your payment is being refunded to your original payment method.`, request.campaignId, `cancellation_approved:${request.campaignId}:${p.userId}`);
    }

    return prisma.campaignCancellationRequest.findUniqueOrThrow({ where: { id: requestId } });
  },

  /** Rejection restores the exact status the campaign was in before the request — the snapshot preCancellationStatus captured at request time (spec requirement 7). */
  async rejectCancellation(adminId: string, requestId: string, notes?: string) {
    const request = await prisma.campaignCancellationRequest.findUnique({
      where: { id: requestId },
      include: { campaign: { include: { organiser: true } } },
    });
    if (!request) throw new AppError("Cancellation request not found", 404);
    if (request.status !== "PENDING") throw new AppError("This cancellation request has already been decided", 409);

    const requestClaim = await prisma.campaignCancellationRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "REJECTED", reviewedById: adminId, reviewedAt: new Date(), reviewNotes: notes },
    });
    if (requestClaim.count !== 1) throw new AppError("This cancellation request has already been decided", 409);
    await prisma.communityCampaign.updateMany({
      where: { id: request.campaignId, status: "CANCELLATION_UNDER_REVIEW" },
      data: { status: request.preCancellationStatus },
    });

    await notifyCampaign(
      request.campaign.organiser.userId,
      "cancellation_rejected",
      "Cancellation request rejected",
      `Eki did not approve your request to end "${request.campaign.title}". The campaign continues as before.${notes ? ` Reason: ${notes}` : ""}`,
      request.campaignId,
      `cancellation_rejected:${request.campaignId}:${request.campaign.organiser.userId}`,
      "organiser",
    );

    return prisma.campaignCancellationRequest.findUniqueOrThrow({ where: { id: requestId } });
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
    // Phase 2 (organiser controls) — a future scheduledOpenAt means publish()
    // only records the organiser's publish intent (publishedAt) but leaves
    // status APPROVED; openScheduledCampaigns() (the existing sweep, see
    // below) flips it to LIVE once that time passes. No scheduledOpenAt (or
    // one already in the past) is exactly today's behavior: immediate LIVE.
    const opensLater = campaign.scheduledOpenAt && campaign.scheduledOpenAt > new Date();
    return prisma.communityCampaign.update({
      where: { id: campaignId },
      data: opensLater ? { publishedAt: new Date() } : { status: "LIVE", publishedAt: new Date() },
    });
  },

  /**
   * Phase 2 (organiser controls) — promotes a scheduled-but-not-yet-open
   * campaign to LIVE once its scheduledOpenAt passes. Reuses the exact
   * atomic-claim pattern closeDueCampaigns()/evaluateRescueExpiry() already
   * use (status-scoped updateMany + count check) so an overlapping sweep
   * run can never double-fire this transition. Called from the existing
   * community-buy-sweep cron (internal.routes.ts) — no new job registered.
   */
  async openScheduledCampaigns(): Promise<{ opened: number }> {
    const due = await prisma.communityCampaign.findMany({
      where: { status: "APPROVED", publishedAt: { not: null }, scheduledOpenAt: { lte: new Date() } },
      include: { organiser: true },
    });
    let opened = 0;
    for (const campaign of due) {
      const claim = await prisma.communityCampaign.updateMany({
        where: { id: campaign.id, status: "APPROVED" },
        data: { status: "LIVE" },
      });
      if (claim.count !== 1) continue;
      opened++;
      await notifyCampaign(
        campaign.organiser.userId,
        "scheduled_open",
        "Your campaign is now live",
        `${campaign.title} has opened for pledges as scheduled.`,
        campaign.id,
        `scheduled_open:${campaign.id}`,
        "organiser",
      );
    }
    return { opened };
  },

  /**
   * Phase 2 (organiser controls) — organiser-authorized pause/resume.
   * Reuses admin pause()/resume()'s exact status transitions and gating
   * (LIVE<->PAUSED only); the only difference is ownership is checked via
   * requireOwnedByOrganiser() instead of admin permission, and participants
   * (not the organiser) are the notified audience, since the organiser is
   * the actor here.
   */
  async pauseByOrganiser(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "LIVE") throw new AppError("Only a live campaign can be paused", 409);
    const updated = await prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
    const participants = await prisma.campaignParticipant.findMany({ where: { campaignId } });
    for (const p of participants) {
      await notifyCampaign(
        p.userId,
        "organiser_paused",
        "Campaign paused",
        `${campaign.title} has been paused by its organiser. Pledging is temporarily unavailable.`,
        campaignId,
        `organiser_paused:${campaignId}:${p.userId}`,
      );
    }
    return updated;
  },

  async resumeByOrganiser(userId: string, campaignId: string) {
    const campaign = await this.requireOwnedByOrganiser(userId, campaignId);
    if (campaign.status !== "PAUSED") throw new AppError("Only a paused campaign can be resumed", 409);
    const updated = await prisma.communityCampaign.update({ where: { id: campaignId }, data: { status: "LIVE" } });
    const participants = await prisma.campaignParticipant.findMany({ where: { campaignId } });
    for (const p of participants) {
      await notifyCampaign(
        p.userId,
        "organiser_resumed",
        "Campaign resumed",
        `${campaign.title} has been resumed by its organiser. Pledging is available again.`,
        campaignId,
        `organiser_resumed:${campaignId}:${p.userId}`,
      );
    }
    return updated;
  },

  /**
   * Phase 2 (admin ops) — the admin unified campaign-operations view's one
   * shared issue/notes field. Deliberately independent of every existing
   * review/payment/supplier state field (approve/reject/pause/resume/
   * release/hold all stay exactly as they are) — this only ever touches
   * adminIssueNotes.
   */
  async setAdminIssueNotes(adminId: string, campaignId: string, notes: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new AppError("Campaign not found", 404);
    const updated = await prisma.communityCampaign.update({ where: { id: campaignId }, data: { adminIssueNotes: notes } });
    await recordAudit({
      actorId: adminId,
      action: "community_campaign.admin_issue_notes_updated",
      entityType: "CommunityCampaign",
      entityId: campaignId,
      afterState: { adminIssueNotes: updated.adminIssueNotes },
    });
    return updated;
  },

  // Community Buy Workstream 2 — participant discovery search (spec Phase
  // 4), extended per the Figma "Search yam, garri, location" reference: a
  // single combined field must match product/title text AND a real
  // location (the organiser's own collection city), not just title/
  // description — no invented category field (none exists on the model).
  // `country` stays a real, separate param for internal/business-rule
  // scoping (e.g. Buyer Home's own-country preview) — it is deliberately
  // no longer exposed as a user-facing browse-by-country control on the
  // Discover screen itself (client correction: country must not be a
  // clickable browse category).
  async listLive(country?: string, q?: string) {
    const search = q?.trim();
    const campaigns = await prisma.communityCampaign.findMany({
      where: {
        status: "LIVE",
        ...(country && { country }),
        ...(search && {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            { collectionCity: { contains: search, mode: "insensitive" } },
          ],
        }),
      },
      include: {
        supplier: { include: { vendor: { select: { storeName: true } } } },
        // Workstream 3: display name for a no-Vendor supplier — legacy
        // campaigns have no supplierAccountId, so this is always null there.
        supplierAccount: { include: { user: { select: { name: true } } } },
        organiser: { select: { firstNameOnlyDisplay: true, user: { select: { name: true } } } },
      },
      orderBy: { deadline: "asc" },
    });
    // Phase 2 (organiser identity display preference) — same rule as get():
    // organiser is dropped from each item entirely, not merely the raw name.
    return campaigns.map((c) => {
      const { organiser, ...rest } = c;
      return { ...rest, organiserDisplayName: resolveOrganiserDisplayName(organiser.user.name, organiser.firstNameOnlyDisplay) };
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
        organiser: { select: { firstNameOnlyDisplay: true, user: { select: { name: true } } } },
        contributions: { where: { status: "PAID" }, select: { amount: true, quantity: true } },
        _count: { select: { participants: true } },
      },
    });
    if (!campaign) throw new AppError("Campaign not found", 404);
    // Phase 2 (organiser identity display preference) — computed here,
    // server-side, so a raw last name is never sent to a buyer-facing
    // client at all when the preference is on, not merely hidden by the UI.
    const organiserDisplayName = resolveOrganiserDisplayName(campaign.organiser.user.name, campaign.organiser.firstNameOnlyDisplay);
    const paidTotal = campaign.contributions.reduce((sum, c) => sum + c.amount, 0);
    // confirmedShares is the authoritative, atomically-maintained count
    // (see campaign-contributions.service.ts) — this is only a display
    // cross-check, never used to decide success/failure.
    const goal = campaign.goalShares ?? 0;
    const progressPct = goal > 0 ? Math.min(100, Math.round((campaign.confirmedShares / goal) * 100)) : 0;

    // Diaspora escrow reconciliation (final V1 settlement doc §N item 6,
    // "required buyer disclosure") — PER-SHARE preview computed from the
    // market's CURRENT rate/bounds; a client multiplies by the quantity a
    // buyer is choosing to show the real total before payment. The amount
    // actually charged is always the rate snapshotted at pledge time (see
    // CampaignContribution.buyerServiceFeeAmount's own doc comment), which
    // can only differ from this preview if an admin changes the rate
    // between viewing and pledging. Null when there's no price yet (still
    // drafting) or no market configuration to compute against.
    let perShareFeeEstimate: { productSubtotal: number; feeAmount: number; maxTotal: number; feeBps: number } | null = null;
    if (campaign.pricePerShareMinor && campaign.country) {
      const config = await marketConfigurationService.get(campaign.country);
      if (config) {
        const productSubtotal = campaign.pricePerShareMinor;
        const feeAmount = calculateBoundedServiceFee(productSubtotal, config.buyerServiceFeeBps, config.buyerServiceFeeMinAmount, config.buyerServiceFeeMaxAmount);
        perShareFeeEstimate = { productSubtotal, feeAmount, maxTotal: productSubtotal + feeAmount, feeBps: config.buyerServiceFeeBps };
      }
    }

    // Phase 2 (organiser identity display preference) — organiser is
    // dropped from the response entirely (not merely the raw name): this
    // endpoint is public/buyer-facing, and organiserDisplayName is the only
    // organiser-identity field any caller should read from it.
    const { organiser: _organiser, ...campaignWithoutRawOrganiser } = campaign;
    return { ...campaignWithoutRawOrganiser, paidTotal, progressPct, participantCount: campaign._count.participants, perShareFeeEstimate, organiserDisplayName };
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
      // M2 — an AUTHORISE_THEN_CAPTURE campaign's deadline is only the
      // commitment lock (spec §7 step 4); success/failure is decided later,
      // at decisionDeadline, by evaluateAuthorisationDecisions() in
      // campaign-authorisation.service.ts. This function's confirmedShares-
      // based success/RESCUE_WINDOW logic below is PLEDGE_THEN_CHARGE-only
      // and must never run for a new-mode campaign.
      if (campaign.paymentMode === "AUTHORISE_THEN_CAPTURE") {
        const claim = await prisma.communityCampaign.updateMany({
          where: { id: campaign.id, status: "LIVE" },
          data: { status: "HOLD_WINDOW" },
        });
        if (claim.count !== 1) continue;
        continue;
      }

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

  /** One supplier order per campaign, using the actual final confirmedShares — never the goal — doc §11. Self-fulfilled campaigns have no supplier order/payment/fulfilment record — the organiser handles fulfilment themselves outside this tracked workflow — but every successful campaign (self or supplier-fulfilled alike) gets an organiser payout record; see createOrganiserPayout() below. */
  async createSupplierOrder(campaign: {
    id: string;
    organiserId: string;
    supplierId: string | null;
    supplierAccountId?: string | null;
    title: string;
    currency: string | null;
    confirmedShares: number;
    pricePerShareMinor: number | null;
    wholesaleAmountMinor?: number | null;
  }): Promise<void> {
    if (!campaign.pricePerShareMinor) return;
    if (!campaign.currency) return;

    const amount = campaign.confirmedShares * campaign.pricePerShareMinor;

    // Diaspora escrow reconciliation (final V1 settlement doc §N) — created
    // for EVERY successful campaign, before the supplier-only branch below,
    // since self-fulfilled campaigns never reach it. upsert()'s no-op update
    // makes this safe to call again on a defensive retry, same as the
    // campaignFulfilment.upsert() calls further down.
    await this.createOrganiserPayout(campaign.id, campaign.organiserId, amount, campaign.currency);

    if (!campaign.supplierId && !campaign.supplierAccountId) return;
    const existing = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId: campaign.id } });
    if (existing) return; // idempotent — never create a second supplier order/payment record.

    // Diaspora escrow reconciliation — snapshotted once, same immutable-
    // snapshot principle as `amount` above. Null preserves the original
    // 100%-to-supplier behavior exactly (see CampaignSupplierPayment.
    // wholesaleAmount's own doc comment).
    const wholesaleAmount = campaign.wholesaleAmountMinor ?? null;

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
          wholesaleAmount,
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
        wholesaleAmount,
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

  /** Diaspora escrow reconciliation — the organiser payout counterpart to createSupplierOrder() above, created for every successful campaign regardless of fulfilmentOwner. Idempotent (upsert with a no-op update). */
  async createOrganiserPayout(campaignId: string, organiserId: string, amount: number, currency: string): Promise<void> {
    const organiser = await prisma.organiserProfile.findUnique({ where: { id: organiserId } });
    if (!organiser) return;
    await prisma.communityBuyOrganiserPayout.upsert({
      where: { campaignId },
      update: {},
      create: {
        campaignId,
        organiserId: organiser.id,
        amount,
        currency,
        status: "NOT_RELEASED",
        payoutStripeAccountIdAtApproval: organiser.providerConnectedAccountId ?? null,
      },
    });
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
        // Atomic claim — same guard as closeDueCampaigns(): prevents two
        // overlapping sweep runs (e.g. a manual /jobs/community-buy-sweep
        // trigger racing the daily cron) from both deciding this campaign's
        // rescue outcome and double-firing the supplier order + charge pass.
        const claim = await prisma.communityCampaign.updateMany({
          where: { id: campaign.id, status: "RESCUE_WINDOW" },
          data: { status: "FULFILLING", fundingOutcome: outcome },
        });
        if (claim.count !== 1) continue;
        rescued++;
        await this.notifyOutcome(campaign.id, "succeeded");
        await this.createSupplierOrder(campaign);
        await this.chargePledgesAfterSuccess(campaign.id);
      } else {
        const claim = await prisma.communityCampaign.updateMany({
          where: { id: campaign.id, status: "RESCUE_WINDOW" },
          data: { status: "FAILED", fundingOutcome: "BELOW_MINIMUM", closedAt: new Date() },
        });
        if (claim.count !== 1) continue;
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
            // Diaspora escrow reconciliation — refund the FULL amount
            // actually charged (product + buyer service fee + Phase 6
            // delivery fee), matching attemptCharge()'s real Stripe amount,
            // so a post-capture cancellation (AT-25) never leaves any
            // portion uncredited.
            amount: contribution.amount + contribution.buyerServiceFeeAmount + contribution.deliveryFeeAmountMinor,
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
