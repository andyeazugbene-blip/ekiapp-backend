import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { contentReviewService, MODERATION_ACTIONS, type ModerationAction, type ReviewTab } from "./content-review.service";

const TABS: ReviewTab[] = ["flagged", "failed", "suspicious", "reported", "history"];

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function getContentReviewCounts(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.json(await contentReviewService.counts());
}

export async function listContentReviewQueue(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  const tab = (str(request.query.tab) ?? "flagged") as ReviewTab;
  if (!TABS.includes(tab)) throw new AppError(`tab must be one of: ${TABS.join(", ")}`, 400);
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  response.json(await contentReviewService.queue({
    tab,
    q: str(request.query.q),
    category: str(request.query.category),
    cursor: str(request.query.cursor),
    limit: Number.isFinite(limit) ? limit : undefined,
  }));
}

export async function listIdentityDocuments(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  response.json(await contentReviewService.identityDocuments({
    q: str(request.query.q),
    cursor: str(request.query.cursor),
    limit: Number.isFinite(limit) ? limit : undefined,
  }));
}

export async function getContentAsset(request: Request, response: Response): Promise<void> {
  requireUserId(request);
  response.json(await contentReviewService.getAsset(String(request.params.id)));
}

export async function getContentReadUrl(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  response.json(await contentReviewService.readUrl(String(request.params.id), actorId, request));
}

export async function moderateContentAsset(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const action = String(request.params.action ?? "").replace("-", "_") as ModerationAction;
  if (!MODERATION_ACTIONS.includes(action)) throw new AppError(`action must be one of: ${MODERATION_ACTIONS.join(", ")}`, 400);
  const reason = typeof request.body?.reason === "string" ? request.body.reason : "";
  const reportId = str(request.body?.reportId);
  response.json(await contentReviewService.decide(String(request.params.id), action, actorId, reason, request, { reportId }));
}
