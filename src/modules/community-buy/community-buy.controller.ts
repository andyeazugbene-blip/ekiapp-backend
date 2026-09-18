import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { organiserSupplierService } from "./organiser-supplier.service";
import { supplierAccountService } from "./supplier-account.service";
import { supplierStripeConnectService } from "./supplier-stripe-connect.service";
import { communityCampaignsService } from "./community-campaigns.service";
import { campaignContributionsService } from "./campaign-contributions.service";
import { campaignFulfilmentService } from "./campaign-fulfilment.service";
import { marketConfigurationService } from "./market-configuration.service";
import { supportCaseService } from "./support-case.service";
import { supplierInvitationService } from "./supplier-invitation.service";
import { adminApprovalsService } from "../admin/admin-approvals.service";
import { campaignAuthorisationService } from "./campaign-authorisation.service";
import { campaignPayoutService } from "./campaign-payout.service";
import { organiserFeeService } from "./organiser-fee.service";
import { organiserPayoutService } from "./organiser-payout.service";
import { organiserStripeConnectService } from "./organiser-stripe-connect.service";
import { attributionReviewService } from "./campaign-participant-attribution.service";
import { communityBuyManifestService } from "./community-buy-manifest.service";
import { searchDataAccessLog, revokeDeliveryReferencesForSupplierAccount, isIndividualDeliveryEnabled, FULFILMENT_ACCESS_PRESERVED_SCOPE } from "./community-buy-privacy.service";

// ─── Public market availability (used by the mobile app to decide whether
// to show Regular Deliveries / Community Buy entry points at all — the
// backend is always the source of truth, never a hardcoded country list) ──

export async function listPublicMarketConfigs(_request: Request, response: Response): Promise<void> {
  response.json({ items: await marketConfigurationService.listPublic() });
}

export async function getPublicMarketConfig(request: Request, response: Response): Promise<void> {
  const country = request.params.country;
  if (typeof country !== "string" || !country) throw new AppError("country is required", 400);
  const config = await marketConfigurationService.getPublic(country.toUpperCase());
  response.json({
    config: config ?? {
      countryCode: country.toUpperCase(),
      communityBuyEnabled: false,
      organiserApplicationsEnabled: false,
      supplierApplicationsEnabled: false,
      regularDeliveriesEnabled: false,
      individualDeliveryEnabled: isIndividualDeliveryEnabled(),
    },
  });
}

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

async function requireVendorId(userId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  if (!vendor) throw new AppError("Vendor profile required", 403);
  return vendor.id;
}

type ActingSupplier = { kind: "vendor"; vendorId: string } | { kind: "account"; userId: string };

/**
 * Workstream 3 — every supplier-facing route below used to force
 * requireVendorId(), which throws for the no-Vendor SupplierAccount path
 * (item 6/9/K: no Vendor should ever be required to act as a supplier).
 * Vendor is checked first — safe even for a Vendor whose SupplierAccount is
 * also synced (legacySupplierProfileId), since resolveSupplierChoice()
 * dual-writes supplierId for any legacy-linked account, so the untouched
 * vendorId-keyed service methods keep matching exactly as before.
 */
async function resolveActingSupplier(userId: string): Promise<ActingSupplier> {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  if (vendor) return { kind: "vendor", vendorId: vendor.id };
  const account = await prisma.supplierAccount.findUnique({ where: { userId }, select: { id: true } });
  if (account) return { kind: "account", userId };
  throw new AppError("Vendor profile or Supplier account required", 403);
}

// ─── Discovery (public) ────────────────────────────────────────────────

export async function listCampaigns(request: Request, response: Response): Promise<void> {
  const country = typeof request.query.country === "string" ? request.query.country : undefined;
  const q = typeof request.query.q === "string" ? request.query.q : undefined;
  response.json({ items: await communityCampaignsService.listLive(country, q) });
}

export async function getCampaign(request: Request, response: Response): Promise<void> {
  response.json({ campaign: await communityCampaignsService.get(requireIdParam(request)) });
}

// Public/participant fulfilment read — null (not 404) when no plan exists
// yet, since that's the normal state for any campaign that hasn't
// succeeded. Lets a buyer see the real, confirmed fulfilment method before
// or after pledging, without inventing one.
export async function getParticipantFulfilment(request: Request, response: Response): Promise<void> {
  response.json({ fulfilment: await campaignFulfilmentService.getForParticipant(requireIdParam(request)) });
}

/** M5 — participant-authorized only (requires an owned PAID contribution); a supplier can never forge this. */
export async function confirmFulfilmentReceipt(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json(await campaignFulfilmentService.confirmReceiptForParticipant(userId, requireIdParam(request)));
}

/** M5 — reuses the existing CommunityBuySupportCase ticket workflow (FULFILMENT_ISSUE), not a new one. */
export async function reportFulfilmentProblem(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const description = request.body?.description;
  if (typeof description !== "string" || !description.trim()) throw new AppError("description is required", 400);
  const evidenceUrls = Array.isArray(request.body?.evidenceUrls) ? request.body.evidenceUrls : undefined;
  const supportCase = await campaignFulfilmentService.reportFulfilmentProblem(userId, requireIdParam(request), description, evidenceUrls);
  response.status(201).json({ supportCase });
}

// ─── Participant ────────────────────────────────────────────────────────

export async function joinCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const participant = await campaignContributionsService.join(userId, requireIdParam(request));
  response.status(201).json({ participant });
}

function requirePaymentMethodIdBody(request: Request): string {
  const paymentMethodId = request.body?.paymentMethodId;
  if (typeof paymentMethodId !== "string" || !paymentMethodId) {
    throw new AppError("paymentMethodId is required — save a card via /buyer/payment-methods first", 400);
  }
  return paymentMethodId;
}

/**
 * Pledges a quantity against an already-saved payment method. No money
 * moves here — see campaign-contributions.service.ts's pledge() and its
 * file-header comment for the full PLEDGE_THEN_CHARGE flow.
 */
// Phase 3 (address + privacy foundation) — optional; the service ignores it
// entirely for a COLLECTION campaign and requires it for a DELIVERY one.
// No format validation here beyond "must be a string" — assertDeliveryAddressWithinCoverage()
// in campaign-contributions.service.ts is the single source of truth for
// presence/coverage rules.
function readDeliveryAddressBody(request: Request): { recipientName?: string; addressLine1?: string; addressLine2?: string; city?: string; postcode?: string } | undefined {
  const raw = request.body?.deliveryAddress;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AppError("deliveryAddress must be an object", 400);
  const pick = (key: string): string | undefined => (typeof raw[key] === "string" ? raw[key] : undefined);
  return {
    recipientName: pick("recipientName"),
    addressLine1: pick("addressLine1"),
    addressLine2: pick("addressLine2"),
    city: pick("city"),
    postcode: pick("postcode"),
  };
}

export async function pledgeContribution(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const quantity = Number(request.body?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError("A positive integer quantity is required", 400);
  const paymentMethodId = requirePaymentMethodIdBody(request);
  const deliveryAddress = readDeliveryAddressBody(request);
  const result = await campaignContributionsService.pledge(userId, requireIdParam(request), quantity, paymentMethodId, deliveryAddress);
  response.status(201).json(result);
}

export async function createOrganiserTopUp(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const quantity = Number(request.body?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError("A positive integer quantity is required", 400);
  const paymentMethodId = requirePaymentMethodIdBody(request);
  const result = await campaignContributionsService.pledgeOrganiserTopUp(userId, requireIdParam(request), quantity, paymentMethodId);
  response.status(201).json(result);
}

export async function getContribution(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ contribution: await campaignContributionsService.getMyContribution(userId, requireIdParam(request)) });
}

/** Participant retries a charge that failed (but hasn't exhausted its attempts) — e.g. after updating their card. */
export async function retryContributionCharge(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ contribution: await campaignContributionsService.retryCharge(userId, requireIdParam(request)) });
}

