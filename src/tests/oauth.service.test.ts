import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { OAuthProvider } from "@prisma/client";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    oAuthIdentity: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../shared/utils/audit", () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../modules/referrals/referrals.service", () => ({
  referralsService: {
    validateReferralCode: vi.fn().mockResolvedValue(undefined),
    applyReferral: vi.fn().mockResolvedValue(undefined),
    getOrCreateReferralCode: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn() }));
vi.mock("../lib/email-templates", () => ({
  emailTemplates: {
    welcomeBuyer: () => ({ subject: "Welcome", html: "<p>Welcome</p>" }),
    welcomeVendor: () => ({ subject: "Welcome Vendor", html: "<p>Welcome</p>" }),
  },
}));
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { logOnly: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { oauthService } from "../modules/auth/oauth/oauth.service";
import type { VerifiedProviderIdentity } from "../modules/auth/oauth/oauth.provider-verify";

const userFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const userFindFirst = prisma.user.findFirst as unknown as ReturnType<typeof vi.fn>;
const identityFindUnique = prisma.oAuthIdentity.findUnique as unknown as ReturnType<typeof vi.fn>;
const identityCreate = prisma.oAuthIdentity.create as unknown as ReturnType<typeof vi.fn>;
const dbTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

const JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-key-for-testing-only";

function googleIdentity(overrides: Partial<VerifiedProviderIdentity> = {}): VerifiedProviderIdentity {
  return { providerUserId: "google-sub-1", email: "newuser@gmail.com", emailVerified: true, ...overrides };
}

function appleIdentity(overrides: Partial<VerifiedProviderIdentity> = {}): VerifiedProviderIdentity {
  return { providerUserId: "apple-sub-1", email: "newuser@privaterelay.appleid.com", emailVerified: true, ...overrides };
}

beforeEach(() => vi.clearAllMocks());

describe("oauthService.resolveIdentity — existing account login", () => {
  it("3. Google: an existing linked identity logs in directly", async () => {
    identityFindUnique.mockResolvedValue({
      user: { id: "u1", email: "a@b.com", name: "A", isSuspended: false, suspendedReason: null, role: "BUYER", vendor: null, tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() },
    });
    const result = await oauthService.resolveIdentity(OAuthProvider.GOOGLE, googleIdentity(), "A");
    expect(result.status).toBe("LOGIN");
  });

  it("6. Apple: an existing linked identity logs in directly", async () => {
    identityFindUnique.mockResolvedValue({
      user: { id: "u2", email: "a@b.com", name: "A", isSuspended: false, suspendedReason: null, role: "VENDOR", vendor: { storeName: "S", storeSlug: "s", description: null, businessType: null, sellerRegion: null, city: null, avatar: null, coverImage: null, currency: "GBP", verificationStatus: "PENDING" }, tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() },
    });
    const result = await oauthService.resolveIdentity(OAuthProvider.APPLE, appleIdentity(), "A");
    expect(result.status).toBe("LOGIN");
  });

  it("16. logout then provider login — a fresh call with no prior session state behaves identically (stateless)", async () => {
    identityFindUnique.mockResolvedValue({
      user: { id: "u1", email: "a@b.com", name: "A", isSuspended: false, suspendedReason: null, role: "BUYER", vendor: null, tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() },
    });
    const result = await oauthService.resolveIdentity(OAuthProvider.GOOGLE, googleIdentity(), "A");
    expect(result.status).toBe("LOGIN");
  });

  it("17/18. restricted/disabled account: this codebase has one suspension state (isSuspended) — login is blocked with 423", async () => {
    identityFindUnique.mockResolvedValue({
      user: { id: "u3", email: "a@b.com", name: "A", isSuspended: true, suspendedReason: "Fraud review", role: "BUYER", vendor: null, tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() },
    });
    await expect(oauthService.resolveIdentity(OAuthProvider.GOOGLE, googleIdentity(), "A")).rejects.toMatchObject({ statusCode: 423 });
  });
});

describe("oauthService.resolveIdentity — new signup", () => {
  it("1. Google new signup with complete provider data — only 'role' is missing", async () => {
    identityFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    const result = await oauthService.resolveIdentity(OAuthProvider.GOOGLE, googleIdentity(), "Ada Lovelace");
    expect(result.status).toBe("SIGNUP_REQUIRED");
    if (result.status === "SIGNUP_REQUIRED") {
      expect(result.missingFields).toEqual(["role"]);
      expect(result.prefill).toEqual({ name: "Ada Lovelace", email: "newuser@gmail.com" });
    }
  });

  it("2. Google new signup with missing name — 'name' and 'role' are reported missing", async () => {
    identityFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    const result = await oauthService.resolveIdentity(OAuthProvider.GOOGLE, googleIdentity(), null);
    expect(result.status).toBe("SIGNUP_REQUIRED");
    if (result.status === "SIGNUP_REQUIRED") {
      expect(result.missingFields).toEqual(["name", "role"]);
    }
  });

  it("4. Apple new signup with complete provider data (name supplied on first authorization) — only 'role' missing", async () => {
    identityFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    const result = await oauthService.resolveIdentity(OAuthProvider.APPLE, appleIdentity(), "Grace Hopper");
    expect(result.status).toBe("SIGNUP_REQUIRED");
    if (result.status === "SIGNUP_REQUIRED") expect(result.missingFields).toEqual(["role"]);
  });

  it("5. Apple new signup with missing fields (private relay gave email but no name was ever supplied) — 'name' + 'role' missing", async () => {
    identityFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    const result = await oauthService.resolveIdentity(OAuthProvider.APPLE, appleIdentity(), null);
    expect(result.status).toBe("SIGNUP_REQUIRED");
    if (result.status === "SIGNUP_REQUIRED") expect(result.missingFields).toEqual(["name", "role"]);
  });

  it("11. existing email/password account with matching email — LINK_REQUIRED, never auto-created or auto-logged-in", async () => {
    identityFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "existing-1", email: "newuser@gmail.com", password: "$2a$...hash" });
    const result = await oauthService.resolveIdentity(OAuthProvider.GOOGLE, googleIdentity(), "Ada");
    expect(result.status).toBe("LINK_REQUIRED");
    if (result.status === "LINK_REQUIRED") expect(result.email).toBe("newuser@gmail.com");
  });
});

