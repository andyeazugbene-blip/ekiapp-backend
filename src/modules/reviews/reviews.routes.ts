import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createReview, listMyReviews, listReviews } from "./reviews.controller";

export const reviewsRouter = Router();

// Public: list approved reviews (no auth required)
reviewsRouter.get("/", asyncHandler(listReviews));

// Authenticated: list own reviews. Must be registered BEFORE /:id-style routes.
reviewsRouter.get("/me", authenticate, asyncHandler(listMyReviews));

// Authenticated BUYER only: create a review.
// VENDOR/ADMIN cannot create reviews against products (would be a conflict of interest
// and is not what the mobile app supports).
reviewsRouter.post("/", authenticate, requireRole("BUYER"), asyncHandler(createReview));
