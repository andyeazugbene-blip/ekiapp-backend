import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
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
  const amount = Number(request.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError("A positive amount is required", 400);
  const result = await campaignContributionsService.createContributionIntent(userId, requireIdParam(request), amount);
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

export async function fulfilCampaignAnyway(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.fulfilAnyway(userId, requireIdParam(request)) });
}

export async function cancelFailedCampaign(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.cancelAfterFailure(userId, requireIdParam(request)) });
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
  response.json({ campaign: await communityCampaignsService.approve(adminId, requireIdParam(request)) });
}

export async function adminRequestCampaignChanges(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const notes = request.body?.notes;
  if (typeof notes !== "string" || !notes.trim()) throw new AppError("notes is required", 400);
  response.json({ campaign: await communityCampaignsService.requestChanges(adminId, requireIdParam(request), notes) });
}

export async function adminRejectCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.reject(adminId, requireIdParam(request), request.body?.notes) });
}

export async function adminPauseCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.pause(adminId, requireIdParam(request)) });
}

export async function adminResumeCampaign(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  response.json({ campaign: await communityCampaignsService.resume(adminId, requireIdParam(request)) });
}

export async function adminListPendingOrganisers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listPendingOrganisers() });
}

export async function adminVerifyOrganiser(request: Request, response: Response): Promise<void> {
  response.json({ profile: await organiserSupplierService.verifyOrganiser(requireIdParam(request)) });
}

export async function adminListPendingSuppliers(_request: Request, response: Response): Promise<void> {
  response.json({ items: await organiserSupplierService.listPendingSuppliers() });
}

export async function adminVerifySupplier(request: Request, response: Response): Promise<void> {
  response.json({ profile: await organiserSupplierService.verifySupplier(requireIdParam(request)) });
}

export async function adminListRefunds(_request: Request, response: Response): Promise<void> {
  response.json({ items: await campaignContributionsService.listRefundsForAdmin() });
}

export async function adminListMarketConfigurations(_request: Request, response: Response): Promise<void> {
  response.json({ items: await marketConfigurationService.list() });
}

export async function adminUpdateMarketConfiguration(request: Request, response: Response): Promise<void> {
  const countryCode = requireIdParam(request);
  const config = await marketConfigurationService.update(countryCode, request.body);
  response.json({ config });
}
