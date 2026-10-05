import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
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
// Rewards and Hot Deals are never hard-deleted: pause / resume / archive only,
// every mutation audited with a reason (handbook 14.4 / 14.12).

export async function adminCreateReward(request: Request, response: Response): Promise<void> {
  const input = validateCreateRewardInput(request.body);
  const reward = await rewardsService.create(input);
  await recordAudit({
    request,
    actorId: requireUserId(request),
    action: "reward.create",
    entityType: "Reward",
    entityId: reward.id,
    reason: typeof request.body?.reason === "string" ? request.body.reason.trim() || undefined : undefined,
    afterState: reward as unknown as Record<string, unknown>,
  });
  response.status(201).json({ reward });
}

export async function adminListRewards(request: Request, response: Response): Promise<void> {
  const rewards = await rewardsService.listAll({ includeArchived: request.query.includeArchived === "true" });
  response.status(200).json({ rewards });
}

export async function adminUpdateReward(request: Request, response: Response): Promise<void> {
  const reason = requireAuditReason(request.body?.reason);
  const input = validateUpdateRewardInput(request.body);
  const { before, after } = await rewardsService.update(requireIdParam(request), input);
  await recordAudit({
    request,
    actorId: requireUserId(request),
    action: "reward.update",
    entityType: "Reward",
    entityId: after.id,
    reason,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: after as unknown as Record<string, unknown>,
  });
  response.status(200).json({ reward: after });
}

function stateHandler(action: "pause" | "resume" | "archive") {
  return async (request: Request, response: Response): Promise<void> => {
    const reason = requireAuditReason(request.body?.reason);
    const { before, after } = await rewardsService.setState(requireIdParam(request), action);
    await recordAudit({
      request,
      actorId: requireUserId(request),
      action: `reward.${action}`,
      entityType: "Reward",
      entityId: after.id,
      reason,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: after as unknown as Record<string, unknown>,
    });
    response.status(200).json({ reward: after });
  };
}
export const adminPauseReward = stateHandler("pause");
export const adminResumeReward = stateHandler("resume");
export const adminArchiveReward = stateHandler("archive");

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