// ─── M2 — AUTHORISE_THEN_CAPTURE participant flow (spec §16) ────────────
// Deliberately separate endpoints from pledgeContribution/retryContributionCharge
// above — see campaign-authorisation.service.ts's commit() doc comment for
// why (that function's paymentMethodId requirement has no equivalent here).

/** spec §16 "POST /community-buys/:id/commit". */
export async function commitToCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const quantity = Number(request.body?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError("A positive integer quantity is required", 400);
  const result = await campaignAuthorisationService.commit(userId, requireIdParam(request), quantity);
  response.status(201).json(result);
}

/** Participant confirms the connected-account SetupIntent client-side, then calls this to attach the resulting PaymentMethod. */
export async function confirmContributionSetup(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const authorisation = await campaignAuthorisationService.confirmSetup(userId, requireIdParam(request));
  response.json({ authorisation });
}

/** spec §16 "POST /community-buys/:id/withdraw" — only before a hold exists. */
export async function withdrawContribution(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const contribution = await campaignAuthorisationService.withdraw(userId, requireIdParam(request));
  response.json({ contribution });
}

/** Participant retries a declined hold — e.g. after updating their card. */
export async function retryContributionHold(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const authorisation = await campaignAuthorisationService.retryHold(userId, requireIdParam(request));
  response.json({ authorisation });
}

/** Role-aware quantities (spec §12/§16 dashboard) for an AUTHORISE_THEN_CAPTURE campaign — participant/organiser/supplier/admin all read the same real counts. */
export async function getCampaignAuthorisationSummary(request: Request, response: Response): Promise<void> {
  response.json(await campaignAuthorisationService.getAuthorisationSummary(requireIdParam(request)));
}

/** spec §16 "POST /community-buys/:id/decision" — organiser proceed/cancel below minimum. */
export async function decideCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const action = request.body?.action;
  if (action !== "proceed" && action !== "cancel") throw new AppError("action must be \"proceed\" or \"cancel\"", 400);
  const campaign = await campaignAuthorisationService.decide(userId, requireIdParam(request), action);
  response.json({ campaign });
}

/** spec §16 "POST /community-buys/:id/reconfirm" — supplier confirms/declines a reduced quantity below the original minimum. Same dual-path (Vendor vs SupplierAccount) dispatch as confirmSupplierCommitment above. */
export async function reconfirmCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const acting = await resolveActingSupplier(userId);
  const action = request.body?.action;
  if (action !== "confirm" && action !== "decline") throw new AppError("action must be \"confirm\" or \"decline\"", 400);
  const reason = typeof request.body?.reason === "string" ? request.body.reason : undefined;
  const campaign = acting.kind === "vendor"
    ? await campaignAuthorisationService.reconfirmForVendor(userId, acting.vendorId, requireIdParam(request), action, reason)
    : await campaignAuthorisationService.reconfirmForAccount(acting.userId, requireIdParam(request), action, reason);
  response.json({ campaign });
}

export async function listMyContributions(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await campaignContributionsService.listMyContributions(userId) });
}

export async function getCampaignUpdates(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await communityCampaignsService.listMyCampaignUpdates(userId, requireIdParam(request)) });
}

/** POST /campaigns/:id/updates — organiser or supplier posts a real broadcast update. */
export async function postCampaignUpdate(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const { title, message } = request.body ?? {};
  if (typeof title !== "string" || typeof message !== "string") {
    throw new AppError("title and message are required", 400);
  }
  const update = await communityCampaignsService.postCampaignUpdate(userId, requireIdParam(request), { title, message });
  response.status(201).json({ update });
}

// ─── Organiser ──────────────────────────────────────────────────────────

export async function applyAsOrganiser(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const country = request.body?.country;
  if (typeof country !== "string") throw new AppError("country is required", 400);
  response.status(201).json({ profile: await organiserSupplierService.applyAsOrganiser(userId, country) });
}

export async function getMyOrganiserProfile(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ profile: await organiserSupplierService.getOrganiserProfile(userId) });
}

export async function updateMyOrganiserProfile(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const body = request.body ?? {};
  if (body.firstNameOnlyDisplay !== undefined && typeof body.firstNameOnlyDisplay !== "boolean") {
    throw new AppError("firstNameOnlyDisplay must be a boolean", 400);
  }
  response.json({ profile: await organiserSupplierService.updateOrganiserProfile(userId, { firstNameOnlyDisplay: body.firstNameOnlyDisplay }) });
}

export async function listVerifiedSuppliers(request: Request, response: Response): Promise<void> {
  const country = request.query.country;
  if (typeof country !== "string" || !country) throw new AppError("country is required", 400);
  response.json({ items: await organiserSupplierService.listVerifiedSuppliers(country) });
}

export async function listMyOrganiserCampaigns(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await communityCampaignsService.listForOrganiser(userId) });
}

export async function createOrganiserCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const campaign = await communityCampaignsService.create(userId, request.body);
  response.status(201).json({ campaign });
}

export async function updateOrganiserCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const campaign = await communityCampaignsService.update(userId, requireIdParam(request), request.body);
  response.json({ campaign });
}

export async function listCampaignParticipants(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await communityCampaignsService.listParticipantsForOrganiser(userId, requireIdParam(request)) });
}

export async function getCampaignRefundProgress(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json(await communityCampaignsService.getRefundProgressForOrganiser(userId, requireIdParam(request)));
}

export async function submitOrganiserCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.submit(userId, requireIdParam(request)) });
}

export async function publishOrganiserCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.publish(userId, requireIdParam(request)) });
}

export async function pauseOrganiserCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.pauseByOrganiser(userId, requireIdParam(request)) });
}

export async function resumeOrganiserCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.resumeByOrganiser(userId, requireIdParam(request)) });
}

// Phase 2 (organiser controls) — a general campaign change request, filed
// through the existing CommunityBuySupportCase model/admin-review flow
// (caseType forced to CAMPAIGN_CHANGE_REQUEST here, never client-supplied,
// so an organiser can't file any of the other case types through this
// route). Deliberately separate from requestCampaignExtension() (rescue-
// window extensions, unchanged) and from any supplier negotiation.
export async function requestCampaignChange(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const description = request.body?.description;
  if (typeof description !== "string" || !description.trim()) throw new AppError("description is required", 400);
  const supportCase = await supportCaseService.create(userId, requireIdParam(request), {
    caseType: "CAMPAIGN_CHANGE_REQUEST",
    description,
  });
  response.status(201).json({ supportCase });
}

export async function endCampaignRescue(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.endRescueAndRefund(userId, requireIdParam(request)) });
}

// Phase 4 (cancellation under review) — organiser-initiated. The service
// itself decides whether this resolves immediately (no funds captured
// yet) or routes to admin review (real money already captured) — the
// controller only validates input shape.
export async function requestCampaignCancellation(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const result = await communityCampaignsService.requestCancellation(userId, requireIdParam(request), reason);
  await recordAudit({
    actorId: userId,
    action: "community_campaign.cancellation_requested",
    entityType: "CommunityCampaign",
    entityId: requireIdParam(request),
    reason,
    afterState: { status: result.campaign.status, requiresReview: result.requiresReview },
    request,
  });
  response.status(result.requiresReview ? 202 : 200).json(result);
}

export async function requestCampaignExtension(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const body = request.body ?? {};
  if (typeof body.requestedDeadline !== "string" || typeof body.reason !== "string" || !body.reason.trim()) {
    throw new AppError("requestedDeadline and reason are required", 400);
  }
  const request_ = await communityCampaignsService.requestExtension(userId, requireIdParam(request), {
    requestedDeadline: body.requestedDeadline,
    reason: body.reason,
    supplierReconfirmed: Boolean(body.supplierReconfirmed),
    priceUnchangedConfirmed: Boolean(body.priceUnchangedConfirmed),
    participantTermsUnchanged: Boolean(body.participantTermsUnchanged),
  });
  response.status(201).json({ extensionRequest: request_ });
}

export async function confirmSupplierCommitment(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const campaign = acting.kind === "vendor"
    ? await communityCampaignsService.confirmSupplierCommitment(acting.vendorId, requireIdParam(request))
    : await communityCampaignsService.confirmSupplierCommitmentForAccount(acting.userId, requireIdParam(request));
  response.json({ campaign });
}

