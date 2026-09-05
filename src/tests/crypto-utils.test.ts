import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../shared/utils/crypto";

/**
 * Security-sweep finding: paystack.ts's webhook signature check and
 * internal.routes.ts's cron-secret check both used a plain === comparison
 * on secret values, which leaks how many leading bytes matched via
 * response-time differences (CWE-208). Both now use this shared
 * constant-time helper — these tests cover the correctness properties a
 * naive === would also satisfy (so a regression back to === wouldn't be
 * caught by these alone), but they do prove the replacement is actually
 * correct: equal strings match, different strings and different lengths
 * don't, and it never throws on mismatched input (timingSafeEqual throws
 * on mismatched buffer lengths if called directly without a length guard).
 */
describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("same-secret-value", "same-secret-value")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("secret-value-aaaa", "secret-value-bbbb")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(() => constantTimeEqual("short", "a-much-longer-value")).not.toThrow();
    expect(constantTimeEqual("short", "a-much-longer-value")).toBe(false);
  });

  it("returns false comparing against an empty string, and true for two empty strings", () => {
    expect(constantTimeEqual("", "non-empty")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("is case-sensitive — a differently-cased match is not a real match", () => {
    expect(constantTimeEqual("SecretValue", "secretvalue")).toBe(false);
  });
});
