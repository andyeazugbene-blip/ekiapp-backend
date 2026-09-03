import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

import { AppError } from "../../../shared/errors/app-error";
import { logger } from "../../../lib/logger";

/**
 * Server-side verification of Google/Apple identity tokens via each
 * provider's published JWKS — no client secret or private key needed for
 * this (login-only) flow. This is the ONLY source of truth for provider
 * identity: providerUserId and email below come exclusively from the
 * verified token payload, never from any other field the client sends.
 */

export interface VerifiedProviderIdentity {
  providerUserId: string; // the token's `sub` — stable, opaque, never the email
  email: string | null;
  emailVerified: boolean;
}

const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const APPLE_JWKS_URI = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

const googleJwks = jwksClient({ jwksUri: GOOGLE_JWKS_URI, cache: true, cacheMaxAge: 3600_000, rateLimit: true });
const appleJwks = jwksClient({ jwksUri: APPLE_JWKS_URI, cache: true, cacheMaxAge: 3600_000, rateLimit: true });

function getSigningKey(client: jwksClient.JwksClient, kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err || !key) {
        reject(err ?? new Error("No signing key found"));
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

function decodeHeaderKid(token: string): string {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && typeof decoded === "object" ? decoded.header?.kid : undefined;
  if (!decoded || typeof decoded !== "object" || !kid) {
    throw new AppError("Malformed provider token", 400, undefined, "OAUTH_TOKEN_MALFORMED");
  }
  return kid;
}

/**
 * Verify a Google ID token. `allowedAudiences` should list every configured
 * GOOGLE_*_CLIENT_ID (iOS/Android/Web) — the token's `aud` must match one of
 * them, since a native Google Sign-In request is issued against a specific
 * client ID depending on platform.
 */
export async function verifyGoogleIdToken(idToken: string, allowedAudiences: string[]): Promise<VerifiedProviderIdentity> {
  if (allowedAudiences.length === 0) {
    throw new AppError("Google Sign-In is not configured", 503, undefined, "OAUTH_PROVIDER_NOT_CONFIGURED");
  }
  const kid = decodeHeaderKid(idToken);
  let publicKey: string;
  try {
    publicKey = await getSigningKey(googleJwks, kid);
  } catch (error) {
    logger.warn("Google JWKS key fetch failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    throw new AppError("Could not verify Google identity", 401, undefined, "OAUTH_VERIFY_FAILED");
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(idToken, publicKey, { algorithms: ["RS256"] }) as jwt.JwtPayload;
  } catch {
    throw new AppError("Invalid or expired Google token", 401, undefined, "OAUTH_TOKEN_INVALID");
  }

  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
    throw new AppError("Invalid Google token issuer", 401, undefined, "OAUTH_TOKEN_INVALID");
  }
  const aud = typeof payload.aud === "string" ? payload.aud : undefined;
  if (!aud || !allowedAudiences.includes(aud)) {
    throw new AppError("Google token was not issued for this app", 401, undefined, "OAUTH_TOKEN_INVALID");
  }
  if (!payload.sub) {
    throw new AppError("Google token missing subject", 401, undefined, "OAUTH_TOKEN_INVALID");
  }

  return {
    providerUserId: payload.sub,
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
  };
}

/**
 * Verify an Apple identity token. `bundleId` is the app's iOS bundle
 * identifier — for native Sign in with Apple (expo-apple-authentication)
 * the token's `aud` is the bundle ID directly, no separate Services ID.
 */
export async function verifyAppleIdentityToken(identityToken: string, bundleId: string): Promise<VerifiedProviderIdentity> {
  if (!bundleId) {
    throw new AppError("Apple Sign-In is not configured", 503, undefined, "OAUTH_PROVIDER_NOT_CONFIGURED");
  }
  const kid = decodeHeaderKid(identityToken);
  let publicKey: string;
  try {
    publicKey = await getSigningKey(appleJwks, kid);
  } catch (error) {
    logger.warn("Apple JWKS key fetch failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    throw new AppError("Could not verify Apple identity", 401, undefined, "OAUTH_VERIFY_FAILED");
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(identityToken, publicKey, { algorithms: ["RS256"] }) as jwt.JwtPayload;
  } catch {
    throw new AppError("Invalid or expired Apple token", 401, undefined, "OAUTH_TOKEN_INVALID");
  }

  if (payload.iss !== APPLE_ISSUER) {
    throw new AppError("Invalid Apple token issuer", 401, undefined, "OAUTH_TOKEN_INVALID");
  }
  if (payload.aud !== bundleId) {
    throw new AppError("Apple token was not issued for this app", 401, undefined, "OAUTH_TOKEN_INVALID");
  }
  if (!payload.sub) {
    throw new AppError("Apple token missing subject", 401, undefined, "OAUTH_TOKEN_INVALID");
  }

  // Apple sets email_verified as either a boolean or the string "true"
  // depending on token version — normalize both.
  const emailVerifiedRaw = (payload as Record<string, unknown>).email_verified;
  return {
    providerUserId: payload.sub,
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
    emailVerified: emailVerifiedRaw === true || emailVerifiedRaw === "true",
  };
}