export async function declineSupplierCommitment(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const acting = await resolveActingSupplier(userId);
  const { reason } = request.body ?? {};
  const reasonText = typeof reason === "string" ? reason : undefined;
  const campaign = acting.kind === "vendor"
    ? await communityCampaignsService.declineSupplierCommitment(userId, acting.vendorId, requireIdParam(request), reasonText)
    : await communityCampaignsService.declineSupplierCommitmentForAccount(acting.userId, requireIdParam(request), reasonText);
  response.json({ campaign });
}

export async function reassignCampaignSupplier(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const { supplierId, supplierAccountId } = request.body ?? {};
  if ((typeof supplierId !== "string" || !supplierId) && (typeof supplierAccountId !== "string" || !supplierAccountId)) {
    throw new AppError("supplierId or supplierAccountId is required", 400);
  }
  const campaign = await communityCampaignsService.reassignSupplier(
    userId,
    requireIdParam(request),
    typeof supplierId === "string" ? supplierId : undefined,
    typeof supplierAccountId === "string" ? supplierAccountId : undefined,
  );
  response.json({ campaign });
}

// ─── Supplier invitations — mandate item 7, the third supply route ─────
// (invite someone with no existing Eki account). Create/list/revoke are
// organiser-only; view/accept/decline are public-by-token, matching the
// plan's "no login required to view" — a brand-new invitee has no account
// yet to log in with.

export async function createSupplierInvitation(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const { email } = request.body ?? {};
  if (typeof email !== "string" || !email) throw new AppError("email is required", 400);
  const invitation = await supplierInvitationService.create(userId, requireIdParam(request), email);
  response.status(201).json({ invitation });
}

export async function listSupplierInvitations(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await supplierInvitationService.listForCampaign(userId, requireIdParam(request)) });
}

function requireTokenParam(request: Request): string {
  const token = request.params.token;
  if (typeof token !== "string" || token.length === 0) throw new AppError("Invalid invitation token", 400);
  return token;
}

export async function revokeSupplierInvitation(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const invitation = await supplierInvitationService.revoke(userId, requireIdParam(request));
  response.json({ invitation });
}

export async function getSupplierInvitation(request: Request, response: Response): Promise<void> {
  const invitation = await supplierInvitationService.getByToken(requireTokenParam(request));
  response.json({ invitation });
}

export async function acceptSupplierInvitation(request: Request, response: Response): Promise<void> {
  const { name, password } = request.body ?? {};
  const newUser = typeof name === "string" && typeof password === "string" ? { name, password } : undefined;
  const result = await supplierInvitationService.accept(requireTokenParam(request), newUser);
  response.json(result);
}

export async function declineSupplierInvitation(request: Request, response: Response): Promise<void> {
  const { reason } = request.body ?? {};
  const invitation = await supplierInvitationService.decline(requireTokenParam(request), typeof reason === "string" ? reason : undefined);
  response.json({ invitation });
}

// ─── Supplier fulfilment — doc Phase 8 ─────────────────────────────────

export async function getSupplierFulfilment(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const fulfilment = acting.kind === "vendor"
    ? await campaignFulfilmentService.getForSupplier(acting.vendorId, requireIdParam(request))
    : await campaignFulfilmentService.getForSupplierAccount(acting.userId, requireIdParam(request));
  response.json({ fulfilment });
}

export async function getMySupplierPayment(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const payment = acting.kind === "vendor"
    ? await campaignContributionsService.getMyPaymentForCampaign(acting.vendorId, requireIdParam(request))
    : await campaignContributionsService.getMyPaymentForCampaignAsAccount(acting.userId, requireIdParam(request));
  response.json({ payment });
}

// ─── M4 — supplier data-access: manifest, in-app contact, emergency read
// (spec §14.3, AT-39/40/41/44). Same dual-path dispatch as every other
// supplier-facing function above.

function requireContributionIdParam(request: Request): string {
  const contributionId = request.params.contributionId;
  if (typeof contributionId !== "string" || contributionId.length === 0) throw new AppError("Invalid contributionId", 400);
  return contributionId;
}

export async function getSupplierManifest(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const acting = await resolveActingSupplier(userId);
  const campaignId = requireIdParam(request);
  const manifest = acting.kind === "vendor"
    ? await communityBuyManifestService.getManifestForVendor(acting.vendorId, campaignId, userId)
    : await communityBuyManifestService.getManifestForAccount(acting.userId, campaignId);
  response.json({ manifest });
}

export async function sendSupplierContactMessage(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const acting = await resolveActingSupplier(userId);
  const campaignId = requireIdParam(request);
  const contributionId = requireContributionIdParam(request);
  const channel = typeof request.body?.channel === "string" ? request.body.channel : "IN_APP_MESSAGE";
  const message = typeof request.body?.message === "string" ? request.body.message : undefined;
  const result = acting.kind === "vendor"
    ? await communityBuyManifestService.sendContactMessageForVendor(acting.vendorId, campaignId, userId, contributionId, channel, message)
    : await communityBuyManifestService.sendContactMessageForAccount(acting.userId, campaignId, contributionId, channel, message);
  response.json(result);
}

export async function getSupplierEmergencyContact(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const acting = await resolveActingSupplier(userId);
  const campaignId = requireIdParam(request);
  const contributionId = requireContributionIdParam(request);
  const contact = acting.kind === "vendor"
    ? await communityBuyManifestService.getEmergencyContactForVendor(acting.vendorId, campaignId, userId, contributionId)
    : await communityBuyManifestService.getEmergencyContactForAccount(acting.userId, campaignId, contributionId);
  response.json(contact);
}

/** M2 — the AUTHORISE_THEN_CAPTURE-mode twin of getMySupplierPayment() above, reading CommunityBuyPayout instead of CampaignSupplierPayment. */
export async function getMyCampaignPayout(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const campaignId = requireIdParam(request);
  const payout = acting.kind === "vendor"
    ? await (async () => {
        const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId: acting.vendorId }, select: { id: true } });
        if (!supplier) throw new AppError("Campaign not found", 404);
        return campaignPayoutService.getMyPayout({ supplierId: supplier.id }, campaignId);
      })()
    : await (async () => {
        const account = await prisma.supplierAccount.findUnique({ where: { userId: acting.userId }, select: { id: true } });
        if (!account) throw new AppError("Campaign not found", 404);
        return campaignPayoutService.getMyPayout({ supplierAccountId: account.id }, campaignId);
      })();
  response.json({ payout });
}

export async function confirmFulfilmentInventory(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const fulfilment = acting.kind === "vendor"
    ? await campaignFulfilmentService.confirmInventory(acting.vendorId, requireIdParam(request))
    : await campaignFulfilmentService.confirmInventoryForAccount(acting.userId, requireIdParam(request));
  response.json({ fulfilment });
}

export async function setFulfilmentPlan(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const method = request.body?.method;
  if (method !== "DELIVERY" && method !== "COLLECTION") throw new AppError("method must be DELIVERY or COLLECTION", 400);
  const input = {
    method: method as "DELIVERY" | "COLLECTION",
    estimatedReadyAt: typeof request.body?.estimatedReadyAt === "string" ? request.body.estimatedReadyAt : undefined,
    notes: typeof request.body?.notes === "string" ? request.body.notes : undefined,
  };
  const fulfilment = acting.kind === "vendor"
    ? await campaignFulfilmentService.setPlan(acting.vendorId, requireIdParam(request), input)
    : await campaignFulfilmentService.setPlanForAccount(acting.userId, requireIdParam(request), input);
  response.json({ fulfilment });
}

export async function startFulfilmentPacking(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const fulfilment = acting.kind === "vendor"
    ? await campaignFulfilmentService.startPacking(acting.vendorId, requireIdParam(request))
    : await campaignFulfilmentService.startPackingForAccount(acting.userId, requireIdParam(request));
  response.json({ fulfilment });
}

