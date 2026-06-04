import { describe, expect, it } from "vitest";

import { AppError } from "../../shared/errors/app-error";
import { validateLoginInput, validateRegisterInput } from "./auth.validation";

describe("validateRegisterInput", () => {
  it("normalizes email to lowercase and trims name", () => {
    const out = validateRegisterInput({
      email: "Alice@Example.COM",
      password: "Supersecret1",
      name: "  Alice  ",
    });
    expect(out).toEqual({
      email: "alice@example.com",
      password: "Supersecret1",
      name: "Alice",
      role: "BUYER",
    });
  });

  it("rejects non-object body", () => {
    expect(() => validateRegisterInput(null)).toThrow(AppError);
    expect(() => validateRegisterInput("bad")).toThrow(AppError);
  });

  it("rejects malformed email", () => {
    expect(() =>
      validateRegisterInput({ email: "not-an-email", password: "Supersecret1", name: "Alice" }),
    ).toThrow(/email/i);
  });

  it("rejects passwords shorter than 8 chars", () => {
    expect(() =>
      validateRegisterInput({ email: "a@b.co", password: "short", name: "Alice" }),
    ).toThrow(/password/i);
  });

  it("rejects empty name", () => {
    expect(() =>
      validateRegisterInput({ email: "a@b.co", password: "Supersecret1", name: "   " }),
    ).toThrow(/name/i);
  });

  it("accepts buyer or vendor role only", () => {
    const out = validateRegisterInput({
      email: "a@b.co",
      password: "Supersecret1",
      name: "Alice",
      role: "vendor",
    });
    expect(out.role).toBe("VENDOR");

    const adminAttempt = validateRegisterInput({
      email: "b@b.co",
      password: "Supersecret1",
      name: "Bob",
      role: "ADMIN",
    });
    expect(adminAttempt.role).toBe("BUYER");
  });
});

describe("validateLoginInput", () => {
  it("normalizes email and preserves password", () => {
    expect(validateLoginInput({ email: "  A@B.CO ", password: "pw" })).toEqual({
      email: "a@b.co",
      password: "pw",
    });
  });

  it("rejects missing email", () => {
    expect(() => validateLoginInput({ password: "pw" })).toThrow(AppError);
  });

  it("rejects missing password", () => {
    expect(() => validateLoginInput({ email: "a@b.co" })).toThrow(AppError);
  });
});
