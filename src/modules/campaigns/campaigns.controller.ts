import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { EVENT_NAMES, eventsService } from "../events/events.service";
import { campaignsService } from "./campaigns.service";
import { validateCampaignInput } from "./campaigns.validation";

// The home screen refetches often. One impression per viewer, per campaign, per hour.
const IMPRESSION_WINDOW_MS = 60 * 60 * 1000;
const IMPRESSION_MEMORY_LIMIT = 5000;
const recentImpressions = new Map<string, number>();

function recordImpressions(campaigns: { id: string }[], viewerKey: string, buyerId: string | null): void {
  const now = Date.now();
  if (recentImpressions.size > IMPRESSION_MEMORY_LIMIT) recentImpressions.clear();
  for (const campaign of campaigns) {
    const key = `${viewerKey}:${campaign.id}`;
    const last = recentImpressions.get(key);
    if (last !== undefined && now - last < IMPRESSION_WINDOW_MS) continue;
    recentImpressions.set(key, now);
    eventsService.emit({ name: EVENT_NAMES.campaign_impression, actorType: buyerId ? "user" : "anonymous", actorId: buyerId, entityType: "Campaign", entityId: campaign.id, source: "api" });
  }
}

export async function adminListCampaigns(_req: Request, res: Response): Promise<void> {
  const campaigns = await campaignsService.adminList();
  res.json({ campaigns });
}

export async function adminCreateCampaign(req: Request, res: Response): Promise<void> {
  const input = validateCampaignInput(req.body ?? {});
  const campaign = await campaignsService.create(input);
  res.status(201).json({ campaign });
}

export async function adminUpdateCampaign(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? "");
  if (!id) throw new AppError("Campaign id is required", 400);
  const campaign = await campaignsService.update(id, req.body ?? {});
  res.json({ campaign });
}

export async function adminDeleteCampaign(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? "");
  if (!id) throw new AppError("Campaign id is required", 400);
  await campaignsService.delete(id);
  res.status(204).send();
}

export async function listMyCampaigns(req: Request, res: Response): Promise<void> {
  const buyerId = req.user?.id ?? null;
  const campaigns = await campaignsService.listForDisplay(buyerId);
  recordImpressions(campaigns, buyerId ?? req.ip ?? "anonymous", buyerId);
  res.json({ campaigns });
}
