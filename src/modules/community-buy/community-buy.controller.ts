import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { organiserSupplierService } from "./organiser-supplier.service";
import { communityCampaignsService } from "./community-campaigns.service";
import { campaignContributionsService } from "./campaign-contributions.service";
import { campaignFulfilmentService } from "./campaign-fulfilment.service";
import { marketConfigurationService } from "./market-configuration.service";
import { supportCaseService } from "./support-case.service";
import { adminApprovalsService } from "../admin/admin-approvals.service";

// ─── Public market availability (used by the mobile app to decide whether
// to show Regular Deliveries / Community Buy entry points at all — the
// backend is always the source of truth, never a hardcoded country list) ──

export async function listPublicMarketConfigs(_request: Request, response: Response): Promise<void> {
  response.json({ items: await marketConfigurationService.list() });
}

export async function getPublicMarketConfig(request: Request, response: Response): Promise<void> {
  const country = request.params.country;
  if (typeof country !== "string" || !country) throw new AppError("country is required", 400);
  const config = await marketConfigurationService.get(country.toUpperCase());
  response.json({
    config: config ?? {
      countryCode: country.toUpperCase(),
      communityBuyEnabled: false,
      organiserApplicationsEnabled: false,
      supplierApplicationsEnabled: false,
      regularDeliveriesEnabled: false,
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

// ─── Discovery (public) ────────────────────────────────────────────────

export async function listCampaigns(request: Request, response: Response): Promise<void> {
  const country = typeof request.query.country === "string" ? request.query.country : undefined;
  response.json({ items: await communityCampaignsService.listLive(country) });
}

export async function getCampaign(request: Request, response: Response): Promise<void> {
  response.json({ campaign: await communityCampaignsService.get(requireIdParam(request)) });
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
export async function pledgeContribution(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const quantity = Number(request.body?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError("A positive integer quantity is required", 400);
  const paymentMethodId = requirePaymentMethodIdBody(request);
  const result = await campaignContributionsService.pledge(userId, requireIdParam(request), quantity, paymentMethodId);
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

export async function endCampaignRescue(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.endRescueAndRefund(userId, requireIdParam(request)) });
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
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ campaign: await communityCampaignsService.confirmSupplierCommitment(vendorId, requireIdParam(request)) });
}

// ─── Supplier fulfilment — doc Phase 8 ─────────────────────────────────

export async function getSupplierFulfilment(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ fulfilment: await campaignFulfilmentService.getForSupplier(vendorId, requireIdParam(request)) });
}

export async function getMySupplierPayment(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ payment: await campaignContributionsService.getMyPaymentForCampaign(vendorId, requireIdParam(request)) });
}

export async function confirmFulfilmentInventory(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ fulfilment: await campaignFulfilmentService.confirmInventory(vendorId, requireIdParam(request)) });
}

export async function setFulfilmentPlan(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const method = request.body?.method;
  if (method !== "DELIVERY" && method !== "COLLECTION") throw new AppError("method must be DELIVERY or COLLECTION", 400);
  response.json({
    fulfilment: await campaignFulfilmentService.setPlan(vendorId, requireIdParam(request), {
      method,
      estimatedReadyAt: typeof request.body?.estimatedReadyAt === "string" ? request.body.estimatedReadyAt : undefined,
      notes: typeof request.body?.notes === "string" ? request.body.notes : undefined,
    }),
  });
}

export async function startFulfilmentPacking(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ fulfilment: await campaignFulfilmentService.startPacking(vendorId, requireIdParam(request)) });
}

export async function markFulfilmentReady(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ fulfilment: await campaignFulfilmentService.markReady(vendorId, requireIdParam(request)) });
}

export async function markFulfilmentDispatched(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ fulfilment: await campaignFulfilmentService.markDispatched(vendorId, requireIdParam(request)) });
}

export async function markFulfilmentCollected(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ fulfilment: await campaignFulfilmentService.markCollected(vendorId, requireIdParam(request)) });
}

export async function getOrganiserFulfilment(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ fulfilment: await campaignFulfilmentService.getForOrganiser(userId, requireIdParam(request)) });
}

export async function organiserConfirmFulfilmentCompletion(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ fulfilment: await campaignFulfilmentService.organiserConfirmCompletion(userId, requireIdParam(request)) });
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

export async function applyAsSupplier(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const country = request.body?.country;
  if (typeof country !== "string") throw new AppError("country is required", 400);
  response.status(201).json({ profile: await organiserSupplierService.applyAsSupplier(vendorId, country) });
}

export async function getMySupplierProfile(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ profile: await organiserSupplierService.getSupplierProfile(vendorId) });
}

export async function listMySupplierCampaigns(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ items: await communityCampaignsService.listForSupplier(vendorId) });
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
