import { describe, it, expect, vi } from "vitest";

// Regression test for the OAuth pass: making User.password nullable (for
// OAuth-only accounts) must not let bcrypt.compare receive null and crash
// — it must fail the same generic "Invalid credentials" as a wrong
// password, matching existing email-enumeration protection.
vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: "oauth-only-1",
        email: "oauthuser@gmail.com",
        password: null, // OAuth-only account, no Eki password ever set
        isSuspended: false,
        lockedUntil: null,
        failedLoginAttempts: 0,
        role: "BUYER",
        vendor: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { authService } from "../modules/auth/auth.service";

describe("existing auth regression — OAuth-only account vs password login", () => {
  it("an OAuth-only account (password: null) attempting email/password login gets a clean 401, not a crash", async () => {
    await expect(authService.login({ email: "oauthuser@gmail.com", password: "AnyPassword1" })).rejects.toMatchObject({ statusCode: 401 });
  });
});
