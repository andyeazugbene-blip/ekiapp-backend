import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticator } from "otplib";

// Mock prisma at the correct path relative to the controller
vi.mock("../lib/prisma", () => ({
  prisma: {
    adminTwoFactor: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from "../lib/prisma";
import type { Request, Response } from "express";

// Import controllers after mocks
import { setup2fa, verify2fa, disable2fa } from "../modules/admin/admin-2fa.controller";

const mockedPrisma = vi.mocked(prisma, true);

function createMockReq(body: Record<string, unknown> = {}, userId = "admin-1"): Request {
  return {
    user: { id: userId, role: "ADMIN", email: "admin@test.com" },
    body,
    headers: {},
  } as unknown as Request;
}

function createMockRes(): Response & { statusCode: number; data: unknown } {
  const res = {
    statusCode: 0,
    data: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.data = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; data: unknown };
}

describe("Admin 2FA Controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("setup2fa", () => {
    it("should generate a TOTP secret and otpauth URL", async () => {
      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(null);
      mockedPrisma.user.findUnique.mockResolvedValue({ email: "admin@test.com" } as never);
      mockedPrisma.adminTwoFactor.upsert.mockResolvedValue({} as never);

      const req = createMockReq();
      const res = createMockRes();

      await setup2fa(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect((res.data as Record<string, unknown>).secret).toBeDefined();
      expect((res.data as Record<string, unknown>).otpauthUrl).toContain("otpauth://totp/");
    });

    it("should reject if 2FA is already enabled", async () => {
      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue({
        enabled: true,
        secret: "existing",
      } as never);

      const req = createMockReq();
      const res = createMockRes();

      await expect(setup2fa(req, res as unknown as Response)).rejects.toThrow("already enabled");
    });
  });

  describe("verify2fa", () => {
    it("should enable 2FA with valid TOTP code", async () => {
      const secret = authenticator.generateSecret();
      const validCode = authenticator.generate(secret);

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue({
        id: "2fa-1",
        userId: "admin-1",
        secret,
        enabled: false,
        backupCodes: [],
      } as never);
      mockedPrisma.adminTwoFactor.update.mockResolvedValue({} as never);

      const req = createMockReq({ code: validCode });
      const res = createMockRes();

      await verify2fa(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect((res.data as Record<string, unknown>).backupCodes).toHaveLength(10);
      expect((res.data as Record<string, unknown>).message).toContain("enabled");
    });

    it("should reject invalid TOTP code", async () => {
      const secret = authenticator.generateSecret();

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue({
        id: "2fa-1",
        userId: "admin-1",
        secret,
        enabled: false,
        backupCodes: [],
      } as never);

      const req = createMockReq({ code: "000000" });
      const res = createMockRes();

      await expect(verify2fa(req, res as unknown as Response)).rejects.toThrow("Invalid TOTP");
    });

    it("should reject non-6-digit code", async () => {
      const req = createMockReq({ code: "12345" });
      const res = createMockRes();

      await expect(verify2fa(req, res as unknown as Response)).rejects.toThrow("6-digit");
    });
  });

  describe("disable2fa", () => {
    it("should disable 2FA with valid TOTP code", async () => {
      const secret = authenticator.generateSecret();
      const validCode = authenticator.generate(secret);

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue({
        id: "2fa-1",
        userId: "admin-1",
        secret,
        enabled: true,
        backupCodes: [],
      } as never);
      mockedPrisma.adminTwoFactor.update.mockResolvedValue({} as never);

      const req = createMockReq({ code: validCode });
      const res = createMockRes();

      await disable2fa(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect((res.data as Record<string, unknown>).message).toContain("disabled");
    });

    it("should reject if 2FA is not enabled", async () => {
      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(null);

      const req = createMockReq({ code: "123456" });
      const res = createMockRes();

      await expect(disable2fa(req, res as unknown as Response)).rejects.toThrow("not enabled");
    });
  });
});
