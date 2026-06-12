import { Router } from "express";

import { authenticate, optionalAuthenticate } from "../../middlewares/authenticate";
import { authRateLimiter } from "../../middlewares/rate-limit";
import { requireTurnstile } from "../../middlewares/turnstile";
import { asyncHandler } from "../../shared/utils/async-handler";
import { forgotPassword, login, me, register, resetPassword, switchRole, updateProfile, verifyEmail } from "./auth.controller";
import { sendOtp, verifyOtp } from "./otp.controller";

export const authRouter = Router();

authRouter.post("/register", authRateLimiter, requireTurnstile, asyncHandler(register));
authRouter.post("/login", authRateLimiter, asyncHandler(login));
authRouter.get("/me", authenticate, asyncHandler(me));
authRouter.patch("/me", authenticate, asyncHandler(updateProfile));
authRouter.post("/forgot-password", authRateLimiter, asyncHandler(forgotPassword));
authRouter.post("/reset-password", authRateLimiter, asyncHandler(resetPassword));
authRouter.post("/verify-email", authRateLimiter, asyncHandler(verifyEmail));
authRouter.post("/send-otp", authRateLimiter, optionalAuthenticate, asyncHandler(sendOtp));
authRouter.post("/verify-otp", authRateLimiter, optionalAuthenticate, asyncHandler(verifyOtp));
authRouter.post("/switch-role", authenticate, asyncHandler(switchRole));
