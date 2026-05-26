import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { reviewsService } from "./reviews.service";
import {
  validateAdminListReviewsQuery,
  validateCreateReviewInput,
  validateListReviewsQuery,
  validateModerateReviewInput,
} from "./reviews.validation";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function createReview(request: Request, response: Response): Promise<void> {
  const input = validateCreateReviewInput(request.body);
  const review = await reviewsService.createReview(requireUserId(request), input);
  response.status(201).json({ review });
}

export async function listReviews(request: Request, response: Response): Promise<void> {
  const query = validateListReviewsQuery(request.query as Record<string, unknown>);
  const result = await reviewsService.listPublicReviews(query);
  response.status(200).json(result);
}

export async function listMyReviews(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100);
  const cursor = typeof request.query.cursor === "string" ? request.query.cursor : undefined;
  const result = await reviewsService.listMyReviews(userId, { limit, cursor });
  response.status(200).json(result);
}

export async function adminListReviews(request: Request, response: Response): Promise<void> {
  const query = validateAdminListReviewsQuery(request.query as Record<string, unknown>);
  const result = await reviewsService.adminListReviews(query);
  response.status(200).json(result);
}

export async function adminModerateReview(request: Request, response: Response): Promise<void> {
  const reviewId = String(request.params.id ?? "");
  if (!reviewId) throw new AppError("Invalid review id", 400);
  const input = validateModerateReviewInput(request.body);
  const review = await reviewsService.moderateReview(reviewId, requireUserId(request), input);
  response.status(200).json({ review });
}
