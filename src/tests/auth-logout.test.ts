import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { update: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { authService } from "../modules/auth/auth.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("authService.logout — real server-side session revocation", () => {
  it("increments tokenVersion, invalidating every outstanding JWT for this user (the only revocation primitive this JWT-only architecture has)", async () => {
    m.user.update.mockResolvedValue({} as never);

    await authService.logout("user-1");

    expect(m.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tokenVersion: { increment: 1 } },
    });
  });
});