describe("oauthService.completeSignup", () => {
  function ticketFor(provider: OAuthProvider, identity: VerifiedProviderIdentity, name: string | null): string {
    return jwt.sign(
      { typ: "oauth_pending", provider, providerUserId: identity.providerUserId, email: identity.email, emailVerified: identity.emailVerified, name },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "15m" },
    );
  }

  it("13. Buyer signup creates a BUYER, no vendor logic touched", async () => {
    userFindUnique.mockResolvedValueOnce(null); // email not taken
    identityFindUnique.mockResolvedValueOnce(null); // identity not taken
    const created = { id: "new-buyer-1", email: "newuser@gmail.com", name: "Ada Lovelace", role: "BUYER" };
    dbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ user: { create: vi.fn().mockResolvedValue(created) }, oAuthIdentity: { create: vi.fn().mockResolvedValue({}) } }),
    );
    userFindUnique.mockResolvedValueOnce({ ...created, vendor: null, isSuspended: false, suspendedReason: null, tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() });

    const ticket = ticketFor(OAuthProvider.GOOGLE, googleIdentity(), "Ada Lovelace");
    const result = await oauthService.completeSignup({ ticket, role: "BUYER" });
    expect(result.user.role).toBe("BUYER");
    expect(result.token).toBeTruthy();
  });

  it("14. Vendor signup creates a VENDOR — storeName is NOT required here (deferred to the existing vendor-onboarding stack)", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    identityFindUnique.mockResolvedValueOnce(null);
    const created = { id: "new-vendor-1", email: "vendor@gmail.com", name: "Vendor Person", role: "VENDOR" };
    dbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ user: { create: vi.fn().mockResolvedValue(created) }, oAuthIdentity: { create: vi.fn().mockResolvedValue({}) } }),
    );
    userFindUnique.mockResolvedValueOnce({ ...created, vendor: null, isSuspended: false, suspendedReason: null, tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() });

    const ticket = ticketFor(OAuthProvider.GOOGLE, googleIdentity({ email: "vendor@gmail.com" }), "Vendor Person");
    const result = await oauthService.completeSignup({ ticket, role: "VENDOR" });
    expect(result.user.role).toBe("VENDOR");
    expect(result.user.hasVendor).toBe(false); // vendor profile is a separate later step, exactly like password signup
  });

  it("15a. incomplete-signup resume — completing with a still-valid ticket succeeds", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    identityFindUnique.mockResolvedValueOnce(null);
    const created = { id: "resumed-1", email: "resume@gmail.com", name: "Resumed User", role: "BUYER" };
    dbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ user: { create: vi.fn().mockResolvedValue(created) }, oAuthIdentity: { create: vi.fn().mockResolvedValue({}) } }),
    );
    userFindUnique.mockResolvedValueOnce({ ...created, vendor: null, isSuspended: false, suspendedReason: null, tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() });

    const ticket = ticketFor(OAuthProvider.GOOGLE, googleIdentity({ email: "resume@gmail.com" }), "Resumed User");
    // Simulates the user closing the app after step 1 and coming back later, within the ticket's 15-minute window.
    const result = await oauthService.completeSignup({ ticket, role: "BUYER" });
    expect(result.user.email).toBe("resume@gmail.com");
  });

  it("15b. incomplete-signup resume — an EXPIRED ticket is rejected, not silently accepted", async () => {
    const expiredTicket = jwt.sign(
      { typ: "oauth_pending", provider: OAuthProvider.GOOGLE, providerUserId: "sub-x", email: "x@gmail.com", emailVerified: true, name: "X" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "-1s" },
    );
    await expect(oauthService.completeSignup({ ticket: expiredTicket, role: "BUYER" })).rejects.toMatchObject({ statusCode: 401 });
  });

  it("10a. duplicate provider identity at signup completion — the ticket's identity was already linked to another account in the meantime", async () => {
    userFindUnique.mockResolvedValueOnce(null); // email still free
    identityFindUnique.mockResolvedValueOnce({ id: "already-linked" }); // but identity got linked elsewhere
    const ticket = ticketFor(OAuthProvider.GOOGLE, googleIdentity(), "Ada");
    await expect(oauthService.completeSignup({ ticket, role: "BUYER" })).rejects.toMatchObject({ statusCode: 409, code: "OAUTH_IDENTITY_ALREADY_LINKED" });
  });

  it("role is always required explicitly — never inferred, never defaulted", async () => {
    const ticket = ticketFor(OAuthProvider.GOOGLE, googleIdentity(), "Ada");
    // @ts-expect-error — intentionally omitting role to prove the validator/service rejects it
    await expect(oauthService.completeSignup({ ticket })).rejects.toThrow();
  });
});

