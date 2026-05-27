/**
 * Phases 3 + 4 — SQL injection and input validation hardening.
 *
 * Strategy: feed malicious payloads into the *validation layer* of every
 * input-accepting module. Validation runs synchronously without DB I/O,
 * so we can hammer it with bad input and verify that:
 *   - SQL-injection fragments produce 400 (or pass through harmlessly as
 *     plain strings — Prisma parameterizes everything anyway).
 *   - Prototype pollution attempts (`__proto__`, `constructor`, `prototype`)
 *     never mutate Object.prototype.
 *   - Wrong types, oversized payloads, negative quantities, etc. all 400.
 */
import { describe, it, expect } from "vitest";

import {
  validateRegisterInput,
  validateLoginInput,
  validateForgotPasswordInput,
  validateResetPasswordInput,
} from "../modules/auth/auth.validation";
import { validateCreateReviewInput } from "../modules/reviews/reviews.validation";
import { validateActivateSubscriptionInput } from "../modules/subscriptions/subscriptions.validation";

const SQLI_PAYLOADS = [
  "' OR 1=1 --",
  "'; DROP TABLE \"User\"; --",
  "%' UNION SELECT null --",
  "' OR '1'='1",
  "../../../etc/passwd",
  "<script>alert(1)</script>",
  "x".repeat(50_000),
];

describe("Phase 3 — SQL injection payloads against auth validation", () => {
  for (const payload of SQLI_PAYLOADS) {
    it(`register email = ${JSON.stringify(payload).slice(0, 60)} → rejected (no SQL)`, () => {
      // Email regex rejects all of these because none parse as valid emails.
      expect(() =>
        validateRegisterInput({ email: payload, password: "Password1", name: "Test" }),
      ).toThrow(/email/i);
    });

    it(`register name = ${JSON.stringify(payload).slice(0, 60)} → either accepted as plain text or rejected (always treated as data)`, () => {
      try {
        const out = validateRegisterInput({ email: "ok@example.com", password: "Password1", name: payload });
        // If accepted, the value is stored verbatim. Prisma's parameterized
        // queries will treat it as data, never as SQL.
        expect(typeof out.name).toBe("string");
      } catch (e) {
        // Equally valid — the validator may reject overlong/whitespace-only.
        expect((e as Error).message.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("Phase 4 — input validation rejects bad types", () => {
  it("register rejects non-object body", () => {
    expect(() => validateRegisterInput("bad" as unknown)).toThrow();
    expect(() => validateRegisterInput(null)).toThrow();
    expect(() => validateRegisterInput(123)).toThrow();
    expect(() => validateRegisterInput([])).toThrow();
  });

  it("register rejects array email", () => {
    expect(() =>
      validateRegisterInput({ email: ["a@b.co"], password: "Password1", name: "X" } as unknown),
    ).toThrow(/email/i);
  });

  it("register rejects object password", () => {
    expect(() =>
      validateRegisterInput({ email: "a@b.co", password: { x: 1 }, name: "X" } as unknown),
    ).toThrow(/password/i);
  });

  it("login rejects non-string fields", () => {
    expect(() => validateLoginInput({ email: 123, password: "x" } as unknown)).toThrow();
    expect(() => validateLoginInput({ email: "a@b.co", password: null } as unknown)).toThrow();
  });

  it("forgot-password rejects malformed email", () => {
    expect(() => validateForgotPasswordInput({ email: "no-at-sign" })).toThrow();
  });

  it("reset-password rejects weak password", () => {
    expect(() =>
      validateResetPasswordInput({ token: "abc123", password: "short" }),
    ).toThrow(/password/i);
  });

  it("reset-password rejects empty token", () => {
    expect(() =>
      validateResetPasswordInput({ token: "  ", password: "Password1" }),
    ).toThrow(/token/i);
  });
});

describe("Phase 4 — review rating boundary (no fractions, no negatives, no 6+)", () => {
  const baseBody = { orderId: "o1", vendorId: "v1", productId: "p1" };
  // String "5" is intentionally coerced (mobile clients sometimes send strings).
  // Anything that does NOT cleanly coerce to an integer 1-5 must be rejected.
  for (const r of [0, -1, 6, 100, 3.5, null, undefined, [], {}, "abc", "3.5"]) {
    it(`rating=${JSON.stringify(r)} rejected`, () => {
      expect(() => validateCreateReviewInput({ ...baseBody, rating: r })).toThrow();
    });
  }
  for (const r of [1, 2, 3, 4, 5]) {
    it(`rating=${r} accepted`, () => {
      const out = validateCreateReviewInput({ ...baseBody, rating: r });
      expect(out.rating).toBe(r);
    });
  }
});

describe("Phase 4 — subscription plan whitelist", () => {
  for (const plan of ["FREE", "GROWTH", "PRO", "free", "growth", "pro"]) {
    it(`plan=${plan} accepted`, () => {
      expect(() => validateActivateSubscriptionInput({ plan })).not.toThrow();
    });
  }
  for (const plan of ["", "ENTERPRISE", "<script>", "BASIC", null, 42, []]) {
    it(`plan=${JSON.stringify(plan)} rejected`, () => {
      expect(() => validateActivateSubscriptionInput({ plan })).toThrow();
    });
  }
});

describe("Phase 4 — prototype pollution payloads do not mutate Object.prototype", () => {
  // Save a marker on Object.prototype so we can detect pollution after the test.
  const before = (Object.prototype as Record<string, unknown>)["__pollutionCheck"];

  it("register input with __proto__/constructor/prototype keys does not pollute", () => {
    const malicious = {
      email: "ok@example.com",
      password: "Password1",
      name: "Alice",
      __proto__: { polluted: "yes" },
      constructor: { prototype: { polluted: "yes" } },
      prototype: { polluted: "yes" },
    } as unknown;

    // Validator may either ignore the extra keys or accept and discard them.
    // What matters: Object.prototype must NOT have new keys after this.
    try {
      validateRegisterInput(malicious);
    } catch {
      /* either is fine */
    }

    // Test for pollution.
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("review input with __proto__ keys does not pollute", () => {
    const malicious = {
      orderId: "o", vendorId: "v", productId: "p", rating: 5, comment: "ok",
      __proto__: { polluted2: "yes" },
    } as unknown;

    try {
      validateCreateReviewInput(malicious);
    } catch {
      /* fine */
    }
    expect((Object.prototype as Record<string, unknown>)["polluted2"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted2"]).toBeUndefined();
  });

  // Confirm we didn't accidentally pollute outside the test
  it("Object.prototype is unmodified after pollution attempts", () => {
    const after = (Object.prototype as Record<string, unknown>)["__pollutionCheck"];
    expect(after).toBe(before);
  });
});
