import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { authRateLimiter } from "../../middlewares/rate-limit";
import { asyncHandler } from "../../shared/utils/async-handler";
import { forgotPassword, login, me, register, resetPassword, updateProfile } from "./auth.controller";

export const authRouter = Router();

authRouter.post("/register", authRateLimiter, asyncHandler(register));
authRouter.post("/login", authRateLimiter, asyncHandler(login));
authRouter.get("/me", authenticate, asyncHandler(me));
authRouter.patch("/me", authenticate, asyncHandler(updateProfile));
authRouter.post("/forgot-password", authRateLimiter, asyncHandler(forgotPassword));
authRouter.post("/reset-password", authRateLimiter, asyncHandler(resetPassword));
