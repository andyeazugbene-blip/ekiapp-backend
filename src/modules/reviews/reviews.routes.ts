import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createReview, listReviews } from "./reviews.controller";

export const reviewsRouter = Router();

// Public: list approved reviews (no auth required)
reviewsRouter.get("/", asyncHandler(listReviews));

// Authenticated: create a review
reviewsRouter.post("/", authenticate, asyncHandler(createReview));
