/**
 * Tests for admin 2FA backup codes:
 *   - generated and returned in plaintext only once at verify
 *   - stored as bcrypt hashes (never plaintext) in DB
 *   - work for disabling 2FA when TOTP unavailable
 *   - single-use (consumed on success)
 *   - reused backup code is rejected
 *   - require2fa middleware accepts a backup code as step-up auth
 *
 * Note: tests use bcrypt rounds=4 for speed (the production code uses 10).
 * The behaviour under test is independent of rounds — bcrypt.compare works
 * against any cost factor stored in the hash itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

const TEST_BCRYPT_ROUNDS = 4;

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
import type { Request, Response, NextFunction } from "express";

import { verify2fa, disable2fa } from "../modules/admin/admin-2fa.controller";
import { require2fa } from "../middlewares/require-2fa";

const mockedPrisma = vi.mocked(prisma, true);

function createMockReq(opts: { body?: Record<string, unknown>; headers?: Record<string, string>; userId?: string }): Request {
  return {
    user: { id: opts.userId ?? "admin-1", role: "ADMIN", email: "admin@test.com" },
    body: opts.body ?? {},
    headers: opts.headers ?? {},
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Admin 2FA Backup Codes", () => {
  describe("verify2fa: generation + storage", () => {
    it("returns 10 plaintext backup codes once", async () => {
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

      const req = createMockReq({ body: { code: validCode } });
      const res = createMockRes();

      await verify2fa(req, res as unknown as Response);

      const body = res.data as { backupCodes: string[]; warning: string };
      expect(body.backupCodes).toHaveLength(10);
      // Each is 8 hex chars
      for (const c of body.backupCodes) {
        expect(c).toMatch(/^[a-f0-9]{8}$/);
      }
      expect(body.warning).toContain("backup codes");
    });

    it("stores backup codes as bcrypt hashes, never plaintext", async () => {
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

      const req = createMockReq({ body: { code: validCode } });
      const res = createMockRes();

      await verify2fa(req, res as unknown as Response);

      const plaintextCodes = (res.data as { backupCodes: string[] }).backupCodes;
      const updateCall = mockedPrisma.adminTwoFactor.update.mock.calls[0][0] as {
        data: { backupCodes: string[] };
      };
      const storedCodes = updateCall.data.backupCodes;

      expect(storedCodes).toHaveLength(10);
      // None of the stored codes should equal the plaintext codes
      for (const stored of storedCodes) {
        expect(plaintextCodes).not.toContain(stored);
        // bcrypt format: $2a$ or $2b$ prefix, ~60 chars
        expect(stored).toMatch(/^\$2[aby]\$\d+\$.{53}$/);
      }

      // And every stored hash matches its corresponding plaintext code
      for (const plain of plaintextCodes) {
        const hasMatch = await Promise.all(storedCodes.map((h) => bcrypt.compare(plain, h)));
        expect(hasMatch.some(Boolean)).toBe(true);
      }
    }, 30_000);
  });

  describe("disable2fa: backup code as fallback", () => {
    async function makeRecord(plaintextCodes: string[]) {
      const secret = authenticator.generateSecret();
      const hashed = await Promise.all(plaintextCodes.map((c) => bcrypt.hash(c, TEST_BCRYPT_ROUNDS)));
      return {
        secret,
        record: {
          id: "2fa-1",
          userId: "admin-1",
          secret,
          enabled: true,
          backupCodes: hashed,
        },
      };
    }

    it("disables 2FA when a valid backup code is provided", async () => {
      const codes = ["aaaa1111", "bbbb2222", "cccc3333"];
      const { record } = await makeRecord(codes);

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(record as never);
      mockedPrisma.adminTwoFactor.update.mockResolvedValue({} as never);

      const req = createMockReq({ body: { code: "bbbb2222" } });
      const res = createMockRes();

      await disable2fa(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      // The "disable" final update sets enabled:false. Find that call.
      const finalUpdate = mockedPrisma.adminTwoFactor.update.mock.calls.find(
        (c) => (c[0] as { data: { enabled?: boolean } }).data?.enabled === false,
      );
      expect(finalUpdate).toBeDefined();
    });

    it("rejects an invalid backup code", async () => {
      const codes = ["aaaa1111"];
      const { record } = await makeRecord(codes);

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(record as never);

      const req = createMockReq({ body: { code: "wrong-code" } });
      const res = createMockRes();

      await expect(disable2fa(req, res as unknown as Response)).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });

  describe("require2fa middleware: backup code single-use", () => {
    async function setupRecord(plaintextCodes: string[]) {
      const secret = authenticator.generateSecret();
      const hashed = await Promise.all(plaintextCodes.map((c) => bcrypt.hash(c, TEST_BCRYPT_ROUNDS)));
      return {
        id: "2fa-1",
        userId: "admin-1",
        secret,
        enabled: true,
        backupCodes: hashed,
      };
    }

    it("accepts a backup code as step-up auth", async () => {
      const codes = ["dead0001", "dead0002"];
      const record = await setupRecord(codes);

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(record as never);
      mockedPrisma.adminTwoFactor.update.mockResolvedValue({} as never);

      const req = createMockReq({ headers: { "x-2fa-code": "dead0001" } });
      const next = vi.fn() as unknown as NextFunction;

      await require2fa(req, createMockRes() as unknown as Response, next);

      // next called with no error
      expect(next).toHaveBeenCalledTimes(1);
      expect((next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeUndefined();
    });

    it("consumes the backup code on use (single-use)", async () => {
      const codes = ["beef0001", "beef0002"];
      const record = await setupRecord(codes);

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(record as never);
      mockedPrisma.adminTwoFactor.update.mockResolvedValue({} as never);

      const req = createMockReq({ headers: { "x-2fa-code": "beef0001" } });
      const next = vi.fn() as unknown as NextFunction;

      await require2fa(req, createMockRes() as unknown as Response, next);

      // The middleware should have called update with backupCodes shrunk by 1
      const updateCall = mockedPrisma.adminTwoFactor.update.mock.calls.find(
        (c) => Array.isArray((c[0] as { data: { backupCodes?: string[] } }).data?.backupCodes),
      );
      expect(updateCall).toBeDefined();
      const stored = (updateCall![0] as { data: { backupCodes: string[] } }).data.backupCodes;
      expect(stored).toHaveLength(1);
    });

    it("rejects a reused backup code", async () => {
      // Simulate state AFTER the code was already consumed: only one code remains
      const stillValid = "feed0002";
      const consumed = "feed0001";
      const recordAfterFirstUse = await setupRecord([stillValid]); // "consumed" no longer in list

      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(recordAfterFirstUse as never);

      const req = createMockReq({ headers: { "x-2fa-code": consumed } });
      const next = vi.fn() as unknown as NextFunction;

      await require2fa(req, createMockRes() as unknown as Response, next);

      const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe("2FA_INVALID");
    });

    it("requires a code when 2FA is enabled (no header → 403 2FA_REQUIRED)", async () => {
      const record = await setupRecord(["abcd0001"]);
      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(record as never);

      const req = createMockReq({});
      const next = vi.fn() as unknown as NextFunction;

      await require2fa(req, createMockRes() as unknown as Response, next);

      const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe("2FA_REQUIRED");
    });

    it("passes through when 2FA not enabled", async () => {
      mockedPrisma.adminTwoFactor.findUnique.mockResolvedValue(null);

      const req = createMockReq({});
      const next = vi.fn() as unknown as NextFunction;

      await require2fa(req, createMockRes() as unknown as Response, next);

      expect(next).toHaveBeenCalledWith();
    });
  });
});
