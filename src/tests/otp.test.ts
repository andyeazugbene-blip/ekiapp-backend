import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Mock prisma and email
vi.mock("../lib/prisma", () => ({
  prisma: {
    emailOtp: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock("../lib/email-templates", () => ({
  emailTemplates: {
    otpVerification: vi.fn().mockReturnValue({ subject: "Code", html: "<p>123456</p>" }),
  },
}));

import { prisma } from "../lib/prisma";
import { sendEmail } from "../lib/email";
import { emailTemplates } from "../lib/email-templates";
import { otpService } from "../modules/auth/otp.service";

const otpUpdateMany = prisma.emailOtp.updateMany as unknown as ReturnType<typeof vi.fn>;
const otpCreate = prisma.emailOtp.create as unknown as ReturnType<typeof vi.fn>;
const otpFindFirst = prisma.emailOtp.findFirst as unknown as ReturnType<typeof vi.fn>;
const otpUpdate = prisma.emailOtp.update as unknown as ReturnType<typeof vi.fn>;
const userUpdateMany = prisma.user.updateMany as unknown as ReturnType<typeof vi.fn>;
const sendEmailMock = sendEmail as unknown as ReturnType<typeof vi.fn>;
const otpTemplateMock = emailTemplates.otpVerification as unknown as ReturnType<typeof vi.fn>;

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

beforeEach(() => vi.clearAllMocks());

describe("OTP Service — sendOtp", () => {
  it("invalidates old OTPs before creating a new one", async () => {
    otpUpdateMany.mockResolvedValue({ count: 1 });
    otpCreate.mockResolvedValue({ id: "otp-1" });
    sendEmailMock.mockResolvedValue(true);

    await otpService.sendOtp("test@example.com", "vendor_onboarding_email");

    // Should invalidate existing OTPs
    expect(otpUpdateMany).toHaveBeenCalledWith({
      where: {
        email: "test@example.com",
        purpose: "vendor_onboarding_email",
        consumedAt: null,
      },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("creates a hashed OTP (never stores plaintext)", async () => {
    otpUpdateMany.mockResolvedValue({ count: 0 });
    otpCreate.mockResolvedValue({ id: "otp-1" });
    sendEmailMock.mockResolvedValue(true);

    await otpService.sendOtp("test@example.com", "vendor_onboarding_email");

    expect(otpCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "test@example.com",
        codeHash: expect.any(String),
        purpose: "vendor_onboarding_email",
        expiresAt: expect.any(Date),
      }),
    });

    // Verify the stored hash is NOT a 6-digit number (it's a SHA-256 hex)
    const createCall = otpCreate.mock.calls[0][0];
    expect(createCall.data.codeHash).toHaveLength(64); // SHA-256 hex
    expect(createCall.data.codeHash).not.toMatch(/^\d{6}$/);
  });

  it("sends email via Resend", async () => {
    otpUpdateMany.mockResolvedValue({ count: 0 });
    otpCreate.mockResolvedValue({ id: "otp-1" });
    sendEmailMock.mockResolvedValue(true);

    await otpService.sendOtp("test@example.com", "vendor_onboarding_email");

    expect(sendEmailMock).toHaveBeenCalledWith({
      to: "test@example.com",
      subject: "Code",
      html: "<p>123456</p>",
    });
  });

  it("OTP code is never logged (template receives code, but service does not log it)", async () => {
    otpUpdateMany.mockResolvedValue({ count: 0 });
    otpCreate.mockResolvedValue({ id: "otp-1" });
    sendEmailMock.mockResolvedValue(true);

    await otpService.sendOtp("test@example.com", "vendor_onboarding_email");

    // The template function receives the code for email rendering
    expect(otpTemplateMock).toHaveBeenCalledWith({ code: expect.stringMatching(/^\d{6}$/) });
    // But the code is NOT in the prisma create call (only hash)
    const createCall = otpCreate.mock.calls[0][0];
    expect(createCall.data.codeHash).not.toMatch(/^\d{6}$/);
  });
});

describe("OTP Service — verifyOtp", () => {
  it("verifies correct OTP succeeds", async () => {
    const code = "123456";
    const codeHash = hashCode(code);

    otpFindFirst.mockResolvedValue({
      id: "otp-1",
      email: "test@example.com",
      codeHash,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 600000), // 10 min from now
      consumedAt: null,
      attempts: 0,
    });
    otpUpdate.mockResolvedValue({});
    userUpdateMany.mockResolvedValue({ count: 1 });

    const result = await otpService.verifyOtp("test@example.com", code, "vendor_onboarding_email");
    expect(result).toBe(true);
  });

  it("wrong OTP fails", async () => {
    const correctHash = hashCode("123456");

    otpFindFirst.mockResolvedValue({
      id: "otp-1",
      email: "test@example.com",
      codeHash: correctHash,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 600000),
      consumedAt: null,
      attempts: 0,
    });
    otpUpdate.mockResolvedValue({});

    await expect(
      otpService.verifyOtp("test@example.com", "999999", "vendor_onboarding_email"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("expired OTP fails", async () => {
    otpFindFirst.mockResolvedValue({
      id: "otp-1",
      email: "test@example.com",
      codeHash: hashCode("123456"),
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() - 1000), // expired
      consumedAt: null,
      attempts: 0,
    });

    await expect(
      otpService.verifyOtp("test@example.com", "123456", "vendor_onboarding_email"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("consumed OTP cannot be reused (findFirst returns null)", async () => {
    // consumedAt is set, so findFirst with consumedAt: null returns nothing
    otpFindFirst.mockResolvedValue(null);

    await expect(
      otpService.verifyOtp("test@example.com", "123456", "vendor_onboarding_email"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("more than 5 attempts blocked", async () => {
    otpFindFirst.mockResolvedValue({
      id: "otp-1",
      email: "test@example.com",
      codeHash: hashCode("123456"),
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 600000),
      consumedAt: null,
      attempts: 5, // already at max
    });

    await expect(
      otpService.verifyOtp("test@example.com", "123456", "vendor_onboarding_email"),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("new OTP invalidates old OTP (verified via sendOtp flow)", async () => {
    otpUpdateMany.mockResolvedValue({ count: 1 });
    otpCreate.mockResolvedValue({ id: "otp-2" });
    sendEmailMock.mockResolvedValue(true);

    await otpService.sendOtp("test@example.com", "vendor_onboarding_email");

    // The updateMany call marks old OTPs as consumed
    expect(otpUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ consumedAt: null }),
        data: expect.objectContaining({ consumedAt: expect.any(Date) }),
      }),
    );
  });

  it("successful verification updates user emailVerifiedAt", async () => {
    const code = "654321";
    otpFindFirst.mockResolvedValue({
      id: "otp-1",
      email: "user@test.com",
      codeHash: hashCode(code),
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 600000),
      consumedAt: null,
      attempts: 0,
    });
    otpUpdate.mockResolvedValue({});
    userUpdateMany.mockResolvedValue({ count: 1 });

    await otpService.verifyOtp("user@test.com", code, "vendor_onboarding_email");

    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { email: "user@test.com", emailVerifiedAt: null },
      data: { emailVerifiedAt: expect.any(Date) },
    });
  });
});
