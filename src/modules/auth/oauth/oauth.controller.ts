import type { Request, Response } from "express";
import { OAuthProvider } from "@prisma/client";

import { env } from "../../../config/env";
import { verifyAppleIdentityToken, verifyGoogleIdToken } from "./oauth.provider-verify";
import { oauthService } from "./oauth.service";
import { validateCompleteSignupInput, validateLinkInput, validateProviderTokenInput } from "./oauth.validation";

export async function continueWithGoogle(request: Request, response: Response): Promise<void> {
  const { idToken, name } = validateProviderTokenInput(request.body);
  const identity = await verifyGoogleIdToken(idToken, env.googleClientIds);
  const outcome = await oauthService.resolveIdentity(OAuthProvider.GOOGLE, identity, name ?? null);
  response.status(200).json(outcome);
}

export async function continueWithApple(request: Request, response: Response): Promise<void> {
  const { idToken, name } = validateProviderTokenInput(request.body);
  const identity = await verifyAppleIdentityToken(idToken, env.appleBundleId);
  const outcome = await oauthService.resolveIdentity(OAuthProvider.APPLE, identity, name ?? null);
  response.status(200).json(outcome);
}

export async function linkOAuthAccount(request: Request, response: Response): Promise<void> {
  const input = validateLinkInput(request.body);
  const result = await oauthService.linkToExistingAccount(input.ticket, input.email, input.password);
  response.status(200).json(result);
}

export async function completeOAuthSignup(request: Request, response: Response): Promise<void> {
  const input = validateCompleteSignupInput(request.body);
  const result = await oauthService.completeSignup(input);
  response.status(201).json(result);
}