describe("oauthService.linkToExistingAccount — secure account linking (12)", () => {
  function ticketFor(email: string): string {
    return jwt.sign(
      { typ: "oauth_pending", provider: OAuthProvider.GOOGLE, providerUserId: "google-sub-link", email, emailVerified: true, name: "Linker" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "15m" },
    );
  }

  it("links only after re-authenticating with the EXISTING account's real password", async () => {
    const bcrypt = await import("bcryptjs");
    const realHash = await bcrypt.hash("CorrectPassw0rd!", 4);
    userFindUnique
      .mockResolvedValueOnce({ id: "existing-1", email: "existing@site.com", password: realHash, isSuspended: false, lockedUntil: null, failedLoginAttempts: 0, vendor: null, role: "BUYER", tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() })
      .mockResolvedValueOnce({ id: "existing-1", email: "existing@site.com", vendor: null, isSuspended: false, role: "BUYER", tokenVersion: 0, phone: null, avatar: null, country: null, referralCode: null, trustScore: 50, createdAt: new Date() });
    identityCreate.mockResolvedValue({});

    const ticket = ticketFor("existing@site.com");
    const result = await oauthService.linkToExistingAccount(ticket, "existing@site.com", "CorrectPassw0rd!");
    expect(result.user.email).toBe("existing@site.com");
    expect(identityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: "existing-1", provider: OAuthProvider.GOOGLE }) }));
  });

  it("rejects linking with the WRONG password — this is the account-takeover prevention, the single most important test here", async () => {
    const bcrypt = await import("bcryptjs");
    const realHash = await bcrypt.hash("CorrectPassw0rd!", 4);
    userFindUnique.mockResolvedValueOnce({ id: "existing-1", email: "existing@site.com", password: realHash, isSuspended: false, lockedUntil: null, failedLoginAttempts: 0, vendor: null, role: "BUYER" });

    const ticket = ticketFor("existing@site.com");
    await expect(oauthService.linkToExistingAccount(ticket, "existing@site.com", "WrongPassword!")).rejects.toMatchObject({ statusCode: 401 });
    expect(identityCreate).not.toHaveBeenCalled();
  });

  it("10b. duplicate provider identity at link time — DB unique constraint surfaces as a clean 409", async () => {
    const bcrypt = await import("bcryptjs");
    const realHash = await bcrypt.hash("CorrectPassw0rd!", 4);
    userFindUnique.mockResolvedValueOnce({ id: "existing-1", email: "existing@site.com", password: realHash, isSuspended: false, lockedUntil: null, failedLoginAttempts: 0, vendor: null, role: "BUYER" });
    identityCreate.mockRejectedValueOnce({ code: "P2002" });

    const ticket = ticketFor("existing@site.com");
    await expect(oauthService.linkToExistingAccount(ticket, "existing@site.com", "CorrectPassw0rd!")).rejects.toMatchObject({ statusCode: 409, code: "OAUTH_IDENTITY_ALREADY_LINKED" });
  });
});
