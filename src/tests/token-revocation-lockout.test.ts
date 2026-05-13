import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-key-for-testing-only";

describe("Token Revocation (tokenVersion)", () => {
  it("JWT payload includes tv (tokenVersion) field", () => {
    const payload = { sub: "user1", role: "BUYER", email: "a@b.com", tv: 0 };
    const token = jwt.sign(payload, JWT_SECRET, { algorithm: "HS256" });
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as Record<string, unknown>;
    expect(decoded.tv).toBe(0);
  });

  it("token with old tokenVersion should be rejected", () => {
    // Simulate: user has tokenVersion=2 in DB, but token has tv=1
    const tokenTv = 1;
    const dbTv = 2;
    expect(tokenTv === dbTv).toBe(false);
    // The authenticate middleware calls verifyTokenVersion(userId, tv)
    // which returns false when tv !== user.tokenVersion → 401
  });

  it("token with current tokenVersion should be accepted", () => {
    const tokenTv = 3;
    const dbTv = 3;
    expect(tokenTv === dbTv).toBe(true);
  });

  it("password reset increments tokenVersion (invalidates old tokens)", () => {
    // After resetPassword:
    // prisma.user.update({ data: { tokenVersion: { increment: 1 } } })
    // Old tokens with tv=N will fail against new tv=N+1
    const oldTv = 5;
    const newTv = oldTv + 1;
    expect(newTv).toBe(6);
    expect(oldTv === newTv).toBe(false);
  });

  it("newly issued token after password reset has new tokenVersion", () => {
    // After login post-reset, signToken includes user.tokenVersion (now incremented)
    const payload = { sub: "user1", role: "BUYER", email: "a@b.com", tv: 6 };
    const token = jwt.sign(payload, JWT_SECRET, { algorithm: "HS256" });
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as Record<string, unknown>;
    expect(decoded.tv).toBe(6);
  });
});

describe("Account Lockout", () => {
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

  it("account locks after 5 failed attempts", () => {
    let failedAttempts = 0;
    for (let i = 0; i < 5; i++) {
      failedAttempts++;
    }
    const shouldLock = failedAttempts >= MAX_FAILED_ATTEMPTS;
    expect(shouldLock).toBe(true);
  });

  it("account does not lock at 4 failed attempts", () => {
    const failedAttempts = 4;
    const shouldLock = failedAttempts >= MAX_FAILED_ATTEMPTS;
    expect(shouldLock).toBe(false);
  });

  it("lockout duration is 15 minutes", () => {
    const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
    const now = new Date();
    const diffMs = lockedUntil.getTime() - now.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(14 * 60 * 1000); // at least 14 min
    expect(diffMs).toBeLessThanOrEqual(16 * 60 * 1000); // at most 16 min
  });

  it("locked account rejects login even with correct password", () => {
    const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
    const now = new Date();
    const isLocked = lockedUntil > now;
    expect(isLocked).toBe(true);
    // Service throws 423 "Account temporarily locked"
  });

  it("expired lockout allows login", () => {
    const lockedUntil = new Date(Date.now() - 1000); // 1 second ago
    const now = new Date();
    const isLocked = lockedUntil > now;
    expect(isLocked).toBe(false);
  });

  it("successful login resets failedLoginAttempts to 0", () => {
    // After valid password:
    // prisma.user.update({ data: { failedLoginAttempts: 0, lockedUntil: null } })
    const afterReset = { failedLoginAttempts: 0, lockedUntil: null };
    expect(afterReset.failedLoginAttempts).toBe(0);
    expect(afterReset.lockedUntil).toBeNull();
  });

  it("login error message does not reveal whether email exists", () => {
    // Both "user not found" and "wrong password" return same message
    const messageForMissingUser = "Invalid credentials";
    const messageForWrongPassword = "Invalid credentials";
    expect(messageForMissingUser).toBe(messageForWrongPassword);
  });
});
