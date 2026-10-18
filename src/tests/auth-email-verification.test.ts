/**
 * Real bug: a vendor who registered (session persisted immediately) but
 * closed the app before completing OTP reopened straight onto the
 * dashboard, never verified. Root cause chain:
 *  1. register() never recorded whether email verification was real.
 *  2. toAuthUser() never exposed it to the frontend at all.
 *  3. For the buyer flow (verify OTP BEFORE the account exists), the
 *     verification was silently lost — otp.service.ts's updateMany
 *     can't mark a row that doesn't exist yet.
 * These tests guard the fix: AuthUser.emailVerified is now real, and
 * register() checks for a recently-consumed pre-registration OTP.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  emailOtpFindFirst: vi.fn(),
  emailVerificationTokenCreate: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.userFindUnique, findFirst: m.userFindFirst, create: m.userCreate },
    emailOtp: { findFirst: m.emailOtpFindFirst },
    emailVerificationToken: { create: m.emailVerificationTokenCreate },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn() }));
vi.mock("../lib/email-templates", () => ({
  emailTemplates: { welcomeVendor: () => ({ subject: "", html: "" }), welcomeBuyer: () => ({ subject: "", html: "" }) },
}));
vi.mock("../modules/communications/communication.service", () => ({ communicationService: { logOnly: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../modules/referrals/referrals.service", () => ({
  referralsService: { validateReferralCode: vi.fn(), applyReferral: vi.fn(), getOrCreateReferralCode: vi.fn().mockResolvedValue("REF1") },
}));
vi.mock("../modules/events/events.service", () => ({ eventsService: { emit: vi.fn() }, EVENT_NAMES: { merchant_registered: "merchant_registered" } }));
vi.mock("../modules/vendors/vendors.service", () => ({ buildVendorShareUrl: () => "https://eki.app/store/x" }));

import { authService, toAuthUser } from "../modules/auth/auth.service";

const BASE_CREATED = {
  id: "u1", email: "new@test.local", name: "New User", password: "hash", phone: "+1000", country: "IE",
  role: "BUYER", createdAt: new Date(), trustScore: 50,
};

let createdRow: any = null;

beforeEach(() => {
  vi.clearAllMocks();
  createdRow = null;
  m.userFindUnique.mockImplementation(({ where }: any) => {
    if (where?.email) return Promise.resolve(null); // existing-email check
    // post-create reload, by id — reflects whatever create() actually set
    return Promise.resolve({ ...BASE_CREATED, isSuspended: false, suspendedReason: null, vendor: null, supplierAccount: null, emailVerifiedAt: null, ...createdRow });
  });
  m.userCreate.mockImplementation(({ data }: any) => {
    createdRow = data;
    return Promise.resolve({ ...BASE_CREATED, ...data });
  });
  m.userFindFirst.mockResolvedValue(null); // phone-availability check
  m.emailOtpFindFirst.mockResolvedValue(null);
  m.emailVerificationTokenCreate.mockResolvedValue({});
});

describe("register() — real email-verification state", () => {
  it("a fresh buyer signup with NO prior OTP is created unverified", async () => {

    const { user } = await authService.register({ email: "new@test.local", password: "Password1", name: "New User", phone: "+1000", country: "IE" } as any);

    expect(user.emailVerified).toBe(false);
    expect(m.userCreate.mock.calls[0][0].data).not.toHaveProperty("emailVerifiedAt");
  });

  it("a buyer who verified OTP BEFORE registering (the buyer flow) is created already verified", async () => {
    m.emailOtpFindFirst.mockResolvedValue({ id: "otp1", consumedAt: new Date() });

    const { user } = await authService.register({ email: "new@test.local", password: "Password1", name: "New User", phone: "+1000", country: "IE" } as any);

    expect(user.emailVerified).toBe(true);
    expect(m.userCreate.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(m.emailOtpFindFirst.mock.calls[0][0].where).toMatchObject({ email: "new@test.local", purpose: "buyer_signup_email" });
  });

  it("does not trust a stale consumed OTP outside the recency window", async () => {
    // findFirst itself is scoped by `consumedAt: { gte: ... }` — simulate
    // the DB correctly finding nothing for an old code by returning null.
    m.emailOtpFindFirst.mockResolvedValue(null);

    const { user } = await authService.register({ email: "new@test.local", password: "Password1", name: "New User", phone: "+1000", country: "IE" } as any);

    expect(user.emailVerified).toBe(false);
    const call = m.emailOtpFindFirst.mock.calls[0][0];
    expect(call.where.consumedAt.gte).toBeInstanceOf(Date);
  });
});

describe("toAuthUser() — emailVerified derivation", () => {
  it("is true for an OAuth-only account (no password) regardless of emailVerifiedAt", () => {
    const user = toAuthUser({
      id: "u2", email: "oauth@test.local", name: "OAuth User", phone: null, avatar: null, country: null,
      referralCode: null, isSuspended: false, suspendedReason: null, role: "BUYER" as any, trustScore: 50,
      createdAt: new Date(), emailVerifiedAt: null, password: null, vendor: null, supplierAccount: null,
    });
    expect(user.emailVerified).toBe(true);
  });

  it("is false for an email/password account that never verified", () => {
    const user = toAuthUser({
      id: "u3", email: "pw@test.local", name: "PW User", phone: null, avatar: null, country: null,
      referralCode: null, isSuspended: false, suspendedReason: null, role: "BUYER" as any, trustScore: 50,
      createdAt: new Date(), emailVerifiedAt: null, password: "hash", vendor: null, supplierAccount: null,
    });
    expect(user.emailVerified).toBe(false);
  });

  it("is true once emailVerifiedAt is set", () => {
    const user = toAuthUser({
      id: "u4", email: "verified@test.local", name: "Verified User", phone: null, avatar: null, country: null,
      referralCode: null, isSuspended: false, suspendedReason: null, role: "VENDOR" as any, trustScore: 50,
      createdAt: new Date(), emailVerifiedAt: new Date(), password: "hash", vendor: null, supplierAccount: null,
    });
    expect(user.emailVerified).toBe(true);
  });
});
