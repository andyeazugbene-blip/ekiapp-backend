import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import jwt from "jsonwebtoken";

// Real RS256 keypair generated once for these tests — proves the actual
// signature-verification code path works, not just that a mock says so.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const OTHER_KEYPAIR = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let signingKeyBehavior: "ok" | "fetch_error" = "ok";

vi.mock("jwks-rsa", () => ({
  default: () => ({
    getSigningKey: (_kid: string, cb: (err: unknown, key: unknown) => void) => {
      if (signingKeyBehavior === "fetch_error") {
        cb(new Error("JWKS endpoint unreachable"), null);
        return;
      }
      cb(null, { getPublicKey: () => publicKey });
    },
  }),
}));

import { verifyAppleIdentityToken, verifyGoogleIdToken } from "../modules/auth/oauth/oauth.provider-verify";

function signToken(payload: Record<string, unknown>, key = privateKey): string {
  return jwt.sign(payload, key, { algorithm: "RS256", header: { kid: "test-kid" } });
}

beforeEach(() => { signingKeyBehavior = "ok"; });

describe("verifyGoogleIdToken", () => {
  const GOOGLE_CLIENT_IDS = ["ios-client-id.apps.googleusercontent.com"];

  it("accepts a genuinely valid, correctly-signed token", async () => {
    const token = signToken({
      iss: "https://accounts.google.com",
      aud: "ios-client-id.apps.googleusercontent.com",
      sub: "google-sub-123",
      email: "user@gmail.com",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await verifyGoogleIdToken(token, GOOGLE_CLIENT_IDS);
    expect(result).toEqual({ providerUserId: "google-sub-123", email: "user@gmail.com", emailVerified: true });
  });

  it("9. rejects a token signed with the WRONG key (forged/tampered) — real RS256 signature check, not a mock pass-through", async () => {
    const forgedToken = signToken(
      { iss: "https://accounts.google.com", aud: "ios-client-id.apps.googleusercontent.com", sub: "attacker-sub", email: "attacker@gmail.com", exp: Math.floor(Date.now() / 1000) + 3600 },
      OTHER_KEYPAIR.privateKey,
    );
    await expect(verifyGoogleIdToken(forgedToken, GOOGLE_CLIENT_IDS)).rejects.toMatchObject({ statusCode: 401, code: "OAUTH_TOKEN_INVALID" });
  });

  it("9b. rejects a token with the wrong audience (issued for a different app)", async () => {
    const token = signToken({ iss: "https://accounts.google.com", aud: "someone-elses-app.apps.googleusercontent.com", sub: "sub-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    await expect(verifyGoogleIdToken(token, GOOGLE_CLIENT_IDS)).rejects.toMatchObject({ statusCode: 401, code: "OAUTH_TOKEN_INVALID" });
  });

  it("9c. rejects a token with the wrong issuer", async () => {
    const token = signToken({ iss: "https://evil.example.com", aud: "ios-client-id.apps.googleusercontent.com", sub: "sub-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    await expect(verifyGoogleIdToken(token, GOOGLE_CLIENT_IDS)).rejects.toMatchObject({ statusCode: 401, code: "OAUTH_TOKEN_INVALID" });
  });

  it("rejects an expired token", async () => {
    const token = signToken({ iss: "https://accounts.google.com", aud: "ios-client-id.apps.googleusercontent.com", sub: "sub-1", exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifyGoogleIdToken(token, GOOGLE_CLIENT_IDS)).rejects.toMatchObject({ statusCode: 401, code: "OAUTH_TOKEN_INVALID" });
  });

  it("8. provider error — JWKS endpoint unreachable surfaces as a clean 401, not a raw crash", async () => {
    signingKeyBehavior = "fetch_error";
    const token = signToken({ iss: "https://accounts.google.com", aud: "ios-client-id.apps.googleusercontent.com", sub: "sub-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    await expect(verifyGoogleIdToken(token, GOOGLE_CLIENT_IDS)).rejects.toMatchObject({ statusCode: 401, code: "OAUTH_VERIFY_FAILED" });
  });

  it("fails closed (503) when Google Sign-In has no configured client IDs at all", async () => {
    const token = signToken({ iss: "https://accounts.google.com", aud: "x", sub: "sub-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    await expect(verifyGoogleIdToken(token, [])).rejects.toMatchObject({ statusCode: 503, code: "OAUTH_PROVIDER_NOT_CONFIGURED" });
  });

  it("9d. rejects a structurally malformed token (not a JWT at all)", async () => {
    await expect(verifyGoogleIdToken("not-a-real-jwt", GOOGLE_CLIENT_IDS)).rejects.toMatchObject({ statusCode: 400, code: "OAUTH_TOKEN_MALFORMED" });
  });
});

describe("verifyAppleIdentityToken", () => {
  const BUNDLE_ID = "com.ekiapp.mobilee";

  it("accepts a genuinely valid, correctly-signed token, including Apple private relay email", async () => {
    const token = signToken({
      iss: "https://appleid.apple.com",
      aud: BUNDLE_ID,
      sub: "apple-sub-456",
      email: "abc123@privaterelay.appleid.com",
      email_verified: "true", // Apple sometimes sends this as a string
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await verifyAppleIdentityToken(token, BUNDLE_ID);
    expect(result).toEqual({ providerUserId: "apple-sub-456", email: "abc123@privaterelay.appleid.com", emailVerified: true });
  });

  it("9. rejects a forged/tampered Apple token", async () => {
    const forged = signToken({ iss: "https://appleid.apple.com", aud: BUNDLE_ID, sub: "attacker", exp: Math.floor(Date.now() / 1000) + 3600 }, OTHER_KEYPAIR.privateKey);
    await expect(verifyAppleIdentityToken(forged, BUNDLE_ID)).rejects.toMatchObject({ statusCode: 401, code: "OAUTH_TOKEN_INVALID" });
  });

  it("rejects a token whose aud doesn't match the app's bundle identifier", async () => {
    const token = signToken({ iss: "https://appleid.apple.com", aud: "com.someone.else", sub: "sub-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    await expect(verifyAppleIdentityToken(token, BUNDLE_ID)).rejects.toMatchObject({ statusCode: 401, code: "OAUTH_TOKEN_INVALID" });
  });

  it("fails closed (503) when Apple Sign-In has no configured bundle ID", async () => {
    const token = signToken({ iss: "https://appleid.apple.com", aud: "x", sub: "sub-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    await expect(verifyAppleIdentityToken(token, "")).rejects.toMatchObject({ statusCode: 503, code: "OAUTH_PROVIDER_NOT_CONFIGURED" });
  });
});
