import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createReview, listMyReviews, listReviews } from "./reviews.controller";

export const reviewsRouter = Router();

// Public: list approved reviews (no auth required)
reviewsRouter.get("/", asyncHandler(listReviews));

// Authenticated: list own reviews. Must be registered BEFORE /:id-style routes.
reviewsRouter.get("/me", authenticate, asyncHandler(listMyReviews));

// Authenticated: create a review
reviewsRouter.post("/", authenticate, asyncHandler(createReview));
