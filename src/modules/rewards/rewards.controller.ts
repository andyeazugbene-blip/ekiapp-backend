import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { rewardsService } from "./rewards.service";
import {
  validateCreateRewardInput,
  validateUpdateRewardInput,
  validateClaimRewardInput,
} from "./rewards.validation";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export async function adminCreateReward(request: Request, response: Response): Promise<void> {
  const input = validateCreateRewardInput(request.body);
  const reward = await rewardsService.create(input);
  response.status(201).json({ reward });
}

export async function adminListRewards(_request: Request, response: Response): Promise<void> {
  const rewards = await rewardsService.listAll();
  response.status(200).json({ rewards });
}

export async function adminUpdateReward(request: Request, response: Response): Promise<void> {
  const input = validateUpdateRewardInput(request.body);
  const reward = await rewardsService.update(requireIdParam(request), input);
  response.status(200).json({ reward });
}

export async function adminDeleteReward(request: Request, response: Response): Promise<void> {
  await rewardsService.delete(requireIdParam(request));
  response.status(200).json({ message: "Reward deleted" });
}

// ─── Buyer ──────────────────────────────────────────────────────────────────

export async function listActiveRewards(_request: Request, response: Response): Promise<void> {
  const rewards = await rewardsService.listActive();
  response.status(200).json({ rewards });
}

export async function claimReward(request: Request, response: Response): Promise<void> {
  const input = validateClaimRewardInput(request.body);
  const userReward = await rewardsService.claimReward(requireUserId(request), input.referralCode);
  response.status(201).json({ userReward });
}

export async function getUserRewards(request: Request, response: Response): Promise<void> {
  const rewards = await rewardsService.getUserRewards(requireUserId(request));
  response.status(200).json({ rewards });
}
