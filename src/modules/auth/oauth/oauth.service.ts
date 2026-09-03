import jwt from "jsonwebtoken";
import { OAuthProvider, UserRole } from "@prisma/client";

import { env } from "../../../config/env";
import { prisma } from "../../../lib/prisma";
import { AppError } from "../../../shared/errors/app-error";
import { recordAudit } from "../../../shared/utils/audit";
import { normalizePhoneNumber } from "../../../shared/utils/phone";
import { authService, toAuthUser } from "../auth.service";
import { referralsService } from "../../referrals/referrals.service";
import { enqueueEmail } from "../../../lib/email-queue";
import { emailTemplates } from "../../../lib/email-templates";
import { communicationService } from "../../communications/communication.service";
import type { VerifiedProviderIdentity } from "./oauth.provider-verify";

const REGISTRATION_TICKET_EXPIRY = "15m";
const TICKET_TYP = "oauth_pending";

interface RegistrationTicketPayload {
  typ: typeof TICKET_TYP;
  provider: OAuthProvider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export type OAuthOutcome =
  | { status: "LOGIN"; user: ReturnType<typeof toAuthUser>; token: string }
  | { status: "LINK_REQUIRED"; ticket: string; email: string }
  | { status: "SIGNUP_REQUIRED"; ticket: string; prefill: { name: string | null; email: string | null }; missingFields: string[] };

function signRegistrationTicket(identity: VerifiedProviderIdentity, provider: OAuthProvider, name: string | null): string {
  const payload: RegistrationTicketPayload = {
    typ: TICKET_TYP,
    provider,
    providerUserId: identity.providerUserId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    name,
  };
  // A distinct `typ` claim plus the complete absence of `sub`/`role`/`tv`
  // means this can never be mistaken for (or misused as) a real session
  // token by the `authenticate` middleware — verifyToken() would parse it
  // fine (same secret) but `payload.sub` is undefined, so any attempt to
  // use it as a Bearer token fails at the tokenVersion lookup.
  return jwt.sign(payload as object, env.jwtSecret, { algorithm: "HS256", expiresIn: REGISTRATION_TICKET_EXPIRY });
}

function verifyRegistrationTicket(ticket: string): RegistrationTicketPayload {
  let payload: unknown;
  try {
    payload = jwt.verify(ticket, env.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    throw new AppError("Sign-up session expired. Please continue with Google/Apple again.", 401, undefined, "OAUTH_TICKET_EXPIRED");
  }
  if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).typ !== TICKET_TYP) {
    throw new AppError("Invalid sign-up session", 400, undefined, "OAUTH_TICKET_INVALID");
  }
  return payload as RegistrationTicketPayload;
}

async function assertAccountLoginable(user: { id: string; isSuspended: boolean; suspendedReason: string | null }): Promise<void> {
  if (user.isSuspended) {
    await recordAudit({ actorId: user.id, action: "LOGIN_BLOCKED_SUSPENDED", entityType: "User", entityId: user.id, metadata: { reason: user.suspendedReason ?? null, via: "oauth" } });
    throw new AppError("Your account has been suspended. Contact support.", 423);
  }
}

/**
 * Step 1 — the client already has a verified provider identity (caller has
 * called verifyGoogleIdToken/verifyAppleIdentityToken before this). Decides
 * which of the three states this identity is in.
 */