export async function markFulfilmentReady(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const fulfilment = acting.kind === "vendor"
    ? await campaignFulfilmentService.markReady(acting.vendorId, requireIdParam(request))
    : await campaignFulfilmentService.markReadyForAccount(acting.userId, requireIdParam(request));
  response.json({ fulfilment });
}

export async function markFulfilmentDispatched(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const fulfilment = acting.kind === "vendor"
    ? await campaignFulfilmentService.markDispatched(acting.vendorId, requireIdParam(request))
    : await campaignFulfilmentService.markDispatchedForAccount(acting.userId, requireIdParam(request));
  response.json({ fulfilment });
}

export async function markFulfilmentCollected(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const fulfilment = acting.kind === "vendor"
    ? await campaignFulfilmentService.markCollected(acting.vendorId, requireIdParam(request))
    : await campaignFulfilmentService.markCollectedForAccount(acting.userId, requireIdParam(request));
  response.json({ fulfilment });
}

export async function getOrganiserFulfilment(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ fulfilment: await campaignFulfilmentService.getForOrganiser(userId, requireIdParam(request)) });
}

export async function organiserConfirmFulfilmentCompletion(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ fulfilment: await campaignFulfilmentService.organiserConfirmCompletion(userId, requireIdParam(request)) });
}

/** M5 — supplier-facing exception report; an informational overlay, never a fulfilment-status change. */
export async function reportFulfilmentException(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const note = request.body?.note;
  if (typeof note !== "string" || !note.trim()) throw new AppError("note is required", 400);
  const result = acting.kind === "vendor"
    ? await campaignFulfilmentService.reportExceptionForVendor(acting.vendorId, requireIdParam(request), note)
    : await campaignFulfilmentService.reportExceptionForAccount(acting.userId, requireIdParam(request), note);
  response.status(201).json(result);
}

/** M5 — the append-only evidence timeline; organiser/supplier (own campaign) or admin only. */
export async function getFulfilmentEvents(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const campaignId = requireIdParam(request);
  let events;
  const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
  if (organiser) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, select: { organiserId: true } });
    if (campaign?.organiserId === organiser.id) {
      events = await campaignFulfilmentService.getFulfilmentEventsForOrganiser(userId, campaignId);
    }
  }
  if (!events) {
    const acting = await resolveActingSupplier(userId);
    events = acting.kind === "vendor"
      ? await campaignFulfilmentService.getFulfilmentEventsForVendor(acting.vendorId, campaignId)
      : await campaignFulfilmentService.getFulfilmentEventsForAccount(acting.userId, campaignId);
  }
  response.json({ events });
}

export async function adminGetFulfilmentEvents(request: Request, response: Response): Promise<void> {
  response.json({ events: await campaignFulfilmentService.getFulfilmentEventsForAdmin(requireIdParam(request)) });
}

// ─── Support cases — doc Phase 9 ───────────────────────────────────────

const VALID_CASE_TYPES = ["PAYMENT_ISSUE", "REFUND_ISSUE", "FULFILMENT_ISSUE", "ORGANISER_CONDUCT", "SUPPLIER_CONDUCT", "OTHER"];
const VALID_CASE_STATUSES = ["OPEN", "IN_PROGRESS", "ESCALATED", "RESOLVED", "CLOSED"];

export async function createSupportCase(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const caseType = request.body?.caseType;
  if (!VALID_CASE_TYPES.includes(caseType)) throw new AppError("Unknown case type", 400);
  const evidenceUrls = Array.isArray(request.body?.evidenceUrls) ? request.body.evidenceUrls.filter((u: unknown) => typeof u === "string") : undefined;
  const supportCase = await supportCaseService.create(userId, requireIdParam(request), {
    caseType,
    description: request.body?.description,
    evidenceUrls,
  });
  response.status(201).json({ supportCase });
}

export async function listMySupportCases(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await supportCaseService.listMine(userId) });
}

export async function getMySupportCase(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ supportCase: await supportCaseService.getMine(userId, requireIdParam(request)) });
}

export async function adminListSupportCases(request: Request, response: Response): Promise<void> {
  const status = typeof request.query.status === "string" && VALID_CASE_STATUSES.includes(request.query.status) ? request.query.status as any : undefined;
  response.json({ items: await supportCaseService.listForAdmin(status) });
}

export async function adminGetSupportCase(request: Request, response: Response): Promise<void> {
  response.json({ supportCase: await supportCaseService.getForAdmin(requireIdParam(request)) });
}

export async function adminUpdateSupportCase(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const body = request.body ?? {};
  if (body.status !== undefined && !VALID_CASE_STATUSES.includes(body.status)) throw new AppError("Unknown status", 400);
  if (body.escalated !== undefined && typeof body.escalated !== "boolean") throw new AppError("escalated must be a boolean", 400);
  const id = requireIdParam(request);
  const supportCase = await supportCaseService.adminUpdate(adminId, id, {
    status: body.status,
    internalNotes: typeof body.internalNotes === "string" ? body.internalNotes : undefined,
    customerVisibleResponse: typeof body.customerVisibleResponse === "string" ? body.customerVisibleResponse : undefined,
    escalated: body.escalated,
  });
  await recordAudit({
    actorId: adminId,
    action: "community_support_case.update",
    entityType: "CommunityBuySupportCase",
    entityId: id,
    metadata: { status: body.status, escalated: body.escalated, hasInternalNotes: body.internalNotes !== undefined, hasCustomerResponse: body.customerVisibleResponse !== undefined },
  });
  response.json({ supportCase });
}

// ─── TEMPORARY compatibility shim ──────────────────────────────────────────
// The mobile app already live in production calls these two routes from its
// organiser decision screen. The flexible-fulfilment rewrite replaced that
// screen's entire model (RESCUE_WINDOW / top-up / extension / end-and-refund
// — see community-campaigns.service.ts), so the old endpoints no longer map
// to any real action. This shim exists ONLY so the currently-deployed app
// gets a controlled response instead of Express's plain 404, while the new
// mobile UI is being built. It never charges, refunds, or fulfils anything
// itself — "fulfil anyway below minimum" does not exist as a real action
// anywhere in this codebase, on purpose.
//
// Remove this shim once: (1) the new mobile UI is deployed, (2) a production
// smoke test confirms the new /rescue/* routes are reachable, and (3) usage
// of these two legacy paths has actually dropped to zero in production logs.

export async function legacyFulfilCampaignAnywayShim(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.status(409).json({
    message: "This action is no longer available. Update the app to see the current campaign status and available actions.",
    code: "ENDPOINT_REPLACED",
    details: null,
  });
}

export async function legacyCancelFailedCampaignShim(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const campaignId = requireIdParam(request);
  const campaign = await communityCampaignsService.requireOwnedByOrganiser(userId, campaignId);

  // The only state where "cancel" has an unambiguous, already-true answer:
  // a campaign that finished below minimum already has its refunds created
  // automatically (see evaluateRescueExpiry / endRescueAndRefund) — telling
  // the old app that is accurate, not a new financial action taken here.
  if (campaign.status === "FAILED" || campaign.status === "CANCELLED") {
    response.json({ campaign });
    return;
  }

  response.status(409).json({
    message: "This action is no longer available. Update the app to see the current campaign status and available actions.",
    code: "ENDPOINT_REPLACED",
    details: null,
  });
}

// ─── Supplier ───────────────────────────────────────────────────────────

// Community Buy Workstream 1: Supplier Centre no longer requires a Vendor
// to even start onboarding — applyAsSupplier/getMySupplierProfile now
// operate on the user-keyed SupplierAccount. The legacy Vendor-keyed
// organiserSupplierService.applyAsSupplier(vendorId, country) function is
// untouched and still used internally by syncSupplierAccountForProfile's
// callers (verify/restrict/unrestrict) for existing Vendor-backed
// suppliers — it's just no longer reachable from this public route.
export async function applyAsSupplier(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const country = request.body?.country;
  if (typeof country !== "string") throw new AppError("country is required", 400);
  const categories = Array.isArray(request.body?.categories) ? request.body.categories : undefined;
  const coverageRegions = Array.isArray(request.body?.coverageRegions) ? request.body.coverageRegions : undefined;
  // M5 (spec §10.2 step 5 "collection capacity").
  const collectionCapacityPerDay = Number.isInteger(request.body?.collectionCapacityPerDay) ? request.body.collectionCapacityPerDay : undefined;
  response.status(201).json({
    account: await supplierAccountService.applyAsSupplier(userId, { country, categories, coverageRegions, collectionCapacityPerDay }),
  });
}

