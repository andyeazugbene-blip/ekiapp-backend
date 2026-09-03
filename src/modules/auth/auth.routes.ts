import { Router } from "express";

import { authenticate, optionalAuthenticate } from "../../middlewares/authenticate";
import { authRateLimiter } from "../../middlewares/rate-limit";
import { requireTurnstile } from "../../middlewares/turnstile";
import { asyncHandler } from "../../shared/utils/async-handler";
import { forgotPassword, login, me, register, resetPassword, switchRole, updateProfile, vendorPortalLogin, verifyEmail } from "./auth.controller";
import { sendOtp, verifyOtp } from "./otp.controller";
import { completeOAuthSignup, continueWithApple, continueWithGoogle, linkOAuthAccount } from "./oauth/oauth.controller";

export const authRouter = Router();

authRouter.post("/register", authRateLimiter, requireTurnstile, asyncHandler(register));
authRouter.post("/login", authRateLimiter, asyncHandler(login));
authRouter.post("/vendor-portal-login", authRateLimiter, asyncHandler(vendorPortalLogin));
authRouter.get("/me", authenticate, asyncHandler(me));
authRouter.patch("/me", authenticate, asyncHandler(updateProfile));
authRouter.post("/forgot-password", authRateLimiter, asyncHandler(forgotPassword));
authRouter.post("/reset-password", authRateLimiter, asyncHandler(resetPassword));
authRouter.post("/verify-email", authRateLimiter, asyncHandler(verifyEmail));
authRouter.post("/send-otp", authRateLimiter, optionalAuthenticate, asyncHandler(sendOtp));
authRouter.post("/verify-otp", authRateLimiter, optionalAuthenticate, asyncHandler(verifyOtp));
authRouter.post("/switch-role", authenticate, asyncHandler(switchRole));

// Google/Apple Sign-In (docs/decisions/0008). Rate-limited like every
// other auth entry point; no Turnstile — provider-verified token
// possession is a stronger signal than a captcha, and requireTurnstile
// already no-ops for native app requests anyway (see turnstile.ts).
authRouter.post("/oauth/google", authRateLimiter, asyncHandler(continueWithGoogle));
authRouter.post("/oauth/apple", authRateLimiter, asyncHandler(continueWithApple));
authRouter.post("/oauth/link", authRateLimiter, asyncHandler(linkOAuthAccount));
authRouter.post("/oauth/complete-signup", authRateLimiter, asyncHandler(completeOAuthSignup));
