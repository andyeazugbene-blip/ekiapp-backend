import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { organiserSupplierService } from "./organiser-supplier.service";
import { communityCampaignsService } from "./community-campaigns.service";
import { campaignContributionsService } from "./campaign-contributions.service";
import { marketConfigurationService } from "./market-configuration.service";

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

export async function createContribution(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const quantity = Number(request.body?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError("A positive integer quantity is required", 400);
  const result = await campaignContributionsService.createContributionIntent(userId, requireIdParam(request), quantity);
  response.status(201).json(result);
}

export async function createOrganiserTopUp(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const quantity = Number(request.body?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError("A positive integer quantity is required", 400);
  const result = await campaignContributionsService.createOrganiserTopUp(userId, requireIdParam(request), quantity);
  response.status(201).json(result);
}

export async function getContribution(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ contribution: await campaignContributionsService.getMyContribution(userId, requireIdParam(request)) });
}

export async function confirmContributionPayment(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ contribution: await campaignContributionsService.verifyContribution(userId, requireIdParam(request)) });
}

export async function listMyContributions(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await campaignContributionsService.listMyContributions(userId) });
}

export async function getCampaignUpdates(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ items: await communityCampaignsService.listMyCampaignUpdates(userId, requireIdParam(request)) });
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
  await recordAudit({ actorId: adminId, action: "community_campaign.approve", entityType: "CommunityCampaign", entityId: id });
  response.json({ campaign });
}

export async function adminRequestCampaignChanges(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const notes = request.body?.notes;
  if (typeof notes !== "string" || !notes.trim()) throw new AppError("notes is required", 400);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.requestChanges(adminId, id, notes);
  await recordAudit({ actorId: adminId, action: "community_campaign.request_changes", entityType: "CommunityCampaign", entityId: id, metadata: { notes } });
  response.json({ campaign });
}

export async function adminRejectCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.reject(adminId, id, request.body?.notes);
  await recordAudit({ actorId: adminId, action: "community_campaign.reject", entityType: "CommunityCampaign", entityId: id, metadata: { notes: request.body?.notes } });
  response.json({ campaign });
}

export async function adminPauseCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.pause(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_campaign.pause", entityType: "CommunityCampaign", entityId: id });
  response.json({ campaign });
}

export async function adminResumeCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const campaign = await communityCampaignsService.resume(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_campaign.resume", entityType: "CommunityCampaign", entityId: id });
  response.json({ campaign });
}

export async function adminListPendingOrganisers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listPendingOrganisers() });
}

export async function adminVerifyOrganiser(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const profile = await organiserSupplierService.verifyOrganiser(id);
  await recordAudit({ actorId: adminId, action: "community_organiser.verify", entityType: "CommunityOrganiserProfile", entityId: id });
  response.json({ profile });
}

export async function adminListPendingSuppliers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listPendingSuppliers() });
}

export async function adminVerifySupplier(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const profile = await organiserSupplierService.verifySupplier(id);
  await recordAudit({ actorId: adminId, action: "community_supplier.verify", entityType: "CommunitySupplierProfile", entityId: id });
  response.json({ profile });
}

export async function adminListRefunds(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignContributionsService.listRefundsForAdmin() });
}

export async function adminListExtensionRequests(_request: Request, response: Response): Promise<void> {
  response.json({ items: await communityCampaignsService.listExtensionRequestsForAdmin() });
}

export async function adminApproveExtension(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const extensionRequest = await communityCampaignsService.approveExtension(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_campaign_extension.approve", entityType: "CampaignExtensionRequest", entityId: id });
  response.json({ extensionRequest });
}

export async function adminRejectExtension(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const extensionRequest = await communityCampaignsService.rejectExtension(adminId, id, request.body?.notes);
  await recordAudit({ actorId: adminId, action: "community_campaign_extension.reject", entityType: "CampaignExtensionRequest", entityId: id, metadata: { notes: request.body?.notes } });
  response.json({ extensionRequest });
}

export async function adminListSupplierPayments(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignContributionsService.listSupplierPaymentsForAdmin() });
}

export async function adminReleaseSupplierPayment(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const payment = await campaignContributionsService.releaseSupplierPayment(adminId, id);
  await recordAudit({ actorId: adminId, action: "community_supplier_payment.release", entityType: "CampaignSupplierPayment", entityId: id });
  response.json({ payment });
}

export async function adminHoldSupplierPayment(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const id = requireIdParam(request);
  const payment = await campaignContributionsService.holdSupplierPayment(adminId, id, reason);
  await recordAudit({ actorId: adminId, action: "community_supplier_payment.hold", entityType: "CampaignSupplierPayment", entityId: id, metadata: { reason } });
  response.json({ payment });
}

export async function adminListMarketConfigurations(_request: Request, response: Response): Promise<void> {
  response.json({ items: await marketConfigurationService.list() });
}

export async function adminUpdateMarketConfiguration(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const countryCode = requireIdParam(request);
  const config = await marketConfigurationService.update(countryCode, request.body);
  await recordAudit({ actorId: adminId, action: "community_market_config.update", entityType: "MarketConfiguration", entityId: countryCode, metadata: request.body });
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
  const profile = await organiserSupplierService.restrictOrganiser(id, reason);
  await recordAudit({ actorId: adminId, action: "community_organiser.restrict", entityType: "OrganiserProfile", entityId: id, metadata: { reason } });
  response.json({ profile });
}

export async function adminUnrestrictOrganiser(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const profile = await organiserSupplierService.unrestrictOrganiser(id);
  await recordAudit({ actorId: adminId, action: "community_organiser.unrestrict", entityType: "OrganiserProfile", entityId: id });
  response.json({ profile });
}

export async function adminRestrictSupplier(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const id = requireIdParam(request);
  const profile = await organiserSupplierService.restrictSupplier(id, reason);
  await recordAudit({ actorId: adminId, action: "community_supplier.restrict", entityType: "SupplierProfile", entityId: id, metadata: { reason } });
  response.json({ profile });
}

export async function adminUnrestrictSupplier(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const id = requireIdParam(request);
  const profile = await organiserSupplierService.unrestrictSupplier(id);
  await recordAudit({ actorId: adminId, action: "community_supplier.unrestrict", entityType: "SupplierProfile", entityId: id });
  response.json({ profile });
}