export const oauthService = {
  async resolveIdentity(provider: OAuthProvider, identity: VerifiedProviderIdentity, providerName: string | null): Promise<OAuthOutcome> {
    const existingLink = await prisma.oAuthIdentity.findUnique({
      where: { provider_providerUserId: { provider, providerUserId: identity.providerUserId } },
      include: { user: { include: { vendor: true } } },
    });

    if (existingLink) {
      await assertAccountLoginable(existingLink.user);
      const token = authService.signTokenPublic(existingLink.user);
      await recordAudit({ actorId: existingLink.user.id, action: "LOGIN_SUCCESS", entityType: "User", entityId: existingLink.user.id, metadata: { via: "oauth", provider } });
      return { status: "LOGIN", user: toAuthUser(existingLink.user), token };
    }

    // No link for this provider identity. If the verified email matches an
    // existing Eki account, this is a linking decision — NEVER auto-link.
    if (identity.email) {
      const existingUser = await prisma.user.findUnique({ where: { email: identity.email } });
      if (existingUser) {
        const ticket = signRegistrationTicket(identity, provider, providerName);
        return { status: "LINK_REQUIRED", ticket, email: existingUser.email };
      }
    }

    // Genuinely new — issue a signed, short-lived registration ticket.
    // Everything the completion step trusts about provider identity comes
    // from re-verifying THIS ticket, never from client-submitted fields.
    const ticket = signRegistrationTicket(identity, provider, providerName);
    const missingFields: string[] = [];
    if (!providerName) missingFields.push("name");
    if (!identity.email) missingFields.push("email");
    missingFields.push("role"); // architecture requirement: never inferred, always explicit

    return { status: "SIGNUP_REQUIRED", ticket, prefill: { name: providerName, email: identity.email }, missingFields };
  },

  /**
   * Step 2a — user proved ownership of an existing Eki account (password
   * verified via authService.login) and now the provider identity from the
   * ticket is linked to it. This is the only path that creates an
   * OAuthIdentity row for a pre-existing user.
   */
  async linkToExistingAccount(ticket: string, email: string, password: string): Promise<{ user: ReturnType<typeof toAuthUser>; token: string }> {
    const payload = verifyRegistrationTicket(ticket);
    // authService.login() re-validates credentials AND re-checks
    // suspension/lockout — the exact same gate as normal password login,
    // so this can't be used to bypass any of that.
    const { user: loggedInUser } = await authService.login({ email, password });
    if (loggedInUser.email !== payload.email && email.toLowerCase().trim() !== payload.email) {
      // Defense in depth: the email the user authenticated with must be
      // the same one the ticket was issued for — otherwise this becomes a
      // generic "log in as anyone, link my provider to them" primitive.
      throw new AppError("This sign-in does not match the account this link was started for.", 403, undefined, "OAUTH_LINK_EMAIL_MISMATCH");
    }

    try {
      await prisma.oAuthIdentity.create({
        data: { provider: payload.provider, providerUserId: payload.providerUserId, userId: loggedInUser.id, email: payload.email },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") {
        throw new AppError("This provider account is already linked to another Eki account.", 409, undefined, "OAUTH_IDENTITY_ALREADY_LINKED");
      }
      throw error;
    }

    await recordAudit({ actorId: loggedInUser.id, action: "OAUTH_ACCOUNT_LINKED", entityType: "User", entityId: loggedInUser.id, metadata: { provider: payload.provider } });

    const fullUser = await prisma.user.findUnique({ where: { id: loggedInUser.id }, include: { vendor: true } });
    const token = authService.signTokenPublic(fullUser!);
    return { user: toAuthUser(fullUser!), token };
  },

  /**
   * Step 2b — genuinely new account. `role` must be explicit (never
   * defaulted) per the architecture requirement that Google/Apple never
   * implies Buyer/Vendor.
   *
   * Mirrors exactly what password-based vendor registration already does:
   * register.tsx's vendor branch creates the User with role VENDOR and
   * nothing else, then hands off to the existing /(vendor-onboarding)
   * stack (setup-store, business-info, ...) for storeName and everything
   * vendor-specific. This does the same — no parallel vendor-creation
   * logic, no storeName collected here.
   */
  async completeSignup(input: {
    ticket: string;
    name?: string;
    email?: string;
    phone?: string;
    country?: string;
    role: "BUYER" | "VENDOR";
    referralCode?: string;
  }): Promise<{ user: ReturnType<typeof toAuthUser>; token: string }> {
    const payload = verifyRegistrationTicket(input.ticket);

    const name = (payload.name ?? input.name ?? "").trim();
    if (!name) throw new AppError("Name is required", 400);

    const email = (payload.email ?? input.email ?? "").toLowerCase().trim();
    if (!email) throw new AppError("Email is required", 400);

    if (input.role !== "BUYER" && input.role !== "VENDOR") {
      throw new AppError("role must be BUYER or VENDOR", 400);
    }

    const phone = input.phone?.trim() ? normalizePhoneNumber(input.phone, "phone") : undefined;
    if (phone) {
      const phoneTaken = await prisma.user.findFirst({ where: { phone }, select: { id: true } });
      if (phoneTaken) throw new AppError("Phone already registered", 409);
    }

    // Re-check both uniqueness constraints right before creating — the
    // ticket can be up to 15 minutes old, so another registration could
    // have landed on this email/provider-identity in the meantime.
    const emailTaken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (emailTaken) throw new AppError("Email already registered", 409, undefined, "OAUTH_EMAIL_NOW_TAKEN");
    const identityTaken = await prisma.oAuthIdentity.findUnique({
      where: { provider_providerUserId: { provider: payload.provider, providerUserId: payload.providerUserId } },
    });
    if (identityTaken) throw new AppError("This provider account is already linked to an Eki account.", 409, undefined, "OAUTH_IDENTITY_ALREADY_LINKED");

    if (input.referralCode) {
      await referralsService.validateReferralCode(input.referralCode);
    }

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name,
          password: null,
          phone,
          country: input.country?.trim() || undefined,
          role: input.role === "VENDOR" ? UserRole.VENDOR : UserRole.BUYER,
          emailVerifiedAt: payload.emailVerified ? new Date() : null,
        },
      });
      await tx.oAuthIdentity.create({
        data: { provider: payload.provider, providerUserId: payload.providerUserId, userId: created.id, email: payload.email },
      });
      return created;
    });

    if (input.referralCode) {
      await referralsService.applyReferral(user.id, input.referralCode).catch(() => {});
    }
    await referralsService.getOrCreateReferralCode(user.id).catch(() => {});

    const welcome = input.role === "VENDOR" ? emailTemplates.welcomeVendor({ name }) : emailTemplates.welcomeBuyer({ name });
    enqueueEmail({ to: email, subject: welcome.subject, html: welcome.html });
    communicationService.logOnly({
      recipientId: user.id,
      recipientType: input.role === "VENDOR" ? "VENDOR" : "BUYER",
      eventKey: input.role === "VENDOR" ? "welcome_vendor" : "welcome_buyer",
      channel: "email",
      title: welcome.subject,
      body: `Welcome email sent to ${email}`,
    }).catch(() => {});

    await recordAudit({ actorId: user.id, action: "OAUTH_SIGNUP", entityType: "User", entityId: user.id, metadata: { provider: payload.provider, role: input.role } });

    const fullUser = await prisma.user.findUnique({ where: { id: user.id }, include: { vendor: true } });
    const token = authService.signTokenPublic(fullUser!);
    return { user: toAuthUser(fullUser!), token };
  },
};