/** M5 (spec §6.4 "paused: voluntarily unavailable for new work") — the only self-service SupplierAccount state transition; everything else in this file is admin-only. */
export async function pauseSupplierAccount(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ account: await supplierAccountService.pause(userId) });
}

export async function resumeSupplierAccount(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ account: await supplierAccountService.resume(userId) });
}

export async function getMySupplierProfile(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  const legacyProfile = vendor ? await organiserSupplierService.getSupplierProfile(vendor.id) : null;
  const account = await supplierAccountService.getView(userId);
  // `profile` kept for the currently-deployed mobile client (dual-read);
  // `account` is the new SupplierAccount-based shape a future client reads.
  response.json({ profile: legacyProfile, account });
}

// Workstream 3 — Stripe Connect onboarding for the no-Vendor SupplierAccount
// path (mandate item 2). Mirrors vendors/stripe-connect.controller.ts.
export async function onboardSupplierStripeConnect(request: Request, response: Response): Promise<void> {
  response.status(200).json(await supplierStripeConnectService.onboard(requireUserId(request)));
}

export async function getSupplierStripeConnectStatus(request: Request, response: Response): Promise<void> {
  response.status(200).json(await supplierStripeConnectService.getStatus(requireUserId(request)));
}

export async function refreshSupplierStripeConnect(request: Request, response: Response): Promise<void> {
  response.status(200).json(await supplierStripeConnectService.refresh(requireUserId(request)));
}

export async function listMySupplierCampaigns(request: Request, response: Response): Promise<void> {
  const acting = await resolveActingSupplier(requireUserId(request));
  const items = acting.kind === "vendor"
    ? await communityCampaignsService.listForSupplier(acting.vendorId)
    : await communityCampaignsService.listForSupplierAccount(acting.userId);
  response.json({ items });
}

// ─── Admin ──────────────────────────────────────────────────────────────

export async function adminListCampaignsForReview(_request: Request, response: Response): Promise<void> {
  response.json({ items: await communityCampaignsService.listForReview() });
}

export async function adminListRecentlyClosedCampaigns(_request: Request, response: Response): Promise<void> {
  response.json({ items: await communityCampaignsService.listRecentlyClosed() });
}

export async function adminApproveCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.approve(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_campaign.approve", entityType: "CommunityCampaign", entityId: id, afterState: { status: campaign.status }, request });
  response.json({ campaign });
}

export async function adminRequestCampaignChanges(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const notes = request.body?.notes;
  if (typeof notes !== "string" || !notes.trim()) throw new AppError("notes is required", 400);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.requestChanges(adminId, id, notes);
  await recordAudit({ actorId: adminId, action: "community_campaign.request_changes", entityType: "CommunityCampaign", entityId: id, reason: notes, afterState: { status: campaign.status }, request });
  response.json({ campaign });
}

export async function adminRejectCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const notes = typeof request.body?.notes === "string" ? request.body.notes : undefined;
  const campaign = await communityCampaignsService.reject(adminId, id, notes);
  await recordAudit({ actorId: adminId, action: "community_campaign.reject", entityType: "CommunityCampaign", entityId: id, reason: notes, afterState: { status: campaign.status }, request });
  response.json({ campaign });
}

export async function adminPauseCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.pause(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_campaign.pause", entityType: "CommunityCampaign", entityId: id, afterState: { status: campaign.status }, request });
  response.json({ campaign });
}

export async function adminResumeCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.resume(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_campaign.resume", entityType: "CommunityCampaign", entityId: id, afterState: { status: campaign.status }, request });
  response.json({ campaign });
}

// Phase 2 (admin ops) — the unified campaign-operations view's one shared
// issue/notes field. Independent of every other admin action here.
export async function adminSetCampaignIssueNotes(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const notes = request.body?.notes;
  if (typeof notes !== "string") throw new AppError("notes must be a string", 400);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.setAdminIssueNotes(adminId, id, notes);
  response.json({ campaign });
}

export async function adminCancelCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const campaign = await communityCampaignsService.cancel(adminId, id, reason.trim());
  await recordAudit({ actorId: adminId, action: "community_campaign.cancel", entityType: "CommunityCampaign", entityId: id, reason: reason.trim(), afterState: { status: campaign.status }, request });
  response.json({ campaign });
}

export async function adminListCampaignContributions(request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignContributionsService.listContributionsForAdmin(requireIdParam(request)) });
}

export async function adminListPendingOrganisers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listPendingOrganisers() });
}

export async function adminVerifyOrganiser(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const profile = await organiserSupplierService.verifyOrganiser(id);
  await recordAudit({ actorId: adminId, action: "community_organiser.verify", entityType: "CommunityOrganiserProfile", entityId: id, afterState: { isVerified: true }, request });
  response.json({ profile });
}

export async function adminListPendingSuppliers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listPendingSuppliers() });
}

export async function adminVerifySupplier(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const profile = await organiserSupplierService.verifySupplier(id);
  await recordAudit({ actorId: adminId, action: "community_supplier.verify", entityType: "CommunitySupplierProfile", entityId: id, afterState: { isVerified: true }, request });
  response.json({ profile });
}

// Community Buy Workstream 1 — admin actions on the new, no-Vendor-required
// SupplierAccount (distinct from the legacy Vendor-keyed SupplierProfile
// above). Backend-only for now; an admin-web review screen is Workstream 3.
export async function adminListSupplierAccounts(request: Request, response: Response): Promise<void> {
  const state = typeof request.query.state === "string" ? request.query.state : undefined;
  response.json({ items: await supplierAccountService.listForAdmin(state) });
}

export async function adminApproveSupplierAccount(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const account = await supplierAccountService.approve(id);
  await recordAudit({ actorId: adminId, action: "community_supplier_account.approve", entityType: "SupplierAccount", entityId: id, afterState: { supplierState: account.supplierState }, request });
  response.json({ account });
}

/**
 * M4 (spec §14.4, §15.4): controlScope now actually does something —
 * "fulfilment_access_preserved" is the only recognised value; anything
 * else is rejected up front rather than silently stored as a no-op string.
 * Restricting without that scope immediately revokes this supplier's open
 * DeliveryReference access across every campaign they're assigned to (not
 * just this one restriction's trigger) — matches spec §14.4's table.
 */
export async function adminRestrictSupplierAccount(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const { reason, controlScope } = request.body ?? {};
  if (typeof reason !== "string" || reason.length === 0) throw new AppError("reason is required", 400);
  if (controlScope !== undefined && controlScope !== null && controlScope !== FULFILMENT_ACCESS_PRESERVED_SCOPE) {
    throw new AppError(`controlScope must be "${FULFILMENT_ACCESS_PRESERVED_SCOPE}" or omitted`, 400);
  }
  const account = await supplierAccountService.restrict(id, reason, controlScope ?? null);
  if (account.controlScope !== FULFILMENT_ACCESS_PRESERVED_SCOPE) {
    await revokeDeliveryReferencesForSupplierAccount(id, "supplier_restricted", adminId);
  }
  await recordAudit({ actorId: adminId, action: "community_supplier_account.restrict", entityType: "SupplierAccount", entityId: id, reason, afterState: { supplierState: account.supplierState, controlScope: account.controlScope }, request });
  response.json({ account });
}

export async function adminUnrestrictSupplierAccount(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const account = await supplierAccountService.unrestrict(id);
  await recordAudit({ actorId: adminId, action: "community_supplier_account.unrestrict", entityType: "SupplierAccount", entityId: id, afterState: { supplierState: account.supplierState }, request });
  response.json({ account });
}

