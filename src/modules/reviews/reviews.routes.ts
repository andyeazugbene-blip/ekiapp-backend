import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { createReview, listMyReviews, listReviews } from "./reviews.controller";

export const reviewsRouter = Router();

// Public: list approved reviews (no auth required)
reviewsRouter.get("/", asyncHandler(listReviews));

// Authenticated: list own reviews. Must be registered BEFORE /:id-style routes.
reviewsRouter.get("/me", authenticate, asyncHandler(listMyReviews));

// Community Buy Workstream 1 (universal account): every authenticated user
// can buy, so every authenticated user can review a genuine purchase —
// this is no longer gated on User.role. createReview() itself already
// enforces the real invariant (order.buyerId === caller, order actually
// reviewable, one review per order/product) — a role check on top of that
// only ever blocked a Vendor+Buyer identity from reviewing their own real
// purchase, which is exactly the "role trap" the universal account model
// removes.
reviewsRouter.post("/", authenticate, asyncHandler(createReview));
