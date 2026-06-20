import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { campaignsService } from "./campaigns.service";
import { validateCampaignInput } from "./campaigns.validation";

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
  const campaigns = await campaignsService.listEligibleForUser(buyerId);
  res.json({ campaigns });
}
