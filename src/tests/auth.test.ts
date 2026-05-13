import { describe, it, expect } from "vitest";

import { validateRegisterInput, validateLoginInput, validateForgotPasswordInput, validateResetPasswordInput } from "../modules/auth/auth.validation";

describe("Auth Validation", () => {
  describe("validateRegisterInput", () => {
    it("accepts valid input", () => {
      const result = validateRegisterInput({
        email: "test@example.com",
        password: "password123",
        name: "Test User",
      });
      expect(result.email).toBe("test@example.com");
      expect(result.name).toBe("Test User");
    });

    it("rejects missing email", () => {
      expect(() => validateRegisterInput({ password: "12345678", name: "Test" }))
        .toThrow("Invalid email");
    });

    it("rejects short password", () => {
      expect(() => validateRegisterInput({ email: "a@b.com", password: "short", name: "Test" }))
        .toThrow("Password must be at least 8 characters");
    });

    it("rejects empty name", () => {
      expect(() => validateRegisterInput({ email: "a@b.com", password: "12345678", name: "" }))
        .toThrow("Invalid name");
    });

    it("normalizes email to lowercase", () => {
      const result = validateRegisterInput({
        email: "TEST@Example.COM",
        password: "password123",
        name: "Test",
      });
      expect(result.email).toBe("test@example.com");
    });
  });

  describe("validateLoginInput", () => {
    it("accepts valid input", () => {
      const result = validateLoginInput({ email: "test@example.com", password: "pass" });
      expect(result.email).toBe("test@example.com");
    });

    it("rejects missing fields", () => {
      expect(() => validateLoginInput({})).toThrow();
      expect(() => validateLoginInput({ email: "a@b.com" })).toThrow();
    });
  });

  describe("validateForgotPasswordInput", () => {
    it("accepts valid email", () => {
      const result = validateForgotPasswordInput({ email: "test@example.com" });
      expect(result.email).toBe("test@example.com");
    });

    it("rejects invalid email", () => {
      expect(() => validateForgotPasswordInput({ email: "notanemail" })).toThrow();
    });
  });

  describe("validateResetPasswordInput", () => {
    it("accepts valid input", () => {
      const result = validateResetPasswordInput({ token: "abc123", password: "newpass123" });
      expect(result.token).toBe("abc123");
    });

    it("rejects short password", () => {
      expect(() => validateResetPasswordInput({ token: "abc", password: "short" })).toThrow();
    });
  });
});