/** M5 — the equally-guarded (2FA) reversal for suspend(); never reachable through unrestrict(). */
export async function adminUnsuspendSupplierAccount(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const account = await supplierAccountService.unsuspend(id);
  await recordAudit({ actorId: adminId, action: "community_supplier_account.unsuspend", entityType: "SupplierAccount", entityId: id, afterState: { supplierState: account.supplierState }, request });
  response.json({ account });
}

/** M5 (spec §10.1/§10.2 step 6 "request information") */
export async function adminRequestSupplierInformation(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const { reason } = request.body ?? {};
  if (typeof reason !== "string" || reason.length === 0) throw new AppError("reason is required", 400);
  const account = await supplierAccountService.requestInformation(id, reason);
  await recordAudit({ actorId: adminId, action: "community_supplier_account.request_information", entityType: "SupplierAccount", entityId: id, reason, afterState: { supplierState: account.supplierState }, request });
  response.json({ account });
}

/** M5 (spec §6.4/§14.4) — admin-only; always revokes data access. */
export async function adminSuspendSupplierAccount(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const { reason } = request.body ?? {};
  if (typeof reason !== "string" || reason.length === 0) throw new AppError("reason is required", 400);
  const account = await supplierAccountService.suspend(id, reason, adminId);
  await recordAudit({ actorId: adminId, action: "community_supplier_account.suspend", entityType: "SupplierAccount", entityId: id, reason, afterState: { supplierState: account.supplierState }, request });
  response.json({ account });
}

/** M5 — permanent, terminal; admin-only. */
export async function adminCloseSupplierAccount(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const { reason } = request.body ?? {};
  if (typeof reason !== "string" || reason.length === 0) throw new AppError("reason is required", 400);
  const account = await supplierAccountService.close(id, reason, adminId);
  await recordAudit({ actorId: adminId, action: "community_supplier_account.close", entityType: "SupplierAccount", entityId: id, reason, afterState: { supplierState: account.supplierState }, request });
  response.json({ account });
}

/** M4 — manual, admin-initiated revoke, for investigation cases where nothing has changed the supplier's state (spec §19 "attribution/solicitation investigation"). */
export async function adminRevokeSupplierDataAccess(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const { reason } = request.body ?? {};
  if (typeof reason !== "string" || reason.length === 0) throw new AppError("reason is required", 400);
  const revokedCount = await revokeDeliveryReferencesForSupplierAccount(id, reason, adminId);
  await recordAudit({ actorId: adminId, action: "community_supplier_account.data_access_revoked", entityType: "SupplierAccount", entityId: id, reason, metadata: { revokedCount }, request });
  response.json({ revokedCount });
}

/** M4 — admin search surface for the data-access audit trail (spec §19, AT-43). */
export async function adminSearchDataAccessLog(request: Request, response: Response): Promise<void> {
  const { campaignId, supplierAccountId, accessorUserId, dataCategory, action, from, to, limit } = request.query;
  const items = await searchDataAccessLog({
    campaignId: typeof campaignId === "string" ? campaignId : undefined,
    supplierAccountId: typeof supplierAccountId === "string" ? supplierAccountId : undefined,
    accessorUserId: typeof accessorUserId === "string" ? accessorUserId : undefined,
    dataCategory: typeof dataCategory === "string" ? dataCategory : undefined,
    action: typeof action === "string" ? action : undefined,
    from: typeof from === "string" && from ? new Date(from) : undefined,
    to: typeof to === "string" && to ? new Date(to) : undefined,
    limit: typeof limit === "string" ? Number(limit) : undefined,
  });
  response.json({ items });
}

/**
 * M4 — emergency real-number disclosure (spec §14.3, AT-42). Always
 * four-eyes gated: unlike adminReleaseSupplierPayment()/
 * adminReleaseCommunityBuyPayout() below, this never checks
 * adminApprovalsService.requiresApproval()'s configurable, rule-based
 * threshold — a data-privacy override must always need a second admin,
 * not only above some amount (there is no amount here at all). The actual
 * grant is only ever created by adminDecideApproval()'s execution branch,
 * once a second, different admin has approved it.
 */
export async function adminRequestEmergencyDisclosure(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const campaignId = requireIdParam(request);
  const contributionId = requireContributionIdParam(request);
  const { reason } = request.body ?? {};
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const contribution = await prisma.campaignContribution.findUnique({ where: { id: contributionId } });
  if (!contribution || contribution.campaignId !== campaignId) throw new AppError("Contribution not found", 404);

  const approval = await adminApprovalsService.requestApproval({
    actionType: "community_buy.emergency_contact_disclosure",
    businessRefType: "CampaignContribution",
    businessRefId: contributionId,
    requestedById: adminId,
    reason,
  });
  await recordAudit({ actorId: adminId, action: "community_buy_data_access.emergency_disclosure_requested", entityType: "CampaignContribution", entityId: contributionId, reason, request });
  response.status(202).json({ pendingApproval: approval, message: "This disclosure requires a second admin's approval before it executes." });
}

export async function adminListRefunds(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignContributionsService.listRefundsForAdmin() });
}

export async function adminRequeryRefund(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const refund = await campaignContributionsService.requeryRefund(requireIdParam(request));
  await recordAudit({ actorId: adminId, action: "community_refund.requery", entityType: "CampaignRefund", entityId: refund.id, afterState: { status: refund.status }, request });
  response.json({ refund });
}

export async function adminEscalateRefund(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const { note } = request.body ?? {};
  const escalationNote = typeof note === "string" ? note : undefined;
  const supportCase = await campaignContributionsService.escalateRefund(adminId, requireIdParam(request), escalationNote);
  await recordAudit({ actorId: adminId, action: "community_refund.escalate", entityType: "CampaignRefund", entityId: requireIdParam(request), reason: escalationNote, metadata: { supportCaseId: supportCase.id }, request });
  response.json({ supportCase });
}

export async function adminListExtensionRequests(_request: Request, response: Response): Promise<void> {
  response.json({ items: await communityCampaignsService.listExtensionRequestsForAdmin() });
}

export async function adminApproveExtension(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const extensionRequest = await communityCampaignsService.approveExtension(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_campaign_extension.approve", entityType: "CampaignExtensionRequest", entityId: id, afterState: extensionRequest ? { status: extensionRequest.status } : undefined, request });
  response.json({ extensionRequest });
}

export async function adminRejectExtension(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const notes = typeof request.body?.notes === "string" ? request.body.notes : undefined;
  const extensionRequest = await communityCampaignsService.rejectExtension(adminId, id, notes);
  await recordAudit({ actorId: adminId, action: "community_campaign_extension.reject", entityType: "CampaignExtensionRequest", entityId: id, reason: notes, afterState: { status: extensionRequest.status }, request });
  response.json({ extensionRequest });
}

export async function adminListCancellationRequests(_request: Request, response: Response): Promise<void> {
  response.json({ items: await communityCampaignsService.listCancellationRequestsForAdmin() });
}

// Phase 4 (cancellation under review) — mirrors adminReleaseSupplierPayment()'s
// exact four-eyes-gate shape: an optional AdminApprovalRule
// ("community_buy.cancellation_approval") can require a second admin's
// sign-off before this actually executes; with no rule configured it
// proceeds directly, same as it always has.
export async function adminApproveCancellation(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);

  const gated = await adminApprovalsService.requiresApproval("community_buy.cancellation_approval", null);
  if (gated) {
    const approval = await adminApprovalsService.requestApproval({
      actionType: "community_buy.cancellation_approval",
      businessRefType: "CampaignCancellationRequest",
      businessRefId: id,
      requestedById: adminId,
      reason: "Cancellation approval requested",
    });
    await recordAudit({ actorId: adminId, action: "community_campaign_cancellation.approve_requested", entityType: "CampaignCancellationRequest", entityId: id, request });
    response.status(202).json({ pendingApproval: approval, message: "This approval requires a second admin's sign-off before it executes." });
    return;
  }

  const cancellationRequest = await communityCampaignsService.approveCancellation(adminId, id);
  response.json({ cancellationRequest });
}

