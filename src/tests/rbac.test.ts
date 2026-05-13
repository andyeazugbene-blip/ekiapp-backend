import { describe, it, expect } from "vitest";

import { generateTestToken } from "./helpers";

describe("RBAC Token Generation", () => {
  it("generates valid buyer token", () => {
    const token = generateTestToken({ id: "user1", role: "BUYER", email: "buyer@test.com" });
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // JWT has 3 parts
  });

  it("generates valid vendor token", () => {
    const token = generateTestToken({ id: "user2", role: "VENDOR", email: "vendor@test.com" });
    expect(token).toBeTruthy();
  });

  it("generates valid admin token", () => {
    const token = generateTestToken({ id: "user3", role: "ADMIN", email: "admin@test.com" });
    expect(token).toBeTruthy();
  });
});