export async function adminRejectCancellation(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const notes = typeof request.body?.notes === "string" ? request.body.notes : undefined;
  const cancellationRequest = await communityCampaignsService.rejectCancellation(adminId, id, notes);
  await recordAudit({ actorId: adminId, action: "community_campaign_cancellation.reject", entityType: "CampaignCancellationRequest", entityId: id, reason: notes, afterState: { status: cancellationRequest.status }, request });
  response.json({ cancellationRequest });
}

export async function adminListSupplierPayments(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignContributionsService.listSupplierPaymentsForAdmin() });
}

/** GET /admin/community-buy/supplier-payments/aggregate — real cross-campaign/cross-supplier totals, never mixing currencies. */
export async function adminGetSupplierPaymentAggregate(request: Request, response: Response): Promise<void> {
  const { from, to, status, supplierId, campaignId } = request.query;
  const result = await campaignContributionsService.getSupplierPaymentAggregate({
    from: typeof from === "string" && from ? new Date(from) : undefined,
    to: typeof to === "string" && to ? new Date(to) : undefined,
    status: typeof status === "string" && status ? status : undefined,
    supplierId: typeof supplierId === "string" && supplierId ? supplierId : undefined,
    campaignId: typeof campaignId === "string" && campaignId ? campaignId : undefined,
  });
  response.json(result);
}

export async function adminReleaseSupplierPayment(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);

  // Four-eyes gate (architecture doc §7) — the monetary threshold is
  // configurable via AdminApprovalRule, never hardcoded here. With no rule
  // row for this actionType, requiresApproval() returns false and release
  // proceeds exactly as it always has.
  const existingPayment = await prisma.campaignSupplierPayment.findUnique({ where: { campaignId: id }, select: { amount: true } });
  const gated = await adminApprovalsService.requiresApproval("community_buy.supplier_payment_release", existingPayment?.amount ?? null);
  if (gated) {
    const approval = await adminApprovalsService.requestApproval({
      actionType: "community_buy.supplier_payment_release",
      businessRefType: "CampaignSupplierPayment",
      businessRefId: id,
      amount: existingPayment?.amount ?? null,
      requestedById: adminId,
      reason: "Supplier payment release requested",
    });
    await recordAudit({ actorId: adminId, action: "community_supplier_payment.release_requested", entityType: "CampaignSupplierPayment", entityId: id, request });
    response.status(202).json({ pendingApproval: approval, message: "This release requires a second admin's approval before it executes." });
    return;
  }

  const payment = await campaignContributionsService.releaseSupplierPayment(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_supplier_payment.release", entityType: "CampaignSupplierPayment", entityId: id, afterState: { status: payment.status }, request });
  response.json({ payment });
}

export async function adminHoldSupplierPayment(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const id = requireIdParam(request);
  const payment = await campaignContributionsService.holdSupplierPayment(adminId, id, reason);
  await recordAudit({ actorId: adminId, action: "community_supplier_payment.hold", entityType: "CampaignSupplierPayment", entityId: id, reason, afterState: { status: payment.status }, request });
  response.json({ payment });
}

// ─── Diaspora escrow reconciliation — organiser payout admin ────────────
// Mirrors the CampaignSupplierPayment admin functions above exactly (same
// four-eyes gate shape, same audit actions) for the organiser's own payout.

export async function adminListOrganiserPayouts(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserPayoutService.listForAdmin() });
}

export async function adminReleaseOrganiserPayout(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);

  const existingPayout = await prisma.communityBuyOrganiserPayout.findUnique({ where: { campaignId: id }, select: { amount: true } });
  const gated = await adminApprovalsService.requiresApproval("community_buy.organiser_payout_release", existingPayout?.amount ?? null);
  if (gated) {
    const approval = await adminApprovalsService.requestApproval({
      actionType: "community_buy.organiser_payout_release",
      businessRefType: "CommunityBuyOrganiserPayout",
      businessRefId: id,
      amount: existingPayout?.amount ?? null,
      requestedById: adminId,
      reason: "Organiser payout release requested",
    });
    await recordAudit({ actorId: adminId, action: "community_buy_organiser_payout.release_requested", entityType: "CommunityBuyOrganiserPayout", entityId: id, request });
    response.status(202).json({ pendingApproval: approval, message: "This release requires a second admin's approval before it executes." });
    return;
  }

  const payout = await organiserPayoutService.releaseOrganiserPayment(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_buy_organiser_payout.release", entityType: "CommunityBuyOrganiserPayout", entityId: id, afterState: { status: payout.status }, request });
  response.json({ payout });
}

export async function adminHoldOrganiserPayout(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const id = requireIdParam(request);
  const payout = await organiserPayoutService.holdOrganiserPayout(adminId, id, reason);
  await recordAudit({ actorId: adminId, action: "community_buy_organiser_payout.hold", entityType: "CommunityBuyOrganiserPayout", entityId: id, reason, afterState: { status: payout.status }, request });
  response.json({ payout });
}

// ─── Diaspora escrow reconciliation — organiser Stripe Connect + own payout view ───

export async function onboardOrganiserStripeConnect(request: Request, response: Response): Promise<void> {
  response.status(200).json(await organiserStripeConnectService.onboard(requireUserId(request)));
}

export async function getOrganiserStripeConnectStatus(request: Request, response: Response): Promise<void> {
  response.status(200).json(await organiserStripeConnectService.getStatus(requireUserId(request)));
}

export async function refreshOrganiserStripeConnect(request: Request, response: Response): Promise<void> {
  response.status(200).json(await organiserStripeConnectService.refresh(requireUserId(request)));
}

/** Organiser's own read-only view of their payout for one campaign. */
export async function getMyOrganiserPayout(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const id = requireIdParam(request);
  const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
  if (!organiser) throw new AppError("Organiser profile required", 403);
  const payout = await organiserPayoutService.getMyPayout(organiser.id, id);
  response.json({ payout });
}

// ─── M2 — AUTHORISE_THEN_CAPTURE payout admin (CommunityBuyPayout) ──────
// Parallel to the CampaignSupplierPayment admin functions above, never
// sharing a code path with them — see campaign-payout.service.ts's doc
// comment for why "release" here does NOT necessarily move real money the
// way adminReleaseSupplierPayment() above does.

/** M8 — admin queue visibility for near-expiry holds (Appendix A "capture expiry" screen). */
export async function adminListExpiringHolds(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignAuthorisationService.listExpiringHolds() });
}

/** M8 — "stuck payout state" scan. Returns configured:false (and an empty list) until an operator sets PAYOUT_STUCK_THRESHOLD_HOURS — never invents a default threshold. */
export async function adminScanStuckPayouts(_request: Request, response: Response): Promise<void> {
  response.json(await campaignPayoutService.scanStuckPayouts());
}

export async function adminListCommunityBuyPayouts(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignPayoutService.listForAdmin() });
}

export async function adminGetCommunityBuyPayout(request: Request, response: Response): Promise<void> {
  response.json({ payout: await campaignPayoutService.get(requireIdParam(request)) });
}

/** M6 — read-only preview of the same server-recomputed eligibility markReady()/triggerManualPayout() enforce, so the admin screen can explain a blocker before an admin attempts (and gets refused). */
export async function adminGetCommunityBuyPayoutEligibility(request: Request, response: Response): Promise<void> {
  response.json(await campaignPayoutService.getEligibility(requireIdParam(request)));
}

export async function adminMarkCommunityBuyPayoutReady(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const payout = await campaignPayoutService.markReady(adminId, requireIdParam(request));
  response.json({ payout });
}

export async function adminHoldCommunityBuyPayout(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reasonCode = request.body?.reasonCode;
  if (typeof reasonCode !== "string" || !reasonCode.trim()) throw new AppError("reasonCode is required", 400);
  const payout = await campaignPayoutService.hold(adminId, requireIdParam(request), reasonCode);
  response.json({ payout });
}

/**
 * Same four-eyes gate as adminReleaseSupplierPayment() above, reused
 * as-is (same actionType-agnostic requiresApproval() call, different
 * actionType string) — but the underlying service call itself will still
 * refuse (503 PAYOUT_CUSTODY_NOT_CONFIRMED) unless
 * COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED=true has been explicitly set,
 * regardless of approval state. Four-eyes and custody-confirmation are
 * independent gates; both must pass.
 */
export async function adminReleaseCommunityBuyPayout(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const existingPayout = await prisma.communityBuyPayout.findUnique({ where: { campaignId: id }, select: { netPayoutAmount: true } });
  const gated = await adminApprovalsService.requiresApproval("community_buy.payout_release", existingPayout?.netPayoutAmount ?? null);
  if (gated) {
    const approval = await adminApprovalsService.requestApproval({
      actionType: "community_buy.payout_release",
      businessRefType: "CommunityBuyPayout",
      businessRefId: id,
      amount: existingPayout?.netPayoutAmount ?? null,
      requestedById: adminId,
      reason: "Community Buy payout release requested",
    });
    await recordAudit({ actorId: adminId, action: "community_buy_payout.release_requested", entityType: "CommunityBuyPayout", entityId: id, request });
    response.status(202).json({ pendingApproval: approval, message: "This release requires a second admin's approval before it executes." });
    return;
  }
  const payout = await campaignPayoutService.triggerManualPayout(adminId, id);
  response.json({ payout });
}

// ─── M7 — CommunityBuyOrganiserFee admin (spec §13.3/§15.6) ─────────────
// Accounting/accrual only — see organiser-fee.service.ts's own doc comment
// for why this never shares a code path with the payout functions above:
// an organiser fee is never a supplier payout.

export async function adminListCommunityBuyOrganiserFees(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserFeeService.listForAdmin() });
}

export async function adminGetCommunityBuyOrganiserFee(request: Request, response: Response): Promise<void> {
  response.json({ fee: await organiserFeeService.get(requireIdParam(request)) });
}

export async function adminHoldCommunityBuyOrganiserFee(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reasonCode = request.body?.reasonCode;
  if (typeof reasonCode !== "string" || !reasonCode.trim()) throw new AppError("reasonCode is required", 400);
  const fee = await organiserFeeService.hold(adminId, requireIdParam(request), reasonCode);
  response.json({ fee });
}

export async function adminReleaseCommunityBuyOrganiserFee(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const fee = await organiserFeeService.release(adminId, requireIdParam(request));
  response.json({ fee });
}

/**
 * Records settlement through an approved, non-Eki-cash route (spec §1.3).
 * See organiser-fee.service.ts's settleFee() doc comment: only
 * STRIPE_CONNECT_TRANSFER is gated behind an unresolved external
 * dependency and will refuse with 503 regardless of this route's own 2FA.
 */
export async function adminSettleCommunityBuyOrganiserFee(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const settlementMethod = request.body?.settlementMethod;
  if (settlementMethod !== "EXTERNAL_SUPPLIER_ARRANGEMENT" && settlementMethod !== "NON_CASH_REWARD" && settlementMethod !== "STRIPE_CONNECT_TRANSFER") {
    throw new AppError("settlementMethod must be EXTERNAL_SUPPLIER_ARRANGEMENT, NON_CASH_REWARD, or STRIPE_CONNECT_TRANSFER", 400);
  }
  const providerReference = typeof request.body?.providerReference === "string" ? request.body.providerReference : undefined;
  const fee = await organiserFeeService.settleFee(adminId, requireIdParam(request), settlementMethod, providerReference);
  response.json({ fee });
}

/** Organiser's own read-only view of their campaign's accrued reward. */
export async function getMyCommunityBuyOrganiserFee(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const organiser = await prisma.organiserProfile.findUnique({ where: { userId } });
  if (!organiser) throw new AppError("Organiser profile not found", 404);
  response.json({ fee: await organiserFeeService.getMyFee(organiser.id, requireIdParam(request)) });
}

// ─── M7 — Attribution review (spec §14.5, AT-45/AT-46) ──────────────────
// Manual admin investigation flow only — no automatic solicitation
// detector exists in the spec, so none is invented here.

export async function adminListAttributionReviews(request: Request, response: Response): Promise<void> {
  const status = request.query.status;
  const validStatus = status === "UNDER_REVIEW" || status === "INVALIDATED" || status === "ACTIVE" ? status : "UNDER_REVIEW";
  response.json({ items: await attributionReviewService.listForAdmin(validStatus) });
}

export async function adminFlagAttributionForReview(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const participant = await attributionReviewService.flagForReview(adminId, requireIdParam(request), reason);
  response.json({ participant });
}

export async function adminResolveAttributionReview(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const outcome = request.body?.outcome;
  const reason = request.body?.reason;
  if (outcome !== "CONFIRMED_VALID" && outcome !== "INVALIDATED") throw new AppError("outcome must be CONFIRMED_VALID or INVALIDATED", 400);
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const participant = await attributionReviewService.resolveReview(adminId, requireIdParam(request), outcome, reason);
  response.json({ participant });
}

export async function adminListMarketConfigurations(_request: Request, response: Response): Promise<void> {
  response.json({ items: await marketConfigurationService.list() });
}

export async function adminUpdateMarketConfiguration(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const countryCode = requireIdParam(request);
  const before = await marketConfigurationService.get(countryCode);
  const config = await marketConfigurationService.update(countryCode, request.body);
  await recordAudit({
    actorId: adminId,
    action: "community_market_config.update",
    entityType: "MarketConfiguration",
    entityId: countryCode,
    metadata: request.body,
    beforeState: before ?? undefined,
    afterState: config,
    request,
  });
  response.json({ config });
}

export async function adminGetLedgerSummary(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignContributionsService.getLedgerSummaryForAdmin() });
}

export async function adminGetCampaignLedger(request: Request, response: Response): Promise<void> {
  response.json(await campaignContributionsService.getCampaignLedger(requireIdParam(request)));
}

// ─── Risk controls ────────────────────────────────────────────────────

export async function adminListVerifiedOrganisers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listVerifiedOrganisersForAdmin() });
}

export async function adminListVerifiedSuppliers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listVerifiedSuppliersForAdmin() });
}

export async function adminRestrictOrganiser(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const id = requireIdParam(request);
  const before = await organiserSupplierService.getOrganiserRestrictionState(id);
  const profile = await organiserSupplierService.restrictOrganiser(id, reason);
  await recordAudit({ actorId: adminId, action: "community_organiser.restrict", entityType: "OrganiserProfile", entityId: id, reason, beforeState: before ?? undefined, afterState: { isRestricted: profile.isRestricted, restrictedReason: profile.restrictedReason }, request });
  response.json({ profile });
}

export async function adminUnrestrictOrganiser(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const before = await organiserSupplierService.getOrganiserRestrictionState(id);
  const profile = await organiserSupplierService.unrestrictOrganiser(id);
  await recordAudit({ actorId: adminId, action: "community_organiser.unrestrict", entityType: "OrganiserProfile", entityId: id, beforeState: before ?? undefined, afterState: { isRestricted: profile.isRestricted, restrictedReason: profile.restrictedReason }, request });
  response.json({ profile });
}

export async function adminRestrictSupplier(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const id = requireIdParam(request);
  const before = await organiserSupplierService.getSupplierRestrictionState(id);
  const profile = await organiserSupplierService.restrictSupplier(id, reason);
  await recordAudit({ actorId: adminId, action: "community_supplier.restrict", entityType: "SupplierProfile", entityId: id, reason, beforeState: before ?? undefined, afterState: { isRestricted: profile.isRestricted, restrictedReason: profile.restrictedReason }, request });
  response.json({ profile });
}

export async function adminUnrestrictSupplier(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const before = await organiserSupplierService.getSupplierRestrictionState(id);
  const profile = await organiserSupplierService.unrestrictSupplier(id);
  await recordAudit({ actorId: adminId, action: "community_supplier.unrestrict", entityType: "SupplierProfile", entityId: id, beforeState: before ?? undefined, afterState: { isRestricted: profile.isRestricted, restrictedReason: profile.restrictedReason }, request });
  response.json({ profile });
}
